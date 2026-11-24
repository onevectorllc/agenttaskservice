// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopback } from "./config.js";
import { clientKey, FailureLimit } from "./ratelimit.js";
import { OAuthError, Store, TaskError } from "./store.js";
import { CSS, h } from "./ui.js";

/**
 * OAuth 2.1 for MCP clients such as the Claude app (MCP authorization spec): protected-resource and
 * authorization-server metadata, dynamic client registration, authorization code + PKCE (S256), rotating
 * refresh tokens and revocation. Public clients only. There are no passwords: the owner approves a client
 * by entering a one-time pairing code from the LAN web UI or `agenttaskservice token pair`.
 */

export interface OAuthOptions {
  /** The server's public origin, e.g. https://tasks.example.com. */
  publicUrl: string;
  trustProxy?: boolean;
}

export const SCOPE = "tasks";
const COOKIE = "ats_oauth";
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const TOKEN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Where the protected-resource metadata lives, for WWW-Authenticate on 401s. */
export function resourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource`;
}

function cors(res: ServerResponse): void {
  // Metadata, registration, token and revocation are called by clients from anywhere; none uses cookies.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-protocol-version");
  res.setHeader("access-control-max-age", "600");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  json(res, status, { error, error_description: description });
}

function readText(req: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new OAuthError("invalid_request", "Request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Redirect URIs: https, or http on loopback (native apps). No fragments. Compared exactly. */
export function redirectUriProblem(uri: unknown): string | undefined {
  if (typeof uri !== "string" || uri.length > 2000) return "redirect_uris must be strings (max 2000 characters)";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return `Not a URL: ${uri}`;
  }
  if (u.hash || uri.includes("#")) return "redirect URIs can't have a fragment";
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && isLoopback(u.hostname.replace(/^\[|\]$/g, ""))) return undefined;
  return "redirect URIs must use https (or http on localhost)";
}

interface AuthRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
}

/** Validate an authorization request. `fatal` errors show a page; others go back to the client's redirect URI. */
function parseAuthRequest(
  store: Store,
  p: URLSearchParams,
  publicUrl: string,
): { ok: AuthRequest } | { fatal: string } | { redirect: string; error: string; description: string; state?: string } {
  const client = store.getClient(p.get("client_id") ?? "");
  if (!client) return { fatal: "This app is not registered with the server. Remove the connector and add it again." };
  let redirectUri = p.get("redirect_uri") ?? "";
  if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  if (!client.redirect_uris.includes(redirectUri)) return { fatal: "The redirect address doesn't match the one this app registered." };
  const state = p.get("state") ?? undefined;
  const back = (error: string, description: string) => ({ redirect: redirectUri, error, description, state });
  if (p.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  const challenge = p.get("code_challenge") ?? "";
  if (!CHALLENGE.test(challenge)) return back("invalid_request", "PKCE code_challenge is required");
  if (p.get("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256");
  const resource = p.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== `${publicUrl}/mcp` && resource.replace(/\/+$/, "") !== publicUrl) {
    return back("invalid_target", "Unknown resource");
  }
  return { ok: { clientId: client.id, clientName: client.name, redirectUri, state, codeChallenge: challenge, scope: SCOPE } };
}

function backTo(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  res.writeHead(303, { location: u.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end();
}

function page(res: ServerResponse, status: number, title: string, body: string, extra: { formAction?: string; cookie?: string } = {}): void {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    // form-action also covers the redirect after the form posts, so allow the client's redirect origin.
    "content-security-policy": `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'${extra.formAction ? ` ${extra.formAction}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
  };
  if (extra.cookie) headers["set-cookie"] = extra.cookie;
  res.writeHead(status, headers);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · agenttaskservice</title><link rel="stylesheet" href="/oauth/style.css"></head>
<body><header><b>agenttaskservice</b></header><main>${body}</main></body></html>`);
}

function approvalPage(a: AuthRequest, csrf: string, name: string, error?: string): string {
  const host = new URL(a.redirectUri).host;
  const hidden = { client_id: a.clientId, redirect_uri: a.redirectUri, state: a.state, code_challenge: a.codeChallenge, code_challenge_method: "S256", response_type: "code", csrf };
  const fields = Object.entries(hidden)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${h(v)}">`)
    .join("");
  return `<h1>Connect ${h(a.clientName)}?</h1>
<div class="card"><p><b>${h(a.clientName)}</b> wants to read and change your cross-project tasks. After you approve, you go back to <b>${h(host)}</b>.</p>
<p class="muted">Only approve if you started this from that app just now.</p></div>
${error ? `<p class="err">${h(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">${fields}
<p><label>Pairing code<br><input name="pairing_code" required autocomplete="one-time-code" placeholder="ABCD-2345" maxlength="12"></label></p>
<p class="muted">Create one in the web UI on your local network (Set up a machine), or run <code>agenttaskservice token pair</code> on the server.</p>
<p><label>Name for this connection<br><input name="name" value="${h(name)}" pattern="[A-Za-z0-9._-]{1,64}" maxlength="64" required></label></p>
<p class="muted">It shows in <code>token list</code>; <code>token revoke ${h(name)}</code> disconnects the app.</p>
<p><button class="primary" name="action" value="approve">Approve</button> <button name="action" value="deny">Deny</button></p></form>`;
}

/** A free token name for a new connection: claude-app, claude-app-2, ... */
function suggestName(store: Store, clientName: string): string {
  const base = clientName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "mcp-app";
  const taken = new Set(store.listTokens().filter((t) => !t.revoked_at).map((t) => t.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function createOAuthHandler(store: Store, opts: OAuthOptions, pairLimit: FailureLimit, registerLimit = new FailureLimit(20, 100, 3_600_000)) {
  const { publicUrl } = opts;
  const metadata = {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    revocation_endpoint: `${publicUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
  const resource = {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [publicUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "agenttaskservice",
  };
  const cookieAttrs = `Path=/oauth; HttpOnly; SameSite=Lax${publicUrl.startsWith("https:") ? "; Secure" : ""}`;

  /** Returns true when it handled the request. */
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    const api = path.startsWith("/.well-known/oauth-") || path === "/oauth/register" || path === "/oauth/token" || path === "/oauth/revoke";
    if (!api && path !== "/oauth/authorize" && path !== "/oauth/style.css") return false;
    if (api) {
      cors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return true;
      }
    }
    try {
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, resource);
        return true;
      }
      if (path === "/.well-known/oauth-authorization-server") {
        json(res, 200, metadata);
        return true;
      }
      if (path.startsWith("/.well-known/")) {
        json(res, 404, { error: "not_found" });
        return true;
      }
      if (path === "/oauth/style.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "max-age=3600", "x-content-type-options": "nosniff" });
        res.end(CSS);
        return true;
      }

      if (req.method !== "POST" && path !== "/oauth/authorize") {
        oauthError(res, 405, "invalid_request", "Use POST");
        return true;
      }

      if (path === "/oauth/register") {
        const who = clientKey(req, opts.trustProxy);
        if (registerLimit.blocked(who)) {
          oauthError(res, 429, "invalid_client_metadata", "Too many registrations; try again later");
          return true;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readText(req));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        } catch {
          oauthError(res, 400, "invalid_client_metadata", "Send client metadata as a JSON object");
          return true;
        }
        const uris = body.redirect_uris;
        if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
          oauthError(res, 400, "invalid_redirect_uri", "redirect_uris: 1 to 10 URIs");
          return true;
        }
        for (const u of uris) {
          const problem = redirectUriProblem(u);
          if (problem) {
            oauthError(res, 400, "invalid_redirect_uri", problem);
            return true;
          }
        }
        const grants = (body.grant_types as unknown[] | undefined) ?? ["authorization_code"];
        if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
          oauthError(res, 400, "invalid_client_metadata", "grant_types: authorization_code and refresh_token only");
          return true;
        }
        const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "MCP app";
        registerLimit.fail(who); // counts registrations, successful or not
        const reg = store.registerClient(name, uris as string[]);
        json(res, 201, {
          ...reg,
          client_name: name,
          redirect_uris: uris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: SCOPE,
        });
        return true;
      }

      if (path === "/oauth/token") {
        const form = new URLSearchParams(await readText(req));
        const clientId = form.get("client_id") ?? "";
        if (!store.getClient(clientId)) {
          oauthError(res, 401, "invalid_client", "Unknown client_id");
          return true;
        }
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          json(res, 200, store.exchangeCode(form.get("code") ?? "", clientId, form.get("redirect_uri") ?? "", form.get("code_verifier") ?? ""));
        } else if (grant === "refresh_token") {
          json(res, 200, store.refreshTokens(form.get("refresh_token") ?? "", clientId));
        } else {
          oauthError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
        }
        return true;
      }

      if (path === "/oauth/revoke") {
        const form = new URLSearchParams(await readText(req));
        const token = form.get("token");
        if (!token) {
          oauthError(res, 400, "invalid_request", "token is required");
          return true;
        }
        store.revokeOAuthToken(token);
        json(res, 200, {});
        return true;
      }

      // /oauth/authorize: the approval page (GET) and its form (POST).
      if (req.method !== "GET" && req.method !== "POST") {
        page(res, 405, "Not allowed", "<p>Method not allowed.</p>");
        return true;
      }
      const posted = req.method === "POST" ? new URLSearchParams(await readText(req)) : undefined;
      const params = posted ?? url.searchParams;
      const parsed = parseAuthRequest(store, params, publicUrl);
      if ("fatal" in parsed) {
        page(res, 400, "Can't connect", `<h1>Can't connect</h1><p class="err">${h(parsed.fatal)}</p>`);
        return true;
      }
      if ("redirect" in parsed) {
        backTo(res, parsed.redirect, { error: parsed.error, error_description: parsed.description, state: parsed.state, iss: publicUrl });
        return true;
      }
      const a = parsed.ok;
      const formAction = new URL(a.redirectUri).origin;
      const show = (status: number, name: string, error?: string) => {
        const csrf = randomBytes(18).toString("base64url");
        page(res, status, `Connect ${a.clientName}`, approvalPage(a, csrf, name, error), { formAction, cookie: `${COOKIE}=${csrf}; ${cookieAttrs}; Max-Age=1800` });
      };
      if (!posted) {
        show(200, suggestName(store, a.clientName));
        return true;
      }

      const name = (posted.get("name") ?? "").trim();
      const expected = cookies(req)[COOKIE] ?? "";
      // "Origin: null" comes from our own no-referrer pages; the CSRF cookie still protects those posts.
      const origin = req.headers.origin;
      if (!expected || !sameValue(posted.get("csrf") ?? "", expected) || (origin && origin !== "null" && origin !== new URL(publicUrl).origin)) {
        show(403, name || suggestName(store, a.clientName), "This form expired. Try again.");
        return true;
      }
      if (posted.get("action") === "deny") {
        backTo(res, a.redirectUri, { error: "access_denied", error_description: "The owner denied access", state: a.state, iss: publicUrl });
        return true;
      }
      if (!TOKEN_NAME.test(name)) {
        show(400, suggestName(store, a.clientName), "Name: letters, digits, . _ - (max 64).");
        return true;
      }
      const who = clientKey(req, opts.trustProxy);
      if (pairLimit.blocked(who)) {
        show(429, name, "Too many wrong pairing codes. Try again in a few minutes.");
        return true;
      }
      try {
        const { code } = store.approveClient({
          pairingCode: posted.get("pairing_code") ?? "",
          name,
          clientId: a.clientId,
          redirectUri: a.redirectUri,
          codeChallenge: a.codeChallenge,
          scope: a.scope,
        });
        res.setHeader("set-cookie", `${COOKIE}=; ${cookieAttrs}; Max-Age=0`);
        backTo(res, a.redirectUri, { code, state: a.state, iss: publicUrl });
      } catch (e) {
        if (!(e instanceof TaskError)) throw e;
        if (e.code === "forbidden") pairLimit.fail(who);
        show(e.code === "forbidden" ? 403 : 400, name, e.code === "forbidden" ? "That pairing code is wrong, used or expired." : e.message);
      }
      return true;
    } catch (e) {
      if (e instanceof OAuthError) {
        if (!res.headersSent) oauthError(res, e.error === "invalid_client" ? 401 : 400, e.error, e.message);
        return true;
      }
      throw e;
    }
  };
}
