// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, enqueue, flush, readQueue } from "../src/client/api.js";
import { runClient, sessionStart } from "../src/client/commands.js";
import { clientConfigPath, loadClientConfig, saveClientConfig } from "../src/client/config.js";
import { mergeHook, mergeRule, runInit, TASK_RULE } from "../src/client/init.js";
import { detectProject, normaliseProjectId, repoNameFromRemote } from "../src/client/project.js";
import { readToken, tokenFile, writeToken } from "../src/client/token.js";
import { openDb } from "../src/db.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";

let server: Server;
let base: string;
let store: Store;
let token: string;
const DOWN = "http://127.0.0.1:1";

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  token = store.addToken("client-test");
  for (const id of ["hook-b", "hook-c", "q-b", "q-d", "cli-b"]) store.upsertProject({ id });
  server = startServer(store, { host: "127.0.0.1", port: 0, dataDir: "", leaseHours: 4, maxBodyBytes: 100_000 }) as Server;
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

type Env = Record<string, string | undefined>;
let env: Env;
let home: string;

/** A fresh, isolated client environment: its own config, state and Claude Code dirs. */
function freshEnv(extra: Env = {}): Env {
  home = mkdtempSync(join(tmpdir(), "ats-client-"));
  return {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    AGENTTASK_TOKEN_STORE: "file",
    ...extra,
  };
}

function capture() {
  const lines: string[] = [];
  return { out: (s: string) => lines.push(s), text: () => lines.join("\n") };
}

beforeEach(() => {
  env = freshEnv();
});

describe("AC-10: client config", () => {
  it("AC-10: saves and loads url and workspace root; env overrides; never writes the token", () => {
    saveClientConfig({ url: "https://tasks.example.com/", tokenStore: "file", workspaceRoot: "/srv/work" }, env);
    const text = readFileSync(clientConfigPath(env), "utf8");
    expect(text).not.toContain("ats_");
    const cfg = loadClientConfig(env);
    expect(cfg).toEqual({ url: "https://tasks.example.com", tokenStore: "file", workspaceRoot: "/srv/work", watch: [], allowInsecureHttp: false });
    expect(loadClientConfig({ ...env, AGENTTASK_URL: "http://other:1/" }).url).toBe("http://other:1");
  });
});

describe("AC-11: token store", () => {
  it("AC-11: file store is 0600; AGENTTASK_TOKEN wins", () => {
    writeToken("file", "ats_secret", env);
    expect(statSync(tokenFile(env)).mode & 0o777).toBe(0o600);
    expect(readToken("file", env)).toBe("ats_secret");
    expect(readToken("file", { ...env, AGENTTASK_TOKEN: "ats_env" })).toBe("ats_env");
  });

  it("AC-11: auth-header prints the header JSON and nothing else", async () => {
    writeToken("file", "ats_secret", env);
    const c = capture();
    expect(await runClient(["auth-header"], c.out, env)).toBe(0);
    expect(JSON.parse(c.text())).toEqual({ Authorization: "Bearer ats_secret" });
  });
});

describe("AC-12: project id", () => {
  it("AC-12: normalises and parses remotes", () => {
    expect(normaliseProjectId("My Project.git")).toBe("my-project");
    expect(normaliseProjectId("__")).toBe("default");
    expect(repoNameFromRemote("git@example.com:owner/repo-name.git")).toBe("repo-name");
    expect(repoNameFromRemote("https://github.com/owner/other/")).toBe("other");
  });

  it("AC-12: env, then marker file, then workspace root, then git remote, then git root, then folder", () => {
    const ws = join(home, "work");
    const repo = join(ws, "Video Tools");
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(detectProject(sub, { env: {} })).toEqual({ id: "deep", source: "folder" });

    execFileSync("git", ["init", "-q"], { cwd: repo });
    expect(detectProject(sub, { env: {} })).toEqual({ id: "video-tools", source: "git-root" });
    execFileSync("git", ["remote", "add", "origin", "git@example.com:owner/video-repo.git"], { cwd: repo });
    expect(detectProject(sub, { env: {} })).toEqual({ id: "video-repo", source: "git-remote" });
    expect(detectProject(sub, { env: {}, workspaceRoot: ws })).toEqual({ id: "video-tools", source: "workspace" });

    writeFileSync(join(repo, ".agenttask"), 'project = "producing-video"\n');
    expect(detectProject(sub, { env: {}, workspaceRoot: ws })).toEqual({ id: "producing-video", source: "file" });
    expect(detectProject(sub, { env: { AGENTTASK_PROJECT: "Forced" } })).toEqual({ id: "forced", source: "env" });
  });

  it("AC-12: a marker above the git root is ignored", () => {
    const repo = join(home, "outer", "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(home, "outer", ".agenttask"), 'project = "outer"\n');
    execFileSync("git", ["init", "-q"], { cwd: repo });
    expect(detectProject(repo, { env: {} }).id).toBe("repo");
  });
});

describe("AC-13: session-start hook", () => {
  it("AC-13: unconfigured machine prints one line", async () => {
    const text = await sessionStart(home, env);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("init");
  });

  it("AC-13: unreachable server prints one line fast and exits 0", async () => {
    saveClientConfig({ url: DOWN, tokenStore: "file" }, env);
    writeToken("file", token, env);
    enqueue("add_note", { task_id: "x", text: "queued" }, env);
    const t0 = Date.now();
    const c = capture();
    expect(await runClient(["hook", "session-start"], c.out, { ...env, AGENTTASK_PROJECT: "hook-a" })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(c.text().split("\n")).toHaveLength(1);
    expect(c.text()).toMatch(/unreachable.*hook-a.*1 change\(s\) queued/);
  });

  it("AC-13: lists open tasks and finished sent tasks once, and flushes the queue", async () => {
    saveClientConfig({ url: base, tokenStore: "file" }, env);
    writeToken("file", token, env);
    const e = { ...env, AGENTTASK_PROJECT: "hook-b" };
    store.createTask("client-test", { from_project: "hook-c", to_project: "hook-b", title: "Render the intro" });
    const sent = store.createTask("client-test", { from_project: "hook-b", to_project: "hook-c", title: "Add a route" }).task;
    store.completeTask("client-test", "hook-c", sent.id, sent.version, "Route added");
    enqueue("create_task", { project: "hook-b", to_project: "hook-c", title: "Queued while offline", client_key: "queued-key-0001" }, e);

    const first = await sessionStart(home, e);
    expect(first).toContain('project id "hook-b"');
    expect(first).toContain("Render the intro");
    expect(first).toContain("Route added");
    expect(first).toContain("Sent 1 queued change(s)");
    expect(readQueue(e)).toHaveLength(0);
    expect(store.listInbox("hook-c").map((t) => t.title)).toContain("Queued while offline");

    const second = await sessionStart(home, e);
    expect(second).not.toContain("Route added");
  });
});

describe("AC-14: task commands and offline queue", () => {
  it("AC-14: create while offline is queued; flush sends it once, even when replayed", async () => {
    saveClientConfig({ url: DOWN, tokenStore: "file" }, env);
    writeToken("file", token, env);
    const c = capture();
    expect(await runClient(["task", "create", "--project", "q-a", "--to", "q-b", "--title", "Offline task"], c.out, env)).toBe(0);
    expect(c.text()).toContain("queued create_task");
    const [item] = readQueue(env);
    expect(item.args.client_key).toBeTruthy();

    const conn = { url: base, token };
    const r = await flush(conn, env);
    expect(r).toMatchObject({ remaining: 0, dropped: [] });
    expect(r.sent).toHaveLength(1);
    // Replaying the same create (e.g. a crash before the queue was rewritten) does not duplicate it.
    await callTool(conn, item.tool, item.args);
    expect(store.listInbox("q-b").filter((t) => t.title === "Offline task")).toHaveLength(1);
  });

  it("AC-14: flush keeps the queue when the server is down", async () => {
    enqueue("add_note", { task_id: "x", text: "a" }, env);
    const r = await flush({ url: DOWN, token }, env);
    expect(r).toMatchObject({ sent: [], dropped: [], remaining: 1 });
    expect(readQueue(env)).toHaveLength(1);
  });

  it("AC-14: a refused replay (stale version) is reported and dropped", async () => {
    const t = store.createTask("client-test", { from_project: "q-c", to_project: "q-d", title: "Stale" }).task;
    enqueue("complete_task", { project: "q-d", task_id: t.id, version: t.version + 5, result: "done" }, env);
    enqueue("add_note", { task_id: t.id, text: "after" }, env);
    const r = await flush({ url: base, token }, env);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toMatch(/version/i);
    expect(r.sent).toHaveLength(1);
    expect(readQueue(env)).toHaveLength(0);
  });

  it("AC-14: claim, note, complete and list through the CLI", async () => {
    saveClientConfig({ url: base, tokenStore: "file" }, env);
    writeToken("file", token, env);
    const t = store.createTask("client-test", { from_project: "cli-a", to_project: "cli-b", title: "CLI flow" }).task;
    const run = (args: string[]) => {
      const c = capture();
      return runClient(args, c.out, env).then((code) => ({ code, text: c.text() }));
    };
    expect((await run(["task", "list", "--project", "cli-b"])).text).toContain("CLI flow");
    expect((await run(["task", "claim", t.id, "--project", "cli-b"])).code).toBe(0);
    expect((await run(["task", "note", t.id, "half", "way"])).code).toBe(0);
    const done = await run(["task", "complete", t.id, "--project", "cli-b", "--result", "Finished"]);
    expect(done.code).toBe(0);
    expect(store.getTask(t.id).task.status).toBe("done");
    expect((await run(["task", "list", "--sent", "--project", "cli-a"])).text).toContain("done");
    const bad = await run(["task", "reject", t.id, "--project", "cli-b", "--reason", "no", "--version", "1"]);
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(/^error:/);
  });
});

describe("AC-15: init", () => {
  let fakeBin: string;
  let claudeLog: string;
  beforeEach(() => {
    fakeBin = join(home, "bin");
    claudeLog = join(home, "claude-calls.log");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeLog}'\n`);
    chmodSync(join(fakeBin, "claude"), 0o755);
    env.PATH = `${fakeBin}:/usr/bin:/bin`;
  });

  it("AC-15: merges the hook without touching other hooks, and is idempotent", () => {
    const other = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }] }, theme: "dark" };
    const a = mergeHook(other, "agenttaskservice");
    expect(a.changed).toBe(true);
    expect(a.settings.theme).toBe("dark");
    expect(a.settings.hooks.SessionStart).toHaveLength(2);
    expect(a.settings.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
    expect(mergeHook(a.settings, "agenttaskservice").changed).toBe(false);
    const moved = mergeHook(a.settings, "/opt/bin/agenttaskservice");
    expect(moved.changed).toBe(true);
    expect(moved.settings.hooks.SessionStart).toHaveLength(2);
    expect(other.hooks.SessionStart).toHaveLength(1);
  });

  it("AC-15: the rule block is added once and replaced in place", () => {
    const a = mergeRule("# Mine\n");
    expect(a.text).toContain("# Mine\n");
    expect(a.text).toContain(TASK_RULE);
    expect(mergeRule(a.text).changed).toBe(false);
    const edited = a.text.replace("Never put secrets", "OLD");
    expect(mergeRule(edited).text).toBe(a.text);
  });

  it("AC-15: --dry-run checks the server and writes nothing", async () => {
    const c = capture();
    expect(await runInit(["--url", base, "--token", token, "--dry-run"], c.out, env)).toBe(0);
    expect(c.text()).toContain("dry run");
    expect(existsSync(clientConfigPath(env))).toBe(false);
    expect(existsSync(tokenFile(env))).toBe(false);
    expect(existsSync(join(home, "claude", "settings.json"))).toBe(false);
    expect(existsSync(claudeLog) ? readFileSync(claudeLog, "utf8") : "").not.toContain("add-json");
    expect(c.text()).not.toContain(token);
  });

  it("AC-15: --yes stores the token, writes config, registers MCP, adds the hook and rule", async () => {
    mkdirSync(join(home, "claude"));
    writeFileSync(join(home, "claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }));
    const c = capture();
    expect(await runInit(["--url", `${base}/`, "--token", token, "--workspace-root", "/srv/work", "--rule", "--yes"], c.out, env)).toBe(0);
    expect(c.text()).not.toContain(token);
    expect(readToken("file", env)).toBe(token);
    expect(loadClientConfig(env)).toMatchObject({ url: base, workspaceRoot: "/srv/work" });
    const settings = JSON.parse(readFileSync(join(home, "claude", "settings.json"), "utf8"));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(/hook session-start$/);
    expect(readFileSync(join(home, "claude", "CLAUDE.md"), "utf8")).toContain(TASK_RULE);
    const calls = readFileSync(claudeLog, "utf8");
    expect(calls).toContain("mcp add-json agenttaskservice");
    expect(calls).toContain(`"url":"${base}/mcp"`);
    expect(calls).toContain("auth-header");
    expect(calls).not.toContain(token);

    const again = capture();
    expect(await runInit(["--url", base, "--rule", "--yes"], again.out, env)).toBe(0);
    expect(again.text()).not.toMatch(/SessionStart|task rule|Store the token/);
  });

  it("AC-15: a refused token or a down server stops init before any change", async () => {
    const bad = capture();
    expect(await runInit(["--url", base, "--token", "ats_wrong", "--yes"], bad.out, env)).toBe(1);
    expect(bad.text()).toContain("refused");
    const down = capture();
    expect(await runInit(["--url", DOWN, "--token", token, "--yes"], down.out, env)).toBe(1);
    expect(down.text()).toContain("cannot reach");
    expect(existsSync(clientConfigPath(env))).toBe(false);
  });

  it("AC-15: without `claude` on PATH it prints the command to run", async () => {
    env.PATH = "/usr/bin:/bin";
    const c = capture();
    expect(await runInit(["--url", base, "--token", token, "--yes"], c.out, env)).toBe(0);
    expect(c.text()).toContain("claude mcp add-json agenttaskservice");
  });
});
