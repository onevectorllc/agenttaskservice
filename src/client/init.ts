// SPDX-License-Identifier: MIT
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { callTool, getJson, Refused } from "./api.js";
import { clientConfigPath, expandHome, loadClientConfig, saveClientConfig, type ClientConfig } from "./config.js";
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

export function claudeDir(env: Env = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** How Claude Code should run this CLI: the bare name when it is on PATH, otherwise node + this file. */
export function selfCommand(env: Env = process.env): string {
  const onPath = spawnSync("sh", ["-c", "command -v agenttaskservice"], { stdio: "ignore", env: env as NodeJS.ProcessEnv }).status === 0;
  if (onPath) return "agenttaskservice";
  const script = realpathSync(process.argv[1] ?? "");
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
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
  const ours = (h: { command?: string }) => /agenttaskservice\b.*hook session-start|hook session-start.*agenttaskservice/.test(h.command ?? "");
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

function writeAtomic(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.agenttaskservice.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

function hasClaude(env: Env): boolean {
  return spawnSync("sh", ["-c", "command -v claude"], { stdio: "ignore", env: env as NodeJS.ProcessEnv }).status === 0;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
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
  if (!/^https?:\/\//.test(url)) {
    out("error: the URL must start with https:// (or http:// for a local server)");
    return 1;
  }

  const store = env.AGENTTASK_TOKEN_STORE || existsSync(clientConfigPath(env)) ? current.tokenStore : defaultTokenStore();
  let token = values.token ?? env.AGENTTASK_TOKEN ?? readToken(store, env);
  if (!token && interactive) token = await ask("Token (from `agenttaskservice token add <name>` on the server): ");
  if (!token) {
    out("error: give the token with --token or AGENTTASK_TOKEN");
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

  const cfg: ClientConfig = {
    url,
    tokenStore: store,
    workspaceRoot: values["workspace-root"] ? expandHome(values["workspace-root"]) : current.workspaceRoot,
  };
  const self = selfCommand(env);
  const steps: Step[] = [];

  if (readToken(store, { ...env, AGENTTASK_TOKEN: undefined }) !== token) {
    steps.push({ what: `Store the token in ${store === "file" ? "a file readable only by you" : `the ${store} store`}`, apply: () => writeToken(store, token!, env) });
  }
  steps.push({ what: `Write ${clientConfigPath(env)} (server URL${cfg.workspaceRoot ? ", workspace root" : ""}; no token)`, apply: () => void saveClientConfig(cfg, env) });

  const mcpJson = JSON.stringify({ type: "http", url: `${url}/mcp`, headersHelper: `${self} auth-header` });
  const mcpArgs = ["mcp", "add-json", MCP_NAME, mcpJson, "--scope", "user"];
  const claude = hasClaude(env);
  if (claude) {
    steps.push({
      what: `Register the MCP server "${MCP_NAME}" with Claude Code (user scope)`,
      apply: () => {
        spawnSync("claude", ["mcp", "remove", MCP_NAME, "--scope", "user"], { stdio: "ignore", env: env as NodeJS.ProcessEnv });
        execFileSync("claude", mcpArgs, { stdio: ["ignore", "ignore", "pipe"], env: env as NodeJS.ProcessEnv });
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
