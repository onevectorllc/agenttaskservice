// SPDX-License-Identifier: MIT
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.js";
import { redact } from "./token.js";

type Env = Record<string, string | undefined>;

/** The server could not be reached (network, timeout, 5xx). Safe to queue and retry. */
export class Unreachable extends Error {}

/** The server answered with a refusal (auth, validation, conflict). Retrying won't help. */
export class Refused extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export interface Conn {
  url: string;
  token: string;
  timeoutMs?: number;
}

export async function getJson(conn: Conn, path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      headers: { authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(conn.timeoutMs ?? 5000),
    });
  } catch (e) {
    throw new Unreachable(redact(e instanceof Error ? e.message : String(e), conn.token));
  }
  if (res.status >= 500) throw new Unreachable(`server error ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Refused(body.message ?? `HTTP ${res.status}`, body.error);
  return body;
}

function toolText(r: { content?: { type: string; text?: string }[] }): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

/**
 * Call one MCP tool and return its parsed JSON result.
 * Only transport failures (network, timeout, 5xx) become Unreachable: those are safe to queue.
 * Everything the server answered, including validation errors, is Refused.
 */
export async function callTool(conn: Conn, name: string, args: Record<string, unknown>): Promise<any> {
  const client = new Client({ name: "agenttaskservice-cli", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${conn.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${conn.token}` } },
  });
  let r: { content?: { type: string; text?: string }[]; isError?: boolean };
  try {
    await client.connect(transport, { timeout: conn.timeoutMs ?? 10_000 });
    r = (await client.callTool({ name, arguments: args }, undefined, { timeout: conn.timeoutMs ?? 10_000 })) as typeof r;
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e), conn.token);
    if (e instanceof McpError && e.code !== ErrorCode.RequestTimeout && e.code !== ErrorCode.ConnectionClosed) {
      throw new Refused(msg, "protocol");
    }
    const status = e instanceof StreamableHTTPError ? e.code : undefined;
    if (status === 401) throw new Refused("The server refused the token (401)", "unauthorized");
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new Refused(msg, "http");
    throw new Unreachable(msg);
  } finally {
    await client.close().catch(() => {});
  }
  const text = toolText(r);
  let value: any;
  try {
    value = JSON.parse(text || "{}");
  } catch {
    if (r.isError) throw new Refused(text || "tool error", "invalid");
    throw new Refused(`Unexpected reply from ${name}`, "invalid");
  }
  if (r.isError) throw new Refused(value.message ?? text, value.error);
  return value;
}

// ---- offline queue ----

export interface Queued {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  queued_at: string;
}

export function outboxPath(env: Env = process.env): string {
  return join(stateDir(env), "outbox.jsonl");
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Short exclusive lock around reads and rewrites of the queue file, so an append
 * never lands between a flush's read and its rename.
 */
function withQueueLock<T>(env: Env, fn: () => T): T {
  mkdirSync(stateDir(env), { recursive: true });
  const file = `${outboxPath(env)}.lock`;
  const until = Date.now() + 5000;
  for (;;) {
    try {
      closeSync(openSync(file, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A lock older than 30 s belongs to a crashed process.
      const st = statSync(file, { throwIfNoEntry: false });
      if (!st) continue; // released between our open and stat: try again now
      if (Date.now() - st.mtimeMs > 30_000) rmSync(file, { force: true });
      else if (Date.now() > until) throw new Error(`queue is locked (${file})`);
      else Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(file, { force: true });
  }
}

export function enqueue(tool: string, args: Record<string, unknown>, env: Env = process.env): Queued {
  const item: Queued = { id: randomUUID(), tool, args, queued_at: new Date().toISOString() };
  withQueueLock(env, () => appendFileSync(outboxPath(env), `${JSON.stringify(item)}\n`, { mode: 0o600 }));
  return item;
}

function parseQueue(f: string): Queued[] {
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Queued];
      } catch {
        return [];
      }
    });
}

export function readQueue(env: Env = process.env): Queued[] {
  return parseQueue(outboxPath(env));
}

/** Remove one item by id: re-reads the file under the lock, so items queued meanwhile are kept. */
function removeFromQueue(id: string, env: Env): void {
  withQueueLock(env, () => {
    const f = outboxPath(env);
    const rest = parseQueue(f).filter((i) => i.id !== id);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, rest.map((i) => `${JSON.stringify(i)}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, f);
  });
}

/**
 * Args marked `latest: true` take the task's current version at send time: "act on the task as it is now".
 * For a queued change (`queuedAt` set) that is only safe if nobody else changed the task since it was queued;
 * otherwise the change is refused, like any other version conflict.
 * `own` holds versions this flush itself produced, so a queued note followed by a queued complete still works.
 */
export async function withVersion(
  conn: Conn,
  args: Record<string, unknown>,
  queuedAt?: string,
  own?: Map<string, number>,
): Promise<Record<string, unknown>> {
  if (!args.latest) return args;
  const { latest: _drop, ...rest } = args;
  const { task } = await callTool(conn, "get_task", { task_id: rest.task_id });
  if (queuedAt) {
    const mine = own?.get(String(rest.task_id));
    const untouched = mine !== undefined ? task.version === mine : task.updated_at <= queuedAt;
    if (!untouched) {
      throw new Refused(`${rest.task_id} changed after this was queued (now ${task.status}, version ${task.version}); not applied`, "conflict");
    }
  }
  return { ...rest, version: task.version };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Create `file` holding our pid. If it exists, it is taken over only when its holder is gone:
 * the pid no longer runs, or (empty file, or another machine's pid) it has not been touched for `staleMs`.
 */
export function takeMarker(file: string, staleMs: number): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = statSync(file, { throwIfNoEntry: false });
      if (!st) continue;
      const pid = Number(readFileSync(file, "utf8").trim());
      const fresh = Date.now() - st.mtimeMs < staleMs;
      // Held while fresh and its holder runs (or its pid is not written yet). Past staleMs it is
      // stale even with a live pid, which may be a reused one; holders refresh the file to stay fresh.
      if (fresh && (pid > 0 ? pidAlive(pid) : true)) return false;
      // Remove only the file we judged: if another process replaced it meanwhile, leave theirs.
      const now = statSync(file, { throwIfNoEntry: false });
      if (now && now.ino === st.ino && now.mtimeMs === st.mtimeMs) rmSync(file, { force: true });
    }
  }
  return false;
}

function takeFlushMarker(file: string): boolean {
  return takeMarker(file, 120_000);
}

export interface FlushResult {
  sent: Queued[];
  dropped: { item: Queued; reason: string }[];
  remaining: number;
}

/**
 * Replay queued calls in order. Stops at the first unreachable error, or at `deadline` (ms since epoch),
 * and keeps the rest. A refused call (conflict, validation) is reported and dropped: retrying can't succeed.
 * Each item is removed from the file as soon as it is handled, and only one flush runs at a time.
 */
export async function flush(conn: Conn, env: Env = process.env, opts: { deadline?: number } = {}): Promise<FlushResult> {
  const result: FlushResult = { sent: [], dropped: [], remaining: 0 };
  mkdirSync(stateDir(env), { recursive: true });
  const running = `${outboxPath(env)}.flushing`;
  if (!takeFlushMarker(running)) {
    result.remaining = readQueue(env).length;
    return result; // another flush is running
  }
  try {
    const own = new Map<string, number>();
    for (const item of readQueue(env)) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      try {
        const r = await callTool(conn, item.tool, await withVersion(conn, item.args, item.queued_at, own));
        if (r?.task?.id) own.set(r.task.id, r.task.version);
        result.sent.push(item);
      } catch (e) {
        if (!(e instanceof Refused)) break;
        result.dropped.push({ item, reason: e.message });
      }
      removeFromQueue(item.id, env);
      utimesSync(running, new Date(), new Date()); // still alive: keeps the marker fresh
    }
  } finally {
    rmSync(running, { force: true });
  }
  result.remaining = readQueue(env).length;
  return result;
}
