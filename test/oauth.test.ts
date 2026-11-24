// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { redirectUriProblem } from "../src/oauth.js";
import { startServer } from "../src/server.js";
import { OAuthError, Store } from "../src/store.js";

let store: Store;
let server: Server;
let base: string;
const REDIRECT = "https://app.example.com/callback";

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  store.addToken("admin");
  store.upsertProject({ id: "oa-b" });
  // The public URL must be known before listening; use a fixed loopback port picked by the OS first.
  const probe = startServer(store, { host: "127.0.0.1", port: 0, dataDir: "", leaseHours: 4, maxBodyBytes: 100_000 }) as Server;
  await new Promise<void>((r) => probe.once("listening", () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  server = startServer(store, { host: "127.0.0.1", port, dataDir: "", leaseHours: 4, maxBodyBytes: 100_000, publicUrl: base }) as Server;
  await new Promise<void>((r) => server.once("listening", () => r()));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(redirect_uris: unknown = [REDIRECT], client_name = "Claude") {
  const r = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris, client_name }) });
  return { status: r.status, body: await r.json() };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: `${base}/mcp`,
    ...extra,
  });
  return `${base}/oauth/authorize?${p}`;
}

/** Load the approval page and post it, as a browser would. */
async function approve(clientId: string, challenge: string, fields: Record<string, string>) {
  const page = await fetch(authorizeUrl(clientId, challenge));
  const html = await page.text();
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...hidden, action: "approve", ...fields }).toString(),
  });
}

async function token(fields: Record<string, string>) {
  const r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  return { status: r.status, body: await r.json() };
}

/** Run the whole flow and return the client and tokens. */
async function connect(name: string) {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const { code: pairing } = store.createPairing("admin");
  const r = await approve(client.client_id, challenge, { pairing_code: pairing, name });
  expect(r.status).toBe(303);
  const loc = new URL(r.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st-1");
  expect(loc.searchParams.get("iss")).toBe(base);
  const code = loc.searchParams.get("code")!;
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  expect(t.status).toBe(200);
  return { client, code, verifier, tokens: t.body };
}

async function mcpWorks(accessToken: string): Promise<boolean> {
  const c = new Client({ name: "t", version: "0" });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
    const tools = await c.listTools();
    return tools.tools.length > 0;
  } catch {
    return false;
  } finally {
    await c.close().catch(() => {});
  }
}

describe("AC-26: metadata and discovery", () => {
  it("AC-26: /mcp without a token points at the protected-resource metadata", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  });

  it("AC-26: protected-resource and authorization-server metadata", async () => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(pr).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(await as.json()).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`, { method: "OPTIONS" })).status).toBe(204);
  });

  it("AC-26: OAuth is off without a public URL, and the URL must be https", async () => {
    const s = startServer(new Store(openDb(":memory:")), { host: "127.0.0.1", port: 0, dataDir: "", leaseHours: 4, maxBodyBytes: 1e5 }) as Server;
    await new Promise<void>((r) => s.once("listening", () => r()));
    try {
      const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      expect((await fetch(`${b}/.well-known/oauth-authorization-server`)).status).toBe(401);
      expect((await fetch(`${b}/mcp`, { method: "POST" })).headers.get("www-authenticate")).not.toContain("resource_metadata");
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    expect(loadConfig("/dev/null", { AGENTTASK_PUBLIC_URL: "https://tasks.example.com/" }).publicUrl).toBe("https://tasks.example.com");
    expect(() => loadConfig("/dev/null", { AGENTTASK_PUBLIC_URL: "http://tasks.example.com" })).toThrow(/https/);
    expect(() => loadConfig("/dev/null", { AGENTTASK_PUBLIC_URL: "https://tasks.example.com/x" })).toThrow(/origin/);
  });
});

describe("AC-26: dynamic client registration", () => {
  it("AC-26: registers public clients with valid redirect URIs only", async () => {
    const ok = await register();
    expect(ok.status).toBe(201);
    expect(ok.body.client_id).toMatch(/^atc_/);
    expect(ok.body.token_endpoint_auth_method).toBe("none");
    expect((await register(["http://evil.example.com/cb"])).status).toBe(400);
    expect((await register(["https://a.example.com/cb#frag"])).status).toBe(400);
    expect((await register([])).status).toBe(400);
    expect((await register("nope")).status).toBe(400);
    expect(redirectUriProblem("http://localhost:3000/cb")).toBeUndefined();
    expect(redirectUriProblem("http://127.0.0.1/cb")).toBeUndefined();
    expect(redirectUriProblem("javascript:alert(1)")).toBeDefined();
  });

  it("AC-26: unused registrations are pruned at the cap", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const s = new Store(openDb(":memory:"), { now: () => now });
    for (let i = 0; i < 200; i++) s.registerClient("x", [REDIRECT]);
    expect(() => s.registerClient("x", [REDIRECT])).toThrow(OAuthError);
    now = new Date("2026-01-03T00:00:00Z");
    expect(s.registerClient("x", [REDIRECT]).client_id).toMatch(/^atc_/);
  });
});

describe("AC-27: approval page", () => {
  it("AC-27: shows the app and where it returns, with a CSP that allows only that redirect", async () => {
    const { body: client } = await register(undefined, "<b>Claude</b>");
    const r = await fetch(authorizeUrl(client.client_id, pkce().challenge));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("&lt;b&gt;Claude&lt;/b&gt;");
    expect(html).not.toContain("<b>Claude</b>");
    expect(html).toContain("app.example.com");
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self' https://app.example.com;");
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });

  it("AC-27: unknown clients and mismatched redirect URIs get an error page, never a redirect", async () => {
    const bad = await fetch(authorizeUrl("atc_nope", pkce().challenge), { redirect: "manual" });
    expect(bad.status).toBe(400);
    const { body: client } = await register();
    const other = await fetch(authorizeUrl(client.client_id, pkce().challenge, { redirect_uri: "https://app.example.com/other" }), { redirect: "manual" });
    expect(other.status).toBe(400);
    expect(other.headers.get("location")).toBeNull();
  });

  it("AC-27: protocol errors go back to the client with state", async () => {
    const { body: client } = await register();
    const r = await fetch(authorizeUrl(client.client_id, pkce().challenge, { code_challenge_method: "plain" }), { redirect: "manual" });
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("st-1");
    const t = await fetch(authorizeUrl(client.client_id, pkce().challenge, { resource: "https://other.example.com/mcp" }), { redirect: "manual" });
    expect(new URL(t.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("AC-27: a wrong pairing code or a missing CSRF value is refused; deny returns access_denied", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const wrong = await approve(client.client_id, challenge, { pairing_code: "ZZZZ-ZZZZ", name: "nope" });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain("pairing code is wrong");
    const noCsrf = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", pairing_code: store.createPairing("admin").code, name: "x1", action: "approve" }).toString(),
    });
    expect(noCsrf.status).toBe(403);
    expect(store.listTokens().some((t) => t.name === "x1")).toBe(false);
    const deny = await approve(client.client_id, challenge, { action: "deny" });
    expect(new URL(deny.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });
});

describe("AC-26: tokens", () => {
  it("AC-26: code + PKCE gives tokens that work on /mcp and map to a named token row", async () => {
    const { tokens } = await connect("claude-app");
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "tasks" });
    expect(tokens.access_token).toMatch(/^ata_/);
    expect(tokens.refresh_token).toMatch(/^atr_/);
    expect(await mcpWorks(tokens.access_token)).toBe(true);
    expect(store.listTokens().find((t) => t.name === "claude-app")?.last_used_at).toBeTruthy();
  });

  it("AC-26: a wrong verifier fails; a replayed code fails and revokes what it issued", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const r = await approve(client.client_id, challenge, { pairing_code: store.createPairing("admin").code, name: "replay" });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const base_ = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id };
    expect((await token({ ...base_, code_verifier: pkce().verifier })).body.error).toBe("invalid_grant");
    const good = await token({ ...base_, code_verifier: verifier });
    expect(good.status).toBe(200);
    const again = await token({ ...base_, code_verifier: verifier });
    expect(again.body.error).toBe("invalid_grant");
    expect(await mcpWorks(good.body.access_token)).toBe(false);
    expect((await token({ ...base_, client_id: "atc_nope", code_verifier: verifier })).status).toBe(401);
  });

  it("AC-26: refresh tokens rotate, and reusing an old one revokes the connection", async () => {
    const { client, tokens } = await connect("rotator");
    const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(await mcpWorks(r1.body.access_token)).toBe(true);
    const reuse = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(reuse.body.error).toBe("invalid_grant");
    expect(await mcpWorks(r1.body.access_token)).toBe(false);
    expect((await token({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: client.client_id })).status).toBe(400);
  });

  it("AC-26: revocation endpoint and `token revoke` both cut the app off", async () => {
    const a = await connect("revoke-me");
    const r = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: a.tokens.refresh_token }).toString() });
    expect(r.status).toBe(200);
    expect(await mcpWorks(a.tokens.access_token)).toBe(false);

    const b = await connect("cut-off");
    store.revokeToken("cut-off");
    expect(await mcpWorks(b.tokens.access_token)).toBe(false);
    expect((await token({ grant_type: "refresh_token", refresh_token: b.tokens.refresh_token, client_id: b.client.client_id })).status).toBe(400);
    // Re-adding the name doesn't revive old grants.
    store.addToken("cut-off");
    expect(await mcpWorks(b.tokens.access_token)).toBe(false);
  });

  it("AC-26: access tokens expire after an hour", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const s = new Store(openDb(":memory:"), { now: () => now });
    const { client_id } = s.registerClient("x", [REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = s.approveClient({ pairingCode: s.createPairing("cli").code, name: "exp", clientId: client_id, redirectUri: REDIRECT, codeChallenge: challenge, scope: "tasks" });
    const t = s.exchangeCode(code, client_id, REDIRECT, verifier);
    expect(s.authenticate(t.access_token)).toBe("exp");
    now = new Date("2026-01-01T01:00:01Z");
    expect(s.authenticate(t.access_token)).toBeUndefined();
  });

  it("AC-26: secrets are stored hashed", async () => {
    const { tokens, code } = await connect("hashed");
    const db = (store as any).db;
    const dump = JSON.stringify([db.prepare("SELECT * FROM oauth_tokens").all(), db.prepare("SELECT * FROM oauth_codes").all()]);
    for (const secret of [tokens.access_token, tokens.refresh_token, code]) expect(dump).not.toContain(secret);
  });
});
