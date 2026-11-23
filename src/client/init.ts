// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { platform } from "node:os";
import { PROJECT_ID } from "../store.js";
import { scheduleSteps } from "./schedule.js";
import { workDirProblem } from "./work.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { callTool, getJson, Refused } from "./api.js";
import { clientConfigPath, expandHome, loadClientConfig, saveClientConfig, urlProblem, type ClientConfig } from "./config.js";
import { defaultTokenStore, readToken, writeToken } from "./token.js";

type Out = (s: string) => void;
type Env = Record<string, string | undefined>;

export const MCP_NAME = "agenttaskservice";
export const HOOK_MATCHER = "startup|resume|clear|compact";
const RULE_START = "<!-- agenttaskservice:start -->";
const RULE_END = "<!-- agenttaskservice:end -->";

export const TASK_RULE = `${RULE_START}
## Cross-project tasks (agenttaskservice)
- At session start a hook lists this project's open tasks. Tell the user about them before other work.
- To hand work to another project, use the agenttaskservice MCP tool \`create_task\` (or \`agenttaskservice task create --to <project> --title ...\`).
- Claim a task before working on it, add notes as you go, and finish with \`complete_task\` (a short result) or \`reject_task\` (the reason).
- If the MCP tools are unreachable, use the \`agenttaskservice task ...\` commands: they queue changes and send them later.
- Never put secrets in a task.
${RULE_END}`;

/** Non-secret settings the scheduled job needs to find the same config, token store and state as this shell. */
export function jobEnv(env: Env): Record<string, string> {
  const keep = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "AGENTTASK_CLIENT_CONFIG", "AGENTTASK_TOKEN_STORE"];
  return Object.fromEntries(keep.filter((k) => env[k]).map((k) => [k, env[k]!]));
}

export function claudeDir(env: Env = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** How to run this CLI later: the bare name when it is on PATH, otherwise node + this file. */
export function selfArgv(env: Env = process.env): string[] {
  // Absolute path: launchd and systemd don't search the job's PATH for the program itself.
  const r = spawnSync("sh", ["-c", "command -v agenttaskservice"], { stdio: ["ignore", "pipe", "ignore"], env: env as NodeJS.ProcessEnv });
  const found = r.status === 0 ? String(r.stdout).trim() : "";
  if (found.startsWith("/")) return [found];
  return [process.execPath, realpathSync(process.argv[1] ?? "")];
}

/** POSIX shell quoting: only quote what needs it, with single quotes. */
export function shellQuote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function selfCommand(env: Env = process.env): string {
  return selfArgv(env).map(shellQuote).join(" ");
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

/** Add our SessionStart hook to a settings object. Keeps every other hook; replaces only our own. */
export function mergeHook(settings: Record<string, any>, command: string): { settings: Record<string, any>; changed: boolean } {
  const next = structuredClone(settings);
  next.hooks ??= {};
  const list: HookEntry[] = Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : [];
  const ours = (h: { command?: string }) => /\bhook session-start$/.test(h.command ?? "") && /agenttaskservice|cli\.js/.test(h.command ?? "");
  const want = { type: "command", command: `${command} hook session-start`, timeout: 10 };
  const existing = list.find((e) => e.hooks?.some(ours));
  if (existing) {
    const h = existing.hooks!.find(ours)!;
    if (existing.matcher === HOOK_MATCHER && h.command === want.command && h.timeout === want.timeout && h.type === want.type) {
      return { settings, changed: false };
    }
    existing.matcher = HOOK_MATCHER;
    Object.assign(h, want);
  } else {
    list.push({ matcher: HOOK_MATCHER, hooks: [want] });
  }
  next.hooks.SessionStart = list;
  return { settings: next, changed: true };
}

/** Insert or replace our rule block in a CLAUDE.md text. */
export function mergeRule(text: string): { text: string; changed: boolean } {
  const start = text.indexOf(RULE_START);
  const end = text.indexOf(RULE_END);
  let next: string;
  if (start >= 0 && end > start) next = text.slice(0, start) + TASK_RULE + text.slice(end + RULE_END.length);
  else next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${TASK_RULE}\n`;
  return { text: next, changed: next !== text };
}

/** Write via a temp file and rename. Follows a symlink (e.g. a dotfiles repo) instead of replacing it. */
function writeAtomic(path: string, body: string): void {
  const file = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.agenttaskservice.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function hasClaude(env: Env): boolean {
  return spawnSync("sh", ["-c", "command -v claude"], { stdio: "ignore", env: env as NodeJS.ProcessEnv }).status === 0;
}

async function ask(question: string, hidden = false): Promise<string> {
  process.stderr.write(question);
  // When hidden, nothing typed is echoed: readline writes to a sink instead of the terminal.
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: hidden ? sink : process.stderr, terminal: hidden });
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    if (hidden) process.stderr.write("\n");
  }
}

interface Step {
  what: string;
  apply: () => void;
}

export async function runInit(argv: string[], out: Out = console.log, env: Env = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      "workspace-root": { type: "string" },
      watch: { type: "string", multiple: true },
      insecure: { type: "boolean" },
      work: { type: "string" },
      every: { type: "string" },
      "work-dir": { type: "string" },
      "work-prompt": { type: "string" },
      rule: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
    },
  });
  const interactive = !values.yes && !values["dry-run"] && process.stdin.isTTY;
  const current = loadClientConfig(env);

  let url = values.url ?? current.url;
  if (!url && interactive) url = await ask("Server URL (for example https://tasks.example.com): ");
  if (!url) {
    out("error: give the server URL with --url");
    return 1;
  }
  url = url.replace(/\/+$/, "");
  const allowInsecureHttp = values.insecure ?? current.allowInsecureHttp;
  const problem = urlProblem(url, allowInsecureHttp);
  if (problem) {
    out(`error: ${problem}`);
    return 1;
  }
  for (const id of [...(values.watch ?? []), ...(values.work ? [values.work] : [])]) {
    if (!PROJECT_ID.test(id)) {
      out(`error: "${id}" is not a valid project id`);
      return 1;
    }
  }
  const every = values.every === undefined ? 60 : Number(values.every);
  if (!Number.isFinite(every) || every < 0 || (every > 0 && every < 5) || every > 10_080) {
    out("error: --every is minutes between runs: 0 to remove the job, otherwise 5 to 10080");
    return 1;
  }

  const store = env.AGENTTASK_TOKEN_STORE || existsSync(clientConfigPath(env)) ? current.tokenStore : defaultTokenStore();
  let token = values.token ?? env.AGENTTASK_TOKEN ?? readToken(store, env);
  if (!token && interactive) token = await ask("Token (from `agenttaskservice token add <name>` on the server; not shown): ", true);
  if (!token) {
    out("error: give the token in AGENTTASK_TOKEN (or --token, which your shell history keeps)");
    return 1;
  }

  try {
    const health = await getJson({ url, token, timeoutMs: 5000 }, "/health");
    if (health.status !== "ok") throw new Error("unexpected /health reply");
    await callTool({ url, token, timeoutMs: 5000 }, "list_projects", {});
  } catch (e) {
    out(`error: ${e instanceof Refused ? `the server refused the token (${e.message})` : `cannot reach ${url} (${(e as Error).message})`}`);
    return 1;
  }
  out(`Server ${url} is reachable and accepts the token.`);

  const watch = [...new Set([...current.watch, ...(values.watch ?? []), ...(values.work && every > 0 ? [values.work] : [])])];
  const cfg: ClientConfig = {
    url,
    tokenStore: store,
    workspaceRoot: values["workspace-root"] ? expandHome(values["workspace-root"]) : current.workspaceRoot,
    watch,
    allowInsecureHttp,
  };
  const argvSelf = selfArgv(env);
  const self = argvSelf.map(shellQuote).join(" ");
  if (argvSelf.some((a) => a.includes(`${sep}_npx${sep}`))) {
    out("warning: running from the npx cache, which can be cleaned up later. Install it first: npm install -g agenttaskservice");
  }
  const steps: Step[] = [];

  if (readToken(store, { ...env, AGENTTASK_TOKEN: undefined }) !== token) {
    steps.push({ what: `Store the token in ${store === "file" ? "a file readable only by you" : `the ${store} store`}`, apply: () => writeToken(store, token!, env) });
  }
  if (JSON.stringify(cfg) !== JSON.stringify({ ...current, url: current.url, tokenStore: store }) || !existsSync(clientConfigPath(env))) {
    steps.push({ what: `Write ${clientConfigPath(env)} (server URL${cfg.workspaceRoot ? ", workspace root" : ""}${watch.length ? `, watched inboxes ${watch.join(", ")}` : ""}; no token)`, apply: () => void saveClientConfig(cfg, env) });
  }

  const mcpJson = JSON.stringify({ type: "http", url: `${url}/mcp`, headersHelper: `${self} auth-header` });
  const mcpArgs = ["mcp", "add-json", MCP_NAME, mcpJson, "--scope", "user"];
  const claude = hasClaude(env);
  const run = (args: string[]) => spawnSync("claude", args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  const registered = claude ? run(["mcp", "get", MCP_NAME]) : undefined;
  const current_mcp = registered?.status === 0 ? `${registered.stdout}` : "";
  if (claude && !(current_mcp.includes(`${url}/mcp`) && current_mcp.includes(`${self} auth-header`))) {
    steps.push({
      what: `${current_mcp ? "Update" : "Register"} the MCP server "${MCP_NAME}" with Claude Code (user scope)`,
      apply: () => {
        // Add first; replace an existing entry only if the add was refused, so a failure never leaves none.
        if (run(mcpArgs).status === 0) return;
        run(["mcp", "remove", MCP_NAME, "--scope", "user"]);
        const r = run(mcpArgs);
        if (r.status !== 0) throw new Error(`claude mcp add-json failed: ${String(r.stderr).trim().split("\n")[0]}`);
      },
    });
  }

  const settingsFile = join(claudeDir(env), "settings.json");
  let settings: Record<string, any> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    } catch {
      out(`error: ${settingsFile} is not valid JSON; fix it and run init again`);
      return 1;
    }
  }
  const merged = mergeHook(settings, self);
  if (merged.changed) {
    steps.push({ what: `Add the SessionStart hook to ${settingsFile} (other hooks are kept)`, apply: () => writeAtomic(settingsFile, `${JSON.stringify(merged.settings, null, 2)}\n`) });
  }

  const ruleFile = join(claudeDir(env), "CLAUDE.md");
  if (values.rule) {
    const r = mergeRule(existsSync(ruleFile) ? readFileSync(ruleFile, "utf8") : "");
    if (r.changed) steps.push({ what: `Add the task rule to ${ruleFile}`, apply: () => writeAtomic(ruleFile, r.text) });
  }

  if (values.work) {
    const bad = workDirProblem(expandHome(values["work-dir"] ?? process.cwd()), env);
    if (bad && every > 0) {
      out(`error: ${bad}`);
      return 1;
    }
    try {
      steps.push(
        ...scheduleSteps(
          {
            inbox: values.work,
            every,
            dir: resolve(expandHome(values["work-dir"] ?? process.cwd())),
            promptFile: values["work-prompt"] ? resolve(expandHome(values["work-prompt"])) : undefined,
            self: argvSelf,
            path: env.PATH ?? "/usr/bin:/bin",
            env: jobEnv(env),
          },
          (env.AGENTTASK_PLATFORM as NodeJS.Platform) || platform(),
          env,
        ),
      );
    } catch (e) {
      out(`error: ${(e as Error).message}`);
      return 1;
    }
  }

  out(values["dry-run"] ? "Would make these changes (dry run, nothing written):" : "Changes:");
  for (const s of steps) out(`  - ${s.what}`);
  if (!steps.length) out("  (nothing to change)");

  if (values["dry-run"]) {
    if (!claude) out(`\nClaude Code's \`claude\` command was not found. Register the server yourself:\n  claude ${mcpArgs.slice(0, 3).join(" ")} '${mcpJson}' --scope user`);
    return 0;
  }
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      out("error: run with --yes to apply without a prompt, or --dry-run to only list the changes");
      return 1;
    }
    const a = await ask("Apply these changes? [y/N] ");
    if (!/^y(es)?$/i.test(a)) {
      out("Nothing changed.");
      return 1;
    }
  }
  for (const s of steps) {
    try {
      s.apply();
    } catch (e) {
      out(`error: ${s.what} failed: ${(e as Error).message}`);
      return 1;
    }
  }
  out("Done.");
  if (!claude) out(`\nClaude Code's \`claude\` command was not found. Register the server yourself:\n  claude ${mcpArgs.slice(0, 3).join(" ")} '${mcpJson}' --scope user`);
  if (!values.rule) out(`\nAdd this to your CLAUDE.md (or run init again with --rule to add it to ${ruleFile}):\n\n${TASK_RULE}`);
  out("\nStart a new Claude Code session to see this project's tasks.");
  return 0;
}
