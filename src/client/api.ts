// SPDX-License-Identifier: MIT
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.js";

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

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const text = `${e.name} ${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ""}`;
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|EAI_AGAIN|abort|timeout|socket/i.test(text);
}

export async function getJson(conn: Conn, path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      headers: { authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(conn.timeoutMs ?? 5000),
    });
  } catch (e) {
    throw new Unreachable(e instanceof Error ? e.message : String(e));
  }
  if (res.status >= 500) throw new Unreachable(`server error ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Refused(body.message ?? `HTTP ${res.status}`, body.error);
  return body;
}

/** Call one MCP tool. Returns the tool's parsed JSON result. */
export async function callTool(conn: Conn, name: string, args: Record<string, unknown>): Promise<any> {
  const client = new Client({ name: "agenttaskservice-cli", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${conn.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${conn.token}` } },
  });
  try {
    await client.connect(transport, { timeout: conn.timeoutMs ?? 10_000 });
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: conn.timeoutMs ?? 10_000 })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const value = JSON.parse(r.content[0]?.text ?? "{}");
    if (r.isError) throw new Refused(value.message ?? "tool error", value.error);
    return value;
  } catch (e) {
    if (e instanceof Refused) throw e;
    if (isNetworkError(e)) throw new Unreachable(e instanceof Error ? e.message : String(e));
    const msg = e instanceof Error ? e.message : String(e);
    if (/401|unauthorized/i.test(msg)) throw new Refused("The server refused the token (401)", "unauthorized");
    throw new Unreachable(msg);
  } finally {
    await client.close().catch(() => {});
  }
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

export function enqueue(tool: string, args: Record<string, unknown>, env: Env = process.env): Queued {
  const item: Queued = { id: randomUUID(), tool, args, queued_at: new Date().toISOString() };
  mkdirSync(stateDir(env), { recursive: true });
  appendFileSync(outboxPath(env), `${JSON.stringify(item)}\n`, { mode: 0o600 });
  return item;
}

export function readQueue(env: Env = process.env): Queued[] {
  const f = outboxPath(env);
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

function writeQueue(items: Queued[], env: Env): void {
  const f = outboxPath(env);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, items.map((i) => `${JSON.stringify(i)}\n`).join(""), { mode: 0o600 });
  renameSync(tmp, f);
}

/**
 * Args marked `latest: true` take the task's current version at send time.
 * Used for CLI commands where the user gave no version: "finish this task as it is now".
 */
export async function withVersion(conn: Conn, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!args.latest) return args;
  const { latest: _drop, ...rest } = args;
  const cur = await callTool(conn, "get_task", { task_id: rest.task_id });
  return { ...rest, version: cur.task.version };
}

export interface FlushResult {
  sent: Queued[];
  dropped: { item: Queued; reason: string }[];
  remaining: number;
}

/**
 * Replay queued calls in order. Stops at the first unreachable error and keeps the rest.
 * A refused call (conflict, validation) is reported and dropped: retrying it can't succeed.
 */
export async function flush(conn: Conn, env: Env = process.env): Promise<FlushResult> {
  const items = readQueue(env);
  const result: FlushResult = { sent: [], dropped: [], remaining: 0 };
  let i = 0;
  for (; i < items.length; i++) {
    try {
      await callTool(conn, items[i].tool, await withVersion(conn, items[i].args));
      result.sent.push(items[i]);
    } catch (e) {
      if (e instanceof Refused) {
        result.dropped.push({ item: items[i], reason: e.message });
        continue;
      }
      break;
    }
  }
  const rest = items.slice(i);
  result.remaining = rest.length;
  if (items.length) writeQueue(rest, env);
  return result;
}
