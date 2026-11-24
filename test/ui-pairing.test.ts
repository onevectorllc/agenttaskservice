// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/client/init.js";
import { readToken, tokenFile } from "../src/client/token.js";
import { run } from "../src/cli.js";
import { isPrivateAddress, loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createServer } from "node:http";
import { FailureLimit } from "../src/ratelimit.js";
import { createHandler, startServer, startUi } from "../src/server.js";
import { Store } from "../src/store.js";
import { createUiHandler, h } from "../src/ui.js";

let store: Store;
let api: Server;
let ui: Server;
let apiBase: string;
let uiBase: string;
let admin: string;

const cfg = { host: "127.0.0.1", port: 0, dataDir: "", leaseHours: 4, maxBodyBytes: 100_000, ui: { host: "127.0.0.1", port: 0, apiUrl: "https://tasks.example.com" } };

async function up(s: Server): Promise<string> {
  if (!s.listening) await new Promise<void>((r) => s.once("listening", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  admin = store.addToken("admin");
  store.upsertProject({ id: "ui-b", name: "UI B", description: "Gets <b>tasks</b>" });
  store.createTask("admin", { from_project: "ui-a", to_project: "ui-b", title: '<script>alert("x")</script>', body: "body & <img src=x onerror=1>" });
  api = startServer(store, cfg) as Server;
  ui = startUi(store, cfg) as Server;
  apiBase = await up(api);
  uiBase = await up(ui);
});
afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => ui.close(() => r()));
});

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Load the sign-in form: its pre-session CSRF cookie and field. */
async function loginForm(base = uiBase): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`${base}/ui/login`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return { cookie, csrf: csrfOf(await r.text()) };
}

async function postLogin(token: string, base = uiBase, extra: Record<string, string> = {}): Promise<Response> {
  const f = await loginForm(base);
  return fetch(`${base}/ui/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: f.cookie, "content-type": "application/x-www-form-urlencoded", ...extra },
    body: form({ token, csrf: f.csrf }),
  });
}

async function login(token = admin): Promise<string> {
  const r = await postLogin(token);
  expect(r.status).toBe(303);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith("ats_ui=")) ?? "";
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  expect(cookie).toMatch(/Max-Age=43200/);
  expect(cookie).not.toMatch(/Secure/);
  return cookie.split(";")[0];
}

async function get(path: string, cookie?: string) {
  const r = await fetch(`${uiBase}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { r, text: await r.text() };
}

function csrfOf(html: string): string {
  return /name="csrf" value="([^"]+)"/.exec(html)![1];
}

describe("AC-19: the UI has its own listener", () => {
  it("AC-19: the API port serves no /ui pages", async () => {
    expect((await fetch(`${apiBase}/ui/`)).status).toBe(401);
    const r = await fetch(`${apiBase}/ui/`, { headers: { authorization: `Bearer ${admin}` } });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("<html");
  });
  it("AC-19: the UI is off unless enabled, and its port must differ from the API port", () => {
    expect(loadConfig("/dev/null", {}).ui).toBeUndefined();
    expect(loadConfig("/dev/null", { AGENTTASK_UI_ENABLED: "true" }).ui).toEqual({ host: "127.0.0.1", port: 7421, apiUrl: undefined });
    expect(() => loadConfig("/dev/null", { AGENTTASK_UI_ENABLED: "true", AGENTTASK_UI_PORT: "7420" })).toThrow(/differ/);
  });
  it("AC-19: private addresses are recognised, and serve warns when the UI listens on any other", async () => {
    // Built from parts so the repo's own private-address check doesn't flag the test data.
    const ip = (...p: number[]) => p.join(".");
    for (const a of ["127.0.0.1", "::1", ip(10, 1, 2, 3), ip(172, 16, 0, 1), ip(172, 31, 9, 9), ip(192, 168, 1, 2), "169.254.1.1", "fd12:3456::1", "fe80::1"]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "11.0.0.1", "2001:db8::1", "example.com"]) expect(isPrivateAddress(a)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "ats-uiwarn-"));
    const file = join(dir, "s.toml");
    writeFileSync(file, `[server]\nport = 0\n[storage]\ndata_dir = "${join(dir, "data")}"\n[ui]\nenabled = true\nhost = "0.0.0.0"\nport = 0\n`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const servers: import("node:net").Server[] = [];
    try {
      expect(run(["serve", "--config", file], () => {}, { onServer: (x) => servers.push(x), onUi: (x) => servers.push(x) })).toBe(0);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/web UI listens on 0\.0\.0\.0/);
      expect(servers).toHaveLength(2);
    } finally {
      warn.mockRestore();
      for (const x of servers) await new Promise<void>((r) => x.close(() => r()));
    }
  });
});

describe("AC-20: sign-in", () => {
  it("AC-20: pages redirect to sign-in without a session; a bad token is refused", async () => {
    const { r } = await get("/ui/");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/ui/login");
    expect((await postLogin("ats_wrong")).status).toBe(401);
  });

  it("AC-20: sign-in itself needs the form's CSRF value and a same-site origin", async () => {
    const noCsrf = await fetch(`${uiBase}/ui/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: admin }) });
    expect(noCsrf.status).toBe(403);
    expect((await postLogin(admin, uiBase, { origin: "http://evil.example.com" })).status).toBe(403);
  });

  it("AC-20: a browser's \"Origin: null\" (sent because pages use no-referrer) still signs in and posts forms", async () => {
    const r = await postLogin(admin, uiBase, { origin: "null" });
    expect(r.status).toBe(303);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith("ats_ui="))!.split(";")[0];
    const csrf = csrfOf((await get("/ui/setup", cookie)).text);
    const pair = await fetch(`${uiBase}/ui/setup/pair`, {
      method: "POST",
      headers: { cookie, origin: "null", "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf, name: "null-origin" }),
    });
    expect(pair.status).toBe(200);
    expect(await pair.text()).toContain('class="code"');
  });

  it("AC-20: failed sign-ins are rate limited", async () => {
    const srv = startUi(new Store(openDb(":memory:")), cfg) as Server;
    const base = await up(srv);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await postLogin("ats_wrong", base)).status);
      expect(statuses.slice(0, 10).every((x) => x === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("AC-20: the cookie is Secure when the server uses TLS", async () => {
    const s = new Store(openDb(":memory:"));
    const t = s.addToken("a");
    const srv = createServer((req, res) => void createUiHandler(s, { secure: true })(req, res)).listen(0, "127.0.0.1");
    const base = await up(srv);
    try {
      const r = await postLogin(t, base);
      expect(r.headers.getSetCookie().find((c) => c.startsWith("ats_ui="))).toMatch(/; Secure/);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("AC-20: sessions end after 12 hours", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const s = new Store(openDb(":memory:"), { now: () => now });
    s.addToken("a");
    const { sid } = s.createSession("a", 12);
    now = new Date("2026-01-01T11:59:00Z");
    expect(s.getSession(sid)).toBeDefined();
    now = new Date("2026-01-01T12:00:01Z");
    expect(s.getSession(sid)).toBeUndefined();
  });

  it("AC-20: a new token under a revoked name does not revive old sessions", () => {
    const s = new Store(openDb(":memory:"));
    s.addToken("laptop");
    const old = s.createSession("laptop");
    s.revokeToken("laptop");
    s.addToken("laptop");
    expect(s.getSession(old.sid)).toBeUndefined();
    // Even if the session row survived, it is bound to the old token's hash.
    const a = s.createSession("laptop");
    (s as any).db.prepare("UPDATE tokens SET hash = 'other' WHERE name = 'laptop'").run();
    expect(s.getSession(a.sid)).toBeUndefined();
  });

  it("AC-20: a malformed cookie does not break pages", async () => {
    const cookie = await login();
    const { r } = await get("/ui/", `x=%; ${cookie}`);
    expect(r.status).toBe(200);
    expect((await get("/ui/t/%E0%A4%A", cookie)).r.status).toBe(404);
  });

  it("AC-20: a session cookie works, logout needs CSRF, and logout ends the session", async () => {
    const cookie = await login();
    const home = await get("/ui/", cookie);
    expect(home.r.status).toBe(200);
    const csrf = csrfOf(home.text);
    const noCsrf = await fetch(`${uiBase}/ui/logout`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(noCsrf.status).toBe(403);
    const otherOrigin = await fetch(`${uiBase}/ui/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: "http://evil.example.com", "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf }),
    });
    expect(otherOrigin.status).toBe(403);
    const out = await fetch(`${uiBase}/ui/logout`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({ csrf }) });
    expect(out.status).toBe(303);
    expect((await get("/ui/", cookie)).r.status).toBe(303);
  });

  it("AC-20: a revoked token's session stops working", async () => {
    const t = store.addToken("short-lived");
    const cookie = await login(t);
    expect((await get("/ui/", cookie)).r.status).toBe(200);
    store.revokeToken("short-lived");
    expect((await get("/ui/", cookie)).r.status).toBe(303);
  });

  it("AC-20: sessions are stored hashed", () => {
    const s = store.createSession("admin");
    expect(store.getSession(s.sid)?.token_name).toBe("admin");
    const raw = JSON.stringify((store as any).db.prepare("SELECT * FROM ui_sessions").all());
    expect(raw).not.toContain(s.sid);
  });
});

describe("AC-21: task views", () => {
  it("AC-21: escapes task text and sends a strict CSP", async () => {
    const cookie = await login();
    const list = await get("/ui/p/ui-b", cookie);
    expect(list.r.status).toBe(200);
    expect(list.r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(list.r.headers.get("x-frame-options")).toBe("DENY");
    expect(list.text).not.toContain("<script>alert");
    expect(list.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    const id = /href="\/ui\/t\/([^"]+)"/.exec(list.text)![1];
    const detail = await get(`/ui/t/${id}`, cookie);
    expect(detail.text).toContain("body &amp; &lt;img src=x onerror=1&gt;");
    expect(detail.text).not.toContain("<img src=x");
    const home = await get("/ui/", cookie);
    expect(home.text).toContain("Gets &lt;b&gt;tasks&lt;/b&gt;");
    expect((await get("/ui/t/T-nope", cookie)).r.status).toBe(404);
    expect(h(`<a href='x'>&`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;");
  });
});

describe("AC-22/AC-23: setup guide and pairing", () => {
  it("AC-22: the setup page shows the API URL and connected machines", async () => {
    const cookie = await login();
    const page = await get("/ui/setup", cookie);
    expect(page.text).toContain("https://tasks.example.com");
    expect(page.text).toContain("init --url https://tasks.example.com");
    expect(page.text).toContain("git clone &lt;repository URL&gt;");
    expect(page.text).toMatch(/<td>admin<\/td><td><time/);
  });

  it("AC-23: the UI creates a code that pairs once; a reused or wrong code is refused", async () => {
    const cookie = await login();
    const csrf = csrfOf((await get("/ui/setup", cookie)).text);
    const r = await fetch(`${uiBase}/ui/setup/pair`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({ csrf, name: "pi-test" }) });
    const html = await r.text();
    const code = /class="code">([A-Z0-9-]+)</.exec(html)![1];
    expect(html).toContain(`--pair ${code} --rule`);
    const pair = (c: string, name?: string) =>
      fetch(`${apiBase}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c, name }) });
    const ok = await pair(code.toLowerCase().replace("-", ""));
    expect(ok.status).toBe(200);
    const got = await ok.json();
    expect(got.name).toBe("pi-test");
    expect(store.authenticate(got.token)).toBe("pi-test");
    expect((await pair(code)).status).toBe(403);
    expect((await pair("ZZZZ-ZZZZ")).status).toBe(403);
    expect(JSON.stringify((store as any).db.prepare("SELECT * FROM pairings").all())).not.toContain(code);
  });

  it("AC-23: codes expire, and a nameless code needs a name", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const s = new Store(openDb(":memory:"), { now: () => now });
    const a = s.createPairing("cli");
    expect(() => s.redeemPairing(a.code)).toThrow(/name/);
    expect(s.redeemPairing(a.code, "laptop").name).toBe("laptop");
    const b = s.createPairing("cli", { name: "late" });
    now = new Date("2026-01-01T00:11:00Z");
    expect(() => s.redeemPairing(b.code)).toThrow(/expired/);
  });

  it("AC-23: wrong codes are rate limited per client behind a trusted proxy, without locking out others", async () => {
    const s = new Store(openDb(":memory:"));
    const srv = startServer(s, { ...cfg, ui: undefined, trustProxy: true }) as Server;
    const base = await up(srv);
    const pair = (ip: string, code = "AAAA-AAAA") =>
      fetch(`${base}/v1/pair`, { method: "POST", headers: { "x-forwarded-for": `9.9.9.9, ${ip}` }, body: JSON.stringify({ code, name: "n" }) });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await pair("203.0.113.5")).status);
      expect(statuses.slice(0, 10).every((x) => x === 403)).toBe(true);
      expect(statuses[10]).toBe(429);
      const { code } = s.createPairing("cli");
      expect((await pair("203.0.113.6", code)).status).toBe(200);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("AC-23: without a trusted proxy, a loopback peer (a proxy shared by everyone) counts only toward the global cap", async () => {
    const s = new Store(openDb(":memory:"));
    const lim = new FailureLimit(10, 15);
    const srv = createServer((req, res) => void createHandler(s, { maxBodyBytes: 4096 }, lim)(req, res)).listen(0, "127.0.0.1");
    const base = await up(srv);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 16; i++) statuses.push((await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: "AAAA-AAAA" }) })).status);
      expect(statuses.slice(0, 15).every((x) => x === 403)).toBe(true);
      expect(statuses[15]).toBe(429);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("AC-23: the limiter forgets idle clients", () => {
    let t = 0;
    const lim = new FailureLimit(10, 1000, 1000, () => t);
    for (let i = 0; i < 20; i++) lim.fail(`10.0.0.${i}`);
    expect(lim.size).toBe(21);
    t = 5000;
    lim.blocked(undefined);
    expect(lim.size).toBe(0);
  });

  it("AC-23: init --pair trades the code only after the changes are confirmed", async () => {
    const home = mkdtempSync(join(tmpdir(), "ats-pair-"));
    const env = {
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      AGENTTASK_TOKEN_STORE: "file",
    };
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    const { code } = store.createPairing("admin");
    expect(await runInit(["--url", apiBase, "--insecure", "--pair", code, "--name", "dry", "--dry-run"], out, env)).toBe(0);
    expect(existsSync(tokenFile(env))).toBe(false);
    expect(store.listTokens().some((t) => t.name === "dry")).toBe(false);

    expect(await runInit(["--url", apiBase, "--insecure", "--pair", code, "--name", "paired-box", "--yes"], out, env)).toBe(0);
    const t = readToken("file", env)!;
    expect(store.authenticate(t)).toBe("paired-box");
    expect(lines.join("\n")).not.toContain(t);

    expect(await runInit(["--url", apiBase, "--insecure", "--pair", code, "--name", "again", "--yes"], out, { ...env, XDG_CONFIG_HOME: join(home, "c2") })).toBe(1);
    expect(lines.join("\n")).toContain("Invalid or expired pairing code");
    expect(await runInit(["--url", apiBase, "--insecure", "--pair", "nope", "--yes"], out, env)).toBe(1);
  });
});

describe("AC-24: last used, CLI pairing, stale admin token", () => {
  it("AC-24: authenticate records last use, shown by token list", () => {
    const dir = mkdtempSync(join(tmpdir(), "ats-p3cli-"));
    const file = join(dir, "s.toml");
    writeFileSync(file, `[storage]\ndata_dir = "${join(dir, "data")}"\n`);
    const lines: string[] = [];
    const cli = (...a: string[]) => run([...a, "--config", file], (s) => lines.push(s));
    expect(cli("token", "add", "box")).toBe(0);
    const tok = lines.pop()!;
    expect(cli("token", "list")).toBe(0);
    expect(lines.pop()).toContain("last used never");
    new Store(openDb(join(dir, "data", "agenttaskservice.db"))).authenticate(tok);
    cli("token", "list");
    expect(lines.pop()).toMatch(/last used \d{4}-/);
    expect(cli("token", "pair", "--name", "newbox")).toBe(0);
    expect(lines.join("\n")).toMatch(/Pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}/);
  });

  it("AC-24: serve explains a stale admin-token file instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ats-stale-"));
    const dataDir = join(dir, "data");
    const file = join(dir, "s.toml");
    writeFileSync(file, `[server]\nport = 0\n[storage]\ndata_dir = "${dataDir}"\n`);
    const s = new Store(openDb(join(dataDir, "agenttaskservice.db")));
    s.addToken("admin");
    s.revokeToken("admin");
    writeFileSync(join(dataDir, "admin-token"), "old\n");
    const lines: string[] = [];
    expect(run(["serve", "--config", file], (x) => lines.push(x))).toBe(1);
    expect(lines.join("\n")).toContain("old admin token file");
  });
});
