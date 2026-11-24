// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { createOAuthHandler, resourceMetadataUrl } from "./oauth.js";
import { clientKey, FailureLimit } from "./ratelimit.js";
import { PROJECT_ID, Store, TaskError } from "./store.js";
import { createUiHandler } from "./ui.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (over) return; // keep draining so the 413 reply can be read
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1];
}

export interface Handler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createHandler(store: Store, cfg: Pick<Config, "maxBodyBytes" | "trustProxy" | "publicUrl">, pairLimit = new FailureLimit()): Handler {
  // OAuth shares the pairing limit: the approval page also takes pairing codes.
  const oauth = cfg.publicUrl ? createOAuthHandler(store, { publicUrl: cfg.publicUrl, trustProxy: cfg.trustProxy }, pairLimit) : undefined;
  const challenge = cfg.publicUrl
    ? `Bearer realm="agenttaskservice", resource_metadata="${resourceMetadataUrl(cfg.publicUrl)}"`
    : 'Bearer realm="agenttaskservice"';
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (oauth && (await oauth(req, res, url))) return;

      if (url.pathname === "/health") {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
        return send(res, 200, { status: "ok", service: "agenttaskservice" });
      }

      if (url.pathname === "/v1/pair") {
        // A new machine trades a one-time pairing code for its own token. No bearer token needed.
        if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
        const who = clientKey(req, cfg.trustProxy);
        if (pairLimit.blocked(who)) return send(res, 429, { error: "rate_limited", message: "Too many failed pairing attempts; try again later" });
        let body: { code?: unknown; name?: unknown };
        try {
          body = JSON.parse(await readBody(req, 4096));
        } catch {
          return send(res, 400, { error: "invalid", message: "Send JSON: {\"code\": \"...\", \"name\": \"...\"}" });
        }
        if (typeof body.code !== "string" || (body.name !== undefined && typeof body.name !== "string")) {
          return send(res, 400, { error: "invalid", message: "code (and optional name) must be strings" });
        }
        try {
          return send(res, 200, store.redeemPairing(body.code, body.name as string | undefined));
        } catch (e) {
          if (e instanceof TaskError && e.code === "forbidden") pairLimit.fail(who);
          throw e;
        }
      }

      const token = bearer(req);
      const actor = token ? store.authenticate(token) : undefined;
      if (!actor) {
        res.setHeader("www-authenticate", challenge);
        return send(res, 401, { error: "unauthorized", message: "A valid bearer token is required" });
      }

      if (url.pathname === "/v1/inbox") {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
        const project = url.searchParams.get("project") ?? "";
        if (!PROJECT_ID.test(project)) return send(res, 400, { error: "invalid", message: "Query parameter project is required" });
        store.ensureProject(project);
        const tasks = store.listInbox(project);
        const completed = store.takeUnseenCompletions(project);
        return send(res, 200, { project, tasks, completed });
      }

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          return send(res, 405, { error: "method_not_allowed", message: "This server is stateless: use POST" });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req, cfg.maxBodyBytes));
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            res.setHeader("connection", "close");
            res.on("finish", () => req.destroy());
            return send(res, 413, { error: "too_large" });
          }
          return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        }
        const server = createMcpServer(store, actor);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }

      return send(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof TaskError) {
        const status = { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 }[e.code];
        return send(res, status, { error: e.code, message: e.message });
      }
      console.error("request failed:", e instanceof Error ? e.message : e);
      if (!res.headersSent) send(res, 500, { error: "internal" });
    }
  };
}

function listen(handler: Handler, cfg: Config, port: number, host: string): http.Server | https.Server {
  const listener = (req: IncomingMessage, res: ServerResponse) => void handler(req, res);
  const server =
    cfg.tlsCert && cfg.tlsKey
      ? https.createServer({ cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) }, listener)
      : http.createServer(listener);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(port, host);
  return server;
}

export function startServer(store: Store, cfg: Config): http.Server | https.Server {
  return listen(createHandler(store, cfg), cfg, cfg.port, cfg.host);
}

/** The web UI on its own port. Keep it off the public proxy route: it is meant for the local network. */
export function startUi(store: Store, cfg: Config): http.Server | https.Server | undefined {
  if (!cfg.ui) return undefined;
  return listen(createUiHandler(store, { secure: Boolean(cfg.tlsCert), apiUrl: cfg.ui.apiUrl, repoUrl: cfg.ui.repoUrl }), cfg, cfg.ui.port, cfg.ui.host);
}
