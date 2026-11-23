// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { callTool, enqueue, flush, getJson, readQueue, Refused, Unreachable, withVersion, type Conn } from "./api.js";
import { loadClientConfig } from "./config.js";
import { detectProject } from "./project.js";
import { readToken } from "./token.js";

type Out = (s: string) => void;
type Env = Record<string, string | undefined>;

export const CLIENT_USAGE = `Client commands:
  init [--url U] [--token T] [--workspace-root D] [--rule] [--yes] [--dry-run]
                                Set up this machine: token, MCP server, session-start hook
  hook session-start            Print this project's tasks (for the Claude Code hook)
  auth-header                   Print the Authorization header as JSON (MCP headersHelper)
  task create --to P --title T [--body B] [--priority 1|2|3]
  task list [--sent] | task show <id> | task claim <id> [--session S]
  task note <id> <text> | task complete <id> --result R [--version N]
  task reject <id> --reason R [--version N]
  flush                         Send queued changes now
  whoami                        Show the server, project id and queue length
  (all task commands accept --project P; otherwise it is detected from the folder)
`;

function conn(env: Env, timeoutMs?: number): Conn | undefined {
  const cfg = loadClientConfig(env);
  const token = readToken(cfg.tokenStore, env);
  if (!cfg.url || !token) return undefined;
  return { url: cfg.url, token, timeoutMs };
}

function project(cwd: string, given: string | undefined, env: Env): string {
  if (given) return given;
  return detectProject(cwd, { workspaceRoot: loadClientConfig(env).workspaceRoot, env }).id;
}

const PRIORITY = ["", "high", "normal", "low"];

function line(t: any): string {
  const title = String(t.title).length > 90 ? `${String(t.title).slice(0, 87)}...` : t.title;
  return `- ${t.id} [${PRIORITY[t.priority] ?? t.priority}] ${title} (from ${t.from_project}, ${t.status}${t.claimed_by ? ` by ${t.claimed_by}` : ""})`;
}

/** Text for the session's context. Never throws: a hook must not break a session. */
export async function sessionStart(cwd: string, env: Env = process.env): Promise<string> {
  const c = conn(env, 2000);
  if (!c) return "agenttaskservice: not set up on this machine (run `agenttaskservice init`).";
  const id = project(cwd, undefined, env);
  let data: any;
  try {
    data = await getJson(c, `/v1/inbox?project=${encodeURIComponent(id)}`);
  } catch (e) {
    const why = e instanceof Refused ? e.message : "server unreachable";
    const queued = readQueue(env).length;
    return `agenttaskservice: ${why}; tasks for ${id} not checked.${queued ? ` ${queued} change(s) queued.` : ""}`;
  }
  let flushed = "";
  if (readQueue(env).length) {
    const r = await flush(c, env).catch(() => undefined);
    if (r && (r.sent.length || r.dropped.length)) {
      flushed = `\nSent ${r.sent.length} queued change(s).${r.dropped.length ? ` Dropped ${r.dropped.length}: ${r.dropped.map((d) => `${d.item.tool} ${String(d.item.args.task_id ?? d.item.args.title ?? "")}: ${d.reason}`).join("; ")}` : ""}`;
    }
  }
  const tasks: any[] = data.tasks ?? [];
  const done: any[] = data.completed ?? [];
  const parts = [`agenttaskservice: project id "${id}".`];
  if (!tasks.length) parts.push("No open tasks for this project.");
  else {
    parts.push(`Open tasks for this project (${tasks.length}):`);
    parts.push(...tasks.slice(0, 10).map(line));
    if (tasks.length > 10) parts.push(`...and ${tasks.length - 10} more (list_my_tasks).`);
  }
  if (done.length) {
    parts.push(`Tasks this project sent that finished since the last check (${done.length}):`);
    parts.push(
      ...done.slice(0, 10).map((t) => `- ${t.id} ${t.status} by ${t.to_project}: ${String(t.result ?? "").split("\n")[0].slice(0, 120)}`),
    );
  }
  if (tasks.length) parts.push("Tell the user about these before other work. Claim a task before working on it.");
  return parts.join("\n") + flushed;
}

/** Read the hook's stdin JSON (it carries `cwd`), without waiting long. */
export async function hookCwd(env: Env = process.env): Promise<string> {
  if (!process.stdin.isTTY) {
    const text = await new Promise<string>((resolve) => {
      let data = "";
      const done = () => {
        process.stdin.removeAllListeners("data");
        process.stdin.pause();
        resolve(data);
      };
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", done);
      setTimeout(done, 300).unref();
    });
    try {
      const j = JSON.parse(text);
      if (typeof j.cwd === "string") return j.cwd;
    } catch {
      // not JSON: fall through
    }
  }
  return env.CLAUDE_PROJECT_DIR || process.cwd();
}

async function write(c: Conn | undefined, tool: string, args: Record<string, unknown>, out: Out, env: Env): Promise<number> {
  if (c) {
    try {
      const r = await callTool(c, tool, await withVersion(c, args));
      out(JSON.stringify(r.task ?? r, null, 2));
      return 0;
    } catch (e) {
      if (e instanceof Refused) {
        out(`error: ${e.message}`);
        return 1;
      }
    }
  }
  enqueue(tool, args, env);
  out(`Server unreachable: queued ${tool}. It is sent by \`agenttaskservice flush\` or the next session start.`);
  return 0;
}

export async function runClient(argv: string[], out: Out = console.log, env: Env = process.env, cwd = process.cwd()): Promise<number | undefined> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      project: { type: "string" },
      to: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      priority: { type: "string" },
      session: { type: "string" },
      result: { type: "string" },
      reason: { type: "string" },
      version: { type: "string" },
      sent: { type: "boolean" },
    },
  });
  const [cmd, sub, a1, ...rest] = positionals;
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);

  if (cmd === "hook" && sub === "session-start") {
    try {
      out(await sessionStart(await hookCwd(env), env));
    } catch (e) {
      out(`agenttaskservice: hook failed (${e instanceof Error ? e.message : e}); tasks not checked.`);
    }
    return 0;
  }

  if (cmd === "auth-header") {
    const cfg = loadClientConfig(env);
    const token = readToken(cfg.tokenStore, env);
    if (!token) {
      console.error("agenttaskservice: no token stored; run `agenttaskservice init`.");
      return 1;
    }
    out(JSON.stringify({ Authorization: `Bearer ${token}` }));
    return 0;
  }

  if (cmd === "whoami") {
    const cfg = loadClientConfig(env);
    const guess = detectProject(cwd, { workspaceRoot: cfg.workspaceRoot, env });
    out(`server: ${cfg.url ?? "(not set)"}`);
    out(`token: ${readToken(cfg.tokenStore, env) ? `stored (${cfg.tokenStore})` : "missing"}`);
    out(`project: ${guess.id} (from ${guess.source})`);
    out(`queued changes: ${readQueue(env).length}`);
    return 0;
  }

  if (cmd === "flush") {
    const c = conn(env);
    if (!c) {
      out("error: not set up (run `agenttaskservice init`)");
      return 1;
    }
    const r = await flush(c, env);
    out(`sent ${r.sent.length}, dropped ${r.dropped.length}, still queued ${r.remaining}`);
    for (const d of r.dropped) out(`  dropped ${d.item.tool}: ${d.reason}`);
    return r.remaining ? 1 : 0;
  }

  if (cmd !== "task") return undefined;
  const c = conn(env);
  const p = project(cwd, str("project"), env);
  const version = str("version") ? Number(str("version")) : undefined;
  const versioned = (args: Record<string, unknown>) => (version ? { ...args, version } : { ...args, latest: true });

  switch (sub) {
    case "create": {
      if (!str("to") || !str("title")) {
        out("error: task create needs --to and --title");
        return 1;
      }
      return write(
        c,
        "create_task",
        {
          project: p,
          to_project: str("to"),
          title: str("title"),
          body: str("body") === "-" ? readFileSync(0, "utf8") : str("body"),
          priority: str("priority") ? Number(str("priority")) : undefined,
          client_key: randomUUID(),
        },
        out,
        env,
      );
    }
    case "note":
      if (!a1 || !rest.length) {
        out("error: task note <id> <text>");
        return 1;
      }
      return write(c, "add_note", { task_id: a1, text: rest.join(" "), session: str("session") }, out, env);
    case "complete":
      if (!a1 || !str("result")) {
        out("error: task complete <id> --result R");
        return 1;
      }
      return write(c, "complete_task", versioned({ project: p, task_id: a1, result: str("result"), session: str("session") }), out, env);
    case "reject":
      if (!a1 || !str("reason")) {
        out("error: task reject <id> --reason R");
        return 1;
      }
      return write(c, "reject_task", versioned({ project: p, task_id: a1, reason: str("reason"), session: str("session") }), out, env);
    case "list":
    case "show":
    case "claim": {
      if (!c) {
        out("error: not set up (run `agenttaskservice init`)");
        return 1;
      }
      try {
        if (sub === "list") {
          const r = await callTool(c, values.sent ? "list_sent_tasks" : "list_my_tasks", { project: p });
          out(r.tasks.length ? r.tasks.map(line).join("\n") : `No tasks (${values.sent ? "sent by" : "for"} ${p}).`);
        } else if (sub === "show") {
          out(JSON.stringify(await callTool(c, "get_task", { task_id: a1 }), null, 2));
        } else {
          const args = await withVersion(c, versioned({ project: p, task_id: a1, session: str("session") }));
          out(JSON.stringify((await callTool(c, "claim_task", args)).task, null, 2));
        }
        return 0;
      } catch (e) {
        out(`error: ${e instanceof Unreachable ? "server unreachable" : (e as Error).message}`);
        return 1;
      }
    }
    default:
      out(CLIENT_USAGE);
      return 1;
  }
}
