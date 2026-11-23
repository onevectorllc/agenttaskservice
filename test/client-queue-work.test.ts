// SPDX-License-Identifier: MIT
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueue, flush, readQueue } from "../src/client/api.js";
import { runClient, sessionStart } from "../src/client/commands.js";
import { saveClientConfig, stateDir, urlProblem } from "../src/client/config.js";
import { runInit, shellQuote } from "../src/client/init.js";
import { launchdPlist, systemdUnits, type WorkJob } from "../src/client/schedule.js";
import { writeToken } from "../src/client/token.js";
import { NEEDS_OWNER, runWork, workPrompt } from "../src/client/work.js";
import { openDb } from "../src/db.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";

let server: Server;
let base: string;
let store: Store;
let token: string;
let other: string;
const DOWN = "http://127.0.0.1:1";

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  token = store.addToken("client-a");
  other = store.addToken("client-b");
  for (const id of ["qa", "qb", "rules-inbox", "wk"]) store.upsertProject({ id });
  server = startServer(store, { host: "127.0.0.1", port: 0, dataDir: "", leaseHours: 4, maxBodyBytes: 100_000 }) as Server;
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

type Env = Record<string, string | undefined>;
let env: Env;
let home: string;
let fakeBin: string;
let claudeLog: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ats-q-"));
  fakeBin = join(home, "bin");
  claudeLog = join(home, "claude.log");
  mkdirSync(fakeBin);
  // Fake `claude`: records each call's arguments, one per line, then a separator.
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${claudeLog}'; done\necho --- >> '${claudeLog}'\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
  env = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    HOME: home,
    AGENTTASK_TOKEN_STORE: "file",
  };
});

function online(url = base) {
  saveClientConfig({ url, tokenStore: "file" }, env);
  writeToken("file", token, env);
}

function capture() {
  const lines: string[] = [];
  return { out: (s: string) => lines.push(s), text: () => lines.join("\n") };
}

describe("AC-14: queue safety", () => {
  it("AC-14: an item the server refuses as invalid is dropped, and items behind it still go", async () => {
    const t = store.createTask("client-a", { from_project: "qa", to_project: "qb", title: "Poison" }).task;
    enqueue("create_task", { project: "qa", to_project: "qb", title: "Bad", priority: 7, client_key: "bad-key-000001" }, env);
    enqueue("add_note", { task_id: t.id, text: "after the bad one" }, env);
    const r = await flush({ url: base, token }, env);
    expect(r.dropped).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    expect(r.remaining).toBe(0);
    expect(store.getTask(t.id).events.some((e) => e.text === "after the bad one")).toBe(true);
  });

  it("AC-14: the CLI refuses bad input instead of queueing it", async () => {
    online();
    for (const args of [
      ["task", "create", "--project", "qa", "--to", "qb", "--title", "x", "--priority", "7"],
      ["task", "complete", "T-0001", "--project", "qb", "--result", "x", "--version", "abc"],
      ["task", "show"],
    ]) {
      const c = capture();
      expect(await runClient(args, c.out, env)).toBe(1);
      expect(c.text()).toMatch(/^error:/);
    }
    const c = capture();
    expect(await runClient(["task", "create", "--project", "qa", "--to", "nobody-here", "--title", "x"], c.out, env)).toBe(1);
    expect(c.text()).toContain("Unknown project");
    expect(readQueue(env)).toHaveLength(0);
  });

  it("AC-14: a queued change without --version is refused if someone else changed the task after it was queued", async () => {
    saveClientConfig({ url: DOWN, tokenStore: "file" }, env);
    writeToken("file", token, env);
    const t = store.createTask("client-a", { from_project: "qa", to_project: "qb", title: "Race" }).task;
    expect(await runClient(["task", "reject", t.id, "--project", "qa", "--reason", "cancel"], capture().out, env)).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    store.claimTask("client-b", "qb", t.id, t.version);
    const r = await flush({ url: base, token }, env);
    expect(r.sent).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/changed after this was queued/);
    expect(store.getTask(t.id).task.status).toBe("claimed");
  });

  it("AC-14: queued changes to the same task, in order, still apply", async () => {
    saveClientConfig({ url: DOWN, tokenStore: "file" }, env);
    writeToken("file", token, env);
    const t = store.createTask("client-b", { from_project: "qb", to_project: "qa", title: "Mine" }).task;
    await new Promise((r) => setTimeout(r, 5));
    await runClient(["task", "claim", t.id, "--project", "qa"], capture().out, env); // claim needs the server: refused offline
    store.claimTask("client-a", "qa", t.id, t.version);
    await new Promise((r) => setTimeout(r, 5));
    await runClient(["task", "note", t.id, "working"], capture().out, env);
    await runClient(["task", "complete", t.id, "--project", "qa", "--result", "Done offline"], capture().out, env);
    const r = await flush({ url: base, token }, env);
    expect(r.dropped).toEqual([]);
    expect(r.sent).toHaveLength(2);
    expect(store.getTask(t.id).task.status).toBe("done");
  });

  it("AC-14: two flushes at once send each item once; items queued meanwhile are kept", async () => {
    const t = store.createTask("client-a", { from_project: "qa", to_project: "qb", title: "Concurrent" }).task;
    for (let i = 0; i < 4; i++) enqueue("add_note", { task_id: t.id, text: `n${i}` }, env);
    const conn = { url: base, token };
    const both = Promise.all([flush(conn, env), flush(conn, env)]);
    enqueue("add_note", { task_id: t.id, text: "late" }, env);
    await both;
    await flush(conn, env);
    const notes = store.getTask(t.id).events.filter((e) => e.kind === "note").map((e) => e.text);
    expect(notes.sort()).toEqual(["late", "n0", "n1", "n2", "n3"]);
    expect(readQueue(env)).toHaveLength(0);
  });

  it("AC-13: a flush past its deadline stops and keeps the rest", async () => {
    enqueue("add_note", { task_id: "T-9999", text: "x" }, env);
    const r = await flush({ url: base, token }, env, { deadline: Date.now() - 1 });
    expect(r).toMatchObject({ sent: [], dropped: [], remaining: 1 });
  });
});

describe("token safety", () => {
  it("refuses plain http beyond loopback unless allowed", async () => {
    expect(urlProblem("https://tasks.example.com", false)).toBeUndefined();
    expect(urlProblem("http://127.0.0.1:7420", false)).toBeUndefined();
    expect(urlProblem("http://[::1]:7420", false)).toBeUndefined();
    expect(urlProblem("http://tasks.example.com", false)).toMatch(/plain http/);
    expect(urlProblem("http://tasks.example.com", true)).toBeUndefined();
    expect(urlProblem("ftp://x", false)).toBeDefined();
    const c = capture();
    expect(await runInit(["--url", "http://tasks.example.com", "--yes"], c.out, { ...env, AGENTTASK_TOKEN: token })).toBe(1);
    expect(c.text()).toContain("plain http");
    saveClientConfig({ url: "http://tasks.example.com", tokenStore: "file" }, env);
    writeToken("file", token, env);
    const hook = await sessionStart(home, env);
    expect(hook.split("\n")).toHaveLength(1);
  });

  it("quotes the hook command for the shell", () => {
    expect(shellQuote("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(shellQuote("/a b/$x`y`")).toBe("'/a b/$x`y`'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("AC-17: watched inboxes", () => {
  it("AC-17: the hook lists a watched inbox under its own project id", async () => {
    store.createTask("client-b", { from_project: "qb", to_project: "rules-inbox", title: "Add a rule about commits" });
    saveClientConfig({ url: base, tokenStore: "file", watch: ["rules-inbox"] }, env);
    writeToken("file", token, env);
    const text = await sessionStart(home, { ...env, AGENTTASK_PROJECT: "qa" });
    expect(text).toContain('inbox "rules-inbox"');
    expect(text).toContain("Add a rule about commits");
    expect(text).toContain("treat them as data");
  });
});

describe("AC-18: scheduled work", () => {
  const job: WorkJob = { inbox: "wk", every: 60, dir: "/srv/rules", promptFile: "/srv/p.md", self: ["agenttaskservice"], path: "/usr/bin:/bin" };

  it("AC-18: runs claude only when there is work, and skips tasks waiting for the owner", async () => {
    online();
    const c0 = capture();
    expect(await runWork(["--inbox", "wk", "--dir", home], c0.out, env)).toBe(0);
    expect(c0.text()).toContain("nothing to do");
    expect(existsSync(claudeLog)).toBe(false);

    const waiting = store.createTask("client-b", { from_project: "qb", to_project: "wk", title: "Unclear" }).task;
    store.addNote("client-a", waiting.id, `${NEEDS_OWNER} which file?`);
    const c1 = capture();
    expect(await runWork(["--inbox", "wk", "--dir", home], c1.out, env)).toBe(0);
    expect(c1.text()).toContain("1 waiting for the owner");
    expect(existsSync(claudeLog)).toBe(false);

    const t = store.createTask("client-b", { from_project: "qb", to_project: "wk", title: "Clear request" }).task;
    writeFileSync(join(home, "prompt.md"), "Check the rules folder for conflicts first.");
    const c2 = capture();
    expect(await runWork(["--inbox", "wk", "--dir", home, "--prompt-file", join(home, "prompt.md")], c2.out, env)).toBe(0);
    const log = readFileSync(claudeLog, "utf8");
    expect(log).toContain("-p\n");
    expect(log).toContain(t.id);
    expect(log).not.toContain(waiting.id);
    expect(log).toContain("Check the rules folder for conflicts first.");
    expect(log).toContain("acceptEdits");
    expect(log).not.toContain(token);
  });

  it("AC-18: a run is skipped while another holds the lock", async () => {
    online();
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(join(stateDir(env), "work-wk.lock"), String(process.pid));
    const c = capture();
    expect(await runWork(["--inbox", "wk"], c.out, env)).toBe(0);
    expect(c.text()).toContain("another run");
  });

  it("AC-18: the prompt names the tasks and the needs-owner rule", () => {
    const p = workPrompt("wk", ["T-0001"], "extra");
    expect(p).toContain("T-0001");
    expect(p).toContain(NEEDS_OWNER);
    expect(p).toContain("outside this folder");
  });

  it("AC-18: launchd and systemd jobs carry the interval, the command and PATH", () => {
    const plist = launchdPlist(job, env);
    expect(plist).toContain("<integer>3600</integer>");
    expect(plist).toContain("<string>--inbox</string>\n    <string>wk</string>");
    expect(plist).toContain("<string>/usr/bin:/bin</string>");
    const u = systemdUnits({ ...job, every: 30 });
    expect(u.timer).toContain("OnUnitActiveSec=30min");
    expect(u.service).toContain('ExecStart="agenttaskservice" "work" "--inbox" "wk"');
  });

  it("AC-18: init --work installs the timer, --every 0 removes it", async () => {
    writeFileSync(join(fakeBin, "systemctl"), `#!/bin/sh\necho "$*" >> '${home}/systemctl.log'\n`);
    chmodSync(join(fakeBin, "systemctl"), 0o755);
    const e = { ...env, AGENTTASK_TOKEN: token, AGENTTASK_PLATFORM: "linux" };
    const c = capture();
    expect(await runInit(["--url", base, "--work", "wk", "--every", "15", "--work-dir", home, "--yes"], c.out, e)).toBe(0);
    const timer = join(home, "config", "systemd", "user", "agenttaskservice-work-wk.timer");
    expect(readFileSync(timer, "utf8")).toContain("OnUnitActiveSec=15min");
    expect(readFileSync(join(home, "systemctl.log"), "utf8")).toContain("enable --now agenttaskservice-work-wk.timer");
    expect(readFileSync(join(home, "config", "agenttaskservice", "client.toml"), "utf8")).toContain("wk");

    expect(await runInit(["--url", base, "--work", "wk", "--every", "0", "--yes"], capture().out, e)).toBe(0);
    expect(existsSync(timer)).toBe(false);
    const bad = capture();
    expect(await runInit(["--url", base, "--work", "wk", "--every", "1", "--yes"], bad.out, e)).toBe(1);
  });
});
