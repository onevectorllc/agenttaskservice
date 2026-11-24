// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { FailureLimit } from "./ratelimit.js";
import { PROJECT_ID, Store, TaskError, type Task } from "./store.js";

/**
 * The web UI: server-rendered HTML, no JavaScript, strict CSP. It runs on its own listener
 * (see startUi) so that a proxy forwarding only the API port never exposes it.
 * Task text comes from other machines: every value is HTML-escaped.
 */

export interface UiOptions {
  /** Served over https: mark the session cookie Secure. */
  secure: boolean;
  /** API URL for the setup guide's commands. */
  apiUrl?: string;
  /** git clone URL for the setup guide's install step. */
  repoUrl?: string;
}

const COOKIE = "ats_ui";
/** Pre-sign-in CSRF value (double-submit cookie) for the login form. */
const LOGIN_COOKIE = "ats_login";
const SESSION_SECONDS = 12 * 3600;
const STATUSES = ["open", "claimed", "done", "rejected", "cancelled"] as const;
type Status = (typeof STATUSES)[number];

const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--accent:#1d4ed8;--ok:#15803d;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#93c5fd;--ok:#86efac;--warn:#fcd34d;--bad:#fca5a5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header b{margin-right:auto}header a{color:var(--fg)}main{max-width:960px;margin:0 auto;padding:16px}
a{color:var(--accent)}h1{font-size:1.4em;margin:.2em 0 .6em}h2{font-size:1.1em;margin:1.4em 0 .4em}
table{width:100%;border-collapse:collapse;background:var(--card)}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.9em}.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.tag{display:inline-block;padding:0 6px;border-radius:4px;border:1px solid var(--line);font-size:.85em}
.open{color:var(--accent)}.claimed{color:var(--warn)}.done{color:var(--ok)}.rejected,.cancelled{color:var(--bad)}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);padding:10px;border-radius:6px;overflow-x:auto}
form.inline{display:inline}button,input{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button{cursor:pointer}button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.code{font-size:1.6em;letter-spacing:.1em;font-weight:700}ol.steps>li{margin:0 0 16px}nav.tabs a{margin-right:12px}
.err{color:var(--bad)}.table-wrap{overflow-x:auto}
`;

export function h(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function headers(res: ServerResponse, status: number, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
}

function page(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  session?: { csrf: string; token_name: string },
  extra: Record<string, string> = {},
): void {
  const nav = session
    ? `<a href="/ui/">Projects</a><a href="/ui/setup">Set up a machine</a>
       <span class="muted">${h(session.token_name)}</span>
       <form class="inline" method="post" action="/ui/logout"><input type="hidden" name="csrf" value="${h(session.csrf)}"><button>Sign out</button></form>`
    : "";
  headers(res, status, "text/html; charset=utf-8", extra);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · agenttaskservice</title><link rel="stylesheet" href="/ui/style.css"></head>
<body><header><b>agenttaskservice</b>${nav}</header><main>${body}</main></body></html>`);
}

function redirect(res: ServerResponse, to: string, extra: Record<string, string> = {}): void {
  headers(res, 303, "text/plain; charset=utf-8", { location: to, ...extra });
  res.end();
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim()) ?? "";
  }
  return out;
}

/** decodeURIComponent that returns undefined for a malformed escape instead of throwing. */
function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function readForm(req: IncomingMessage, limit = 8192): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new TaskError("invalid", "Form too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A form post must come from this site: matching Origin (when sent) and the session's CSRF token. */
function postAllowed(req: IncomingMessage, form: URLSearchParams, csrf: string): boolean {
  return sameOrigin(req) && csrf !== "" && sameValue(form.get("csrf") ?? "", csrf);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function when(iso: string | null | undefined): string {
  if (!iso) return '<span class="muted">never</span>';
  return `<time datetime="${h(iso)}">${h(iso.replace("T", " ").slice(0, 16))} UTC</time>`;
}

function status(s: string): string {
  return `<span class="tag ${h(s)}">${h(s)}</span>`;
}

const PRIORITY = ["", "high", "normal", "low"];

function taskRows(tasks: Task[], other: "from_project" | "to_project"): string {
  if (!tasks.length) return '<p class="muted">No tasks.</p>';
  const rows = tasks
    .map(
      (t) => `<tr><td><a href="/ui/t/${encodeURIComponent(t.id)}">${h(t.id)}</a></td><td>${h(t.title)}</td>
<td>${h(t[other])}</td><td>${status(t.status)}${t.claimed_by ? ` <span class="muted">${h(t.claimed_by)}</span>` : ""}</td>
<td>${h(PRIORITY[t.priority] ?? t.priority)}</td><td>${when(t.updated_at)}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Title</th><th>${other === "from_project" ? "From" : "To"}</th><th>Status</th><th>Priority</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function setupPage(store: Store, opts: UiOptions, csrf: string, pairing?: { code: string; expires_at: string; name?: string }, error?: string): string {
  const url = opts.apiUrl ?? "<server URL>";
  const repo = opts.repoUrl ?? "<repository URL>";
  const tokens = store.listTokens().filter((t) => !t.revoked_at);
  const machines = tokens
    .map((t) => `<tr><td>${h(t.name)}</td><td>${when(t.last_used_at)}</td><td>${when(t.created_at)}</td></tr>`)
    .join("");
  const nameArg = pairing?.name ? "" : " --name <this-machine>";
  const code = pairing
    ? `<div class="card"><p>Pairing code${pairing.name ? ` for <b>${h(pairing.name)}</b>` : ""}, valid until ${when(pairing.expires_at)}, single use:</p>
<p class="code">${h(pairing.code)}</p></div>`
    : "";
  return `<h1>Set up a machine</h1>
<p class="muted">Connect a computer that runs Claude Code. Each machine gets its own token, which you can revoke on its own. Nobody has to copy a token: the machine trades a short pairing code for one.</p>
<ol class="steps">
<li><b>Check the server address.</b> Clients use the API at <code>${h(url)}</code>.${opts.apiUrl ? "" : ' <span class="err">Set <code>ui.api_url</code> in server.toml so this guide can show it.</span>'}</li>
<li><b>Create a pairing code</b> (valid for 10 minutes, works once).
<form method="post" action="/ui/setup/pair"><input type="hidden" name="csrf" value="${h(csrf)}">
<label>Machine name <input name="name" placeholder="laptop" pattern="[A-Za-z0-9._-]{1,64}" maxlength="64"></label>
<button class="primary">Create code</button></form>${error ? `<p class="err">${h(error)}</p>` : ""}${code}</li>
<li><b>On the new machine</b>, install it (Node.js 22 or newer) and connect:
<pre>git clone ${h(repo)} agenttaskservice
cd agenttaskservice &amp;&amp; npm ci &amp;&amp; npm run build &amp;&amp; npm install -g .
agenttaskservice init --url ${h(url)} --pair ${h(pairing?.code ?? "<code>")}${h(nameArg)} --rule</pre>
<p class="muted"><code>init</code> lists what it will change and asks first. It stores the token in the system keychain where there is one, registers the server with Claude Code, adds the session-start hook, and with <code>--rule</code> adds a short task rule to <code>~/.claude/CLAUDE.md</code>.</p></li>
<li><b>Check it.</b> Run <code>agenttaskservice whoami</code> in a project folder. The machine shows up below once it has talked to the server.
<div class="table-wrap"><table><thead><tr><th>Machine (token)</th><th>Last seen</th><th>Created</th></tr></thead><tbody>${machines || '<tr><td colspan="3" class="muted">None yet.</td></tr>'}</tbody></table></div></li>
<li><b>Optional.</b> For an inbox that one machine handles on a schedule, add <code>--watch &lt;project&gt;</code> and <code>--work &lt;project&gt; --every 60 --work-dir &lt;folder&gt;</code> to <code>init</code> on that machine. See the README.</li>
</ol>`;
}

export function createUiHandler(store: Store, opts: UiOptions, limit = new FailureLimit()) {
  const cookieAttrs = `Path=/ui; HttpOnly; SameSite=Strict${opts.secure ? "; Secure" : ""}`;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path === "/" || path === "/ui") return redirect(res, "/ui/");
      if (path === "/ui/style.css") {
        headers(res, 200, "text/css; charset=utf-8", { "cache-control": "max-age=3600" });
        return void res.end(CSS);
      }

      if (path === "/ui/login") {
        // The UI is reached directly on the LAN, so the peer address is the browser's.
        const who = req.socket.remoteAddress ?? "unknown";
        const fresh = () => randomBytes(18).toString("base64url");
        const showForm = (status: number, error?: string) => {
          const value = fresh();
          return page(res, status, "Sign in", loginForm(value, error), undefined, { "set-cookie": `${LOGIN_COOKIE}=${value}; ${cookieAttrs}; Max-Age=3600` });
        };
        if (req.method === "POST") {
          if (limit.blocked(who)) return showForm(429, "Too many failed attempts. Try again in a few minutes.");
          const form = await readForm(req);
          const expected = cookies(req)[LOGIN_COOKIE] ?? "";
          if (!sameOrigin(req) || !expected || !sameValue(form.get("csrf") ?? "", expected)) return showForm(403, "This form expired. Try again.");
          const name = store.authenticate((form.get("token") ?? "").trim());
          if (!name) {
            limit.fail(who);
            return showForm(401, "That token is not valid or was revoked.");
          }
          const s = store.createSession(name, SESSION_SECONDS / 3600);
          res.setHeader("set-cookie", [`${COOKIE}=${s.sid}; ${cookieAttrs}; Max-Age=${SESSION_SECONDS}`, `${LOGIN_COOKIE}=; ${cookieAttrs}; Max-Age=0`]);
          return redirect(res, "/ui/");
        }
        return showForm(200);
      }

      const sid = cookies(req)[COOKIE];
      const session = sid ? store.getSession(sid) : undefined;
      if (!session) return redirect(res, "/ui/login");

      if (req.method === "POST") {
        const form = await readForm(req);
        if (!postAllowed(req, form, session.csrf)) return page(res, 403, "Not allowed", '<p class="err">This form expired. Go back and try again.</p>', session);
        if (path === "/ui/logout") {
          store.deleteSession(sid!);
          return redirect(res, "/ui/login", { "set-cookie": `${COOKIE}=; ${cookieAttrs}; Max-Age=0` });
        }
        if (path === "/ui/setup/pair") {
          const name = (form.get("name") ?? "").trim() || undefined;
          try {
            const p = store.createPairing(session.token_name, { name });
            return page(res, 200, "Set up a machine", setupPage(store, opts, session.csrf, { ...p, name }), session);
          } catch (e) {
            if (e instanceof TaskError) return page(res, 400, "Set up a machine", setupPage(store, opts, session.csrf, undefined, e.message), session);
            throw e;
          }
        }
        return page(res, 404, "Not found", "<p>Not found.</p>", session);
      }

      if (req.method !== "GET") return page(res, 405, "Not allowed", "<p>Method not allowed.</p>", session);

      if (path === "/ui/") {
        const rows = store
          .projectSummary()
          .map(
            (p) => `<tr><td><a href="/ui/p/${encodeURIComponent(p.id)}">${h(p.id)}</a>${p.name && p.name !== p.id ? ` <span class="muted">${h(p.name)}</span>` : ""}
<div class="muted">${h(p.description)}</div></td><td class="num">${p.inbox_open}</td><td class="num">${p.inbox_claimed}</td><td class="num">${p.sent_active}</td></tr>`,
          )
          .join("");
        return page(
          res,
          200,
          "Projects",
          `<h1>Projects</h1><div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Open</th><th class="num">In progress</th><th class="num">Sent, not finished</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="muted">No projects yet.</td></tr>'}</tbody></table></div>`,
          session,
        );
      }

      const pm = /^\/ui\/p\/([^/]+)$/.exec(path);
      if (pm) {
        const id = safeDecode(pm[1]) ?? "";
        if (!PROJECT_ID.test(id)) return page(res, 404, "Not found", "<p>No such project.</p>", session);
        const view = url.searchParams.get("view") === "sent" ? "sent" : "inbox";
        const asked = url.searchParams.get("show") ?? "active";
        const show = asked === "all" || (STATUSES as readonly string[]).includes(asked) ? asked : "active";
        const statuses: Status[] = show === "all" ? [...STATUSES] : show === "active" ? ["open", "claimed"] : [show as Status];
        const tasks = view === "sent" ? store.listSent(id, statuses) : store.listInbox(id, statuses);
        const link = (v: string, s: string, label: string, on: boolean) =>
          on ? `<b>${label}</b>` : `<a href="/ui/p/${encodeURIComponent(id)}?view=${v}&amp;show=${s}">${label}</a>`;
        return page(
          res,
          200,
          id,
          `<h1>${h(id)}</h1><nav class="tabs">${link("inbox", show, "Received", view === "inbox")}${link("sent", show, "Sent", view === "sent")}
<span class="muted">·</span> ${link(view, "active", "Not finished", show === "active")}${STATUSES.map((st) => link(view, st, st, show === st)).join("")}${link(view, "all", "All", show === "all")}</nav>
${taskRows(tasks, view === "sent" ? "to_project" : "from_project")}`,
          session,
        );
      }

      const tm = /^\/ui\/t\/([^/]+)$/.exec(path);
      if (tm) {
        const tid = safeDecode(tm[1]);
        if (!tid) return page(res, 404, "Not found", "<p>No such task.</p>", session);
        const { task: t, events } = store.getTask(tid);
        const history = events
          .map((e) => `<tr><td>${when(e.at)}</td><td>${h(e.kind)}</td><td>${h(e.actor)}</td><td>${e.text ? `<pre>${h(e.text)}</pre>` : ""}</td></tr>`)
          .join("");
        return page(
          res,
          200,
          t.id,
          `<h1>${h(t.id)} · ${h(t.title)}</h1>
<p>${status(t.status)} <span class="muted">from</span> <a href="/ui/p/${encodeURIComponent(t.from_project)}?view=sent">${h(t.from_project)}</a>
<span class="muted">to</span> <a href="/ui/p/${encodeURIComponent(t.to_project)}">${h(t.to_project)}</a> · ${h(PRIORITY[t.priority] ?? t.priority)} priority · version ${h(t.version)}
${t.claimed_by ? ` · claimed by ${h(t.claimed_by)} until ${when(t.lease_until)}` : ""}</p>
${t.body ? `<h2>Details</h2><pre>${h(t.body)}</pre>` : ""}${t.result ? `<h2>Result</h2><pre>${h(t.result)}</pre>` : ""}
<h2>History</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Who</th><th>Text</th></tr></thead><tbody>${history}</tbody></table></div>`,
          session,
        );
      }

      if (path === "/ui/setup") return page(res, 200, "Set up a machine", setupPage(store, opts, session.csrf), session);

      return page(res, 404, "Not found", "<p>Not found.</p>", session);
    } catch (e) {
      if (e instanceof TaskError) {
        const code = e.code === "not_found" ? 404 : 400;
        if (!res.headersSent) return page(res, code, "Error", `<p class="err">${h(e.message)}</p>`);
        return;
      }
      console.error("ui request failed:", e instanceof Error ? e.message : e);
      if (!res.headersSent) page(res, 500, "Error", '<p class="err">Something went wrong.</p>');
    }
  };
}

function loginForm(csrf: string, error?: string): string {
  return `<h1>Sign in</h1><p class="muted">Paste a token from <code>agenttaskservice token add &lt;name&gt;</code>. You stay signed in for 12 hours on this browser.</p>
${error ? `<p class="err">${h(error)}</p>` : ""}<form method="post" action="/ui/login"><input type="hidden" name="csrf" value="${h(csrf)}">
<p><input type="password" name="token" autocomplete="off" required size="48" aria-label="Token"></p><p><button class="primary">Sign in</button></p></form>`;
}
