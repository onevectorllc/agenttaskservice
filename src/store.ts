// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.js";

export type Status = "open" | "claimed" | "done" | "rejected" | "cancelled";

export interface Task {
  id: string;
  client_key: string;
  from_project: string;
  to_project: string;
  title: string;
  body: string;
  status: Status;
  priority: number;
  claimed_by: string | null;
  lease_until: string | null;
  result: string | null;
  parent_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

export interface TaskEvent {
  seq: number;
  kind: string;
  actor: string;
  text: string;
  at: string;
}

export interface Project {
  id: string;
  name: string;
  aliases: string[];
  description: string;
}

/** An expected failure that callers can show to the client as-is. */
export class TaskError extends Error {
  constructor(
    public code: "not_found" | "invalid" | "conflict" | "forbidden",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const TASK_COLUMNS =
  "id, client_key, from_project, to_project, title, body, status, priority, claimed_by, lease_until, result, parent_id, version, created_at, updated_at, done_at";

export interface StoreOptions {
  leaseMs?: number;
  now?: () => Date;
}

export class Store {
  private leaseMs: number;
  private now: () => Date;

  constructor(
    private db: DB,
    opts: StoreOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 4 * 60 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** A claimed task whose lease has passed is open again. */
  private effective(t: Task): Task {
    if (t.status === "claimed" && t.lease_until !== null && t.lease_until <= this.iso()) {
      return { ...t, status: "open", claimed_by: null, lease_until: null };
    }
    return t;
  }

  private row(id: string): Task | undefined {
    return this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as Task | undefined;
  }

  private mustGet(id: string): Task {
    const t = this.row(id);
    if (!t) throw new TaskError("not_found", `No task ${id}`);
    return this.effective(t);
  }

  private event(taskId: string, kind: string, actor: string, text = ""): void {
    this.db
      .prepare("INSERT INTO task_events (task_id, kind, actor, text, at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, kind, actor, text, this.iso());
  }

  private checkVersion(t: Task, version: number): void {
    if (!Number.isInteger(version)) throw new TaskError("invalid", "version is required: pass the version of the task you last read");
    if (version !== t.version) {
      throw new TaskError("conflict", `Task ${t.id} changed: you have version ${version}, current is ${t.version}`, {
        task: t,
      });
    }
  }

  /** While a live claim exists, only its holder may finish, release or renew it. */
  private holds(t: Task, actor: string, session?: string): boolean {
    if (t.status !== "claimed" || !t.claimed_by) return true;
    if (session) return t.claimed_by === `${actor}/${session}`;
    return t.claimed_by === actor || t.claimed_by.startsWith(`${actor}/`);
  }

  private mustHold(t: Task, actor: string, session?: string): void {
    if (!this.holds(t, actor, session)) {
      throw new TaskError("conflict", `Task ${t.id} is claimed by ${t.claimed_by}`, { task: t });
    }
  }

  private write(t: Task, fields: Partial<Task>): Task {
    const merged = { ...t, ...fields, version: t.version + 1, updated_at: this.iso() };
    const res = this.db
      .prepare(
        `UPDATE tasks SET status=@status, claimed_by=@claimed_by, lease_until=@lease_until, result=@result,
           done_at=@done_at, version=@version, updated_at=@updated_at, sender_seen_at=NULL
         WHERE id=@id AND version=@old`,
      )
      .run({ ...merged, old: t.version });
    if (res.changes !== 1) throw new TaskError("conflict", `Task ${t.id} changed while updating; read it again`);
    return this.mustGet(t.id);
  }

  // ---- projects ----

  ensureProject(id: string): void {
    if (!PROJECT_ID.test(id)) {
      throw new TaskError("invalid", `Project id must match ${PROJECT_ID} (lowercase letters, digits, . _ -)`);
    }
    this.db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)").run(id, id);
  }

  upsertProject(p: { id: string; name?: string; description?: string; aliases?: string[] }): Project {
    this.ensureProject(p.id);
    const cur = this.getProject(p.id)!;
    this.db
      .prepare("UPDATE projects SET name = ?, description = ?, aliases = ? WHERE id = ?")
      .run(p.name ?? cur.name, p.description ?? cur.description, JSON.stringify(p.aliases ?? cur.aliases), p.id);
    return this.getProject(p.id)!;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT id, name, aliases, description FROM projects WHERE id = ?").get(id) as
      | { id: string; name: string; aliases: string; description: string }
      | undefined;
    return r && { ...r, aliases: JSON.parse(r.aliases) as string[] };
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT id, name, aliases, description FROM projects ORDER BY id").all() as {
      id: string;
      name: string;
      aliases: string;
      description: string;
    }[];
    return rows.map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[] }));
  }

  /** Resolve an id or alias to a known project id. */
  resolveProject(nameOrAlias: string): string | undefined {
    if (this.getProject(nameOrAlias)) return nameOrAlias;
    const needle = nameOrAlias.toLowerCase();
    return this.listProjects().find((p) => p.aliases.some((a) => a.toLowerCase() === needle))?.id;
  }

  // ---- tasks ----

  createTask(
    actor: string,
    input: {
      from_project: string;
      to_project: string;
      title: string;
      body?: string;
      priority?: number;
      client_key?: string;
      parent_id?: string;
    },
  ): { task: Task; created: boolean } {
    return this.db.transaction(() => {
      this.ensureProject(input.from_project);
      const to = this.resolveProject(input.to_project);
      if (!to) {
        throw new TaskError("not_found", `Unknown project ${input.to_project}`, {
          known_projects: this.listProjects().map((p) => p.id),
        });
      }
      const title = input.title.trim();
      if (!title) throw new TaskError("invalid", "Title is required");
      const priority = input.priority ?? 2;
      if (![1, 2, 3].includes(priority)) throw new TaskError("invalid", "Priority must be 1, 2 or 3");
      if (input.parent_id && !this.row(input.parent_id)) throw new TaskError("not_found", `No task ${input.parent_id}`);

      const key = input.client_key ?? randomBytes(16).toString("hex");
      const existing = this.db.prepare("SELECT id FROM tasks WHERE client_key = ?").get(key) as { id: string } | undefined;
      if (existing) return { task: this.mustGet(existing.id), created: false };

      const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tasks").get() as { n: number }).n;
      const id = `T-${String(seq).padStart(4, "0")}`;
      const now = this.iso();
      this.db
        .prepare(
          `INSERT INTO tasks (id, seq, client_key, from_project, to_project, title, body, priority, parent_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, seq, key, input.from_project, to, title, input.body ?? "", priority, input.parent_id ?? null, now, now);
      this.event(id, "created", actor, `${input.from_project} -> ${to}`);
      return { task: this.mustGet(id), created: true };
    })();
  }

  getTask(id: string): { task: Task; events: TaskEvent[] } {
    const task = this.mustGet(id);
    const events = this.db
      .prepare("SELECT seq, kind, actor, text, at FROM task_events WHERE task_id = ? ORDER BY seq")
      .all(id) as TaskEvent[];
    return { task, events };
  }

  /** Tasks addressed to a project. Default: open and claimed. */
  listInbox(project: string, statuses: Status[] = ["open", "claimed"]): Task[] {
    const rows = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE to_project = ? ORDER BY priority, seq`)
      .all(project) as Task[];
    return rows.map((t) => this.effective(t)).filter((t) => statuses.includes(t.status));
  }

  /** Tasks a project sent to others. Default: all statuses. */
  listSent(project: string, statuses?: Status[]): Task[] {
    const rows = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE from_project = ? ORDER BY seq DESC`)
      .all(project) as Task[];
    return rows.map((t) => this.effective(t)).filter((t) => !statuses || statuses.includes(t.status));
  }

  claimTask(actor: string, project: string, id: string, version: number, session?: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (t.to_project !== project) throw new TaskError("forbidden", `Task ${id} is for ${t.to_project}, not ${project}`);
      this.checkVersion(t, version);
      if (t.status !== "open") throw new TaskError("conflict", `Task ${id} is ${t.status}`, { task: t });
      const who = session ? `${actor}/${session}` : actor;
      const out = this.write(t, { status: "claimed", claimed_by: who, lease_until: this.iso(this.leaseMs) });
      this.event(id, "claimed", who);
      return out;
    })();
  }

  /** Anyone may note a task; only the claim holder's note renews the lease. */
  addNote(actor: string, id: string, text: string, session?: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (!text.trim()) throw new TaskError("invalid", "Note text is required");
      const who = session ? `${actor}/${session}` : actor;
      this.event(id, "note", who, text);
      if (t.status === "claimed" && this.holds(t, actor, session)) return this.write(t, { lease_until: this.iso(this.leaseMs) });
      return t;
    })();
  }

  releaseTask(actor: string, project: string, id: string, version: number, session?: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (t.to_project !== project) throw new TaskError("forbidden", `Task ${id} is for ${t.to_project}, not ${project}`);
      this.checkVersion(t, version);
      if (t.status !== "claimed") throw new TaskError("conflict", `Task ${id} is ${t.status}`, { task: t });
      this.mustHold(t, actor, session);
      const out = this.write(t, { status: "open", claimed_by: null, lease_until: null });
      this.event(id, "released", session ? `${actor}/${session}` : actor);
      return out;
    })();
  }

  completeTask(actor: string, project: string, id: string, version: number, result: string, session?: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (t.to_project !== project) throw new TaskError("forbidden", `Task ${id} is for ${t.to_project}, not ${project}`);
      this.checkVersion(t, version);
      this.mustHold(t, actor, session);
      if (!result.trim()) throw new TaskError("invalid", "A result is required to complete a task");
      if (t.status !== "open" && t.status !== "claimed") {
        throw new TaskError("conflict", `Task ${id} is already ${t.status}`, { task: t });
      }
      const out = this.write(t, { status: "done", result, done_at: this.iso(), lease_until: null });
      this.event(id, "completed", session ? `${actor}/${session}` : actor, result);
      return out;
    })();
  }

  /**
   * The receiver rejects (only the claim holder while a claim is live), or the
   * sender cancels its own task, which ends any live claim: the sender owns the request.
   */
  rejectTask(actor: string, project: string, id: string, reason: string, version: number, session?: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      const isReceiver = t.to_project === project;
      const isSender = t.from_project === project;
      if (!isReceiver && !isSender) throw new TaskError("forbidden", `Task ${id} does not involve ${project}`);
      this.checkVersion(t, version);
      if (!reason.trim()) throw new TaskError("invalid", "A reason is required");
      if (t.status !== "open" && t.status !== "claimed") {
        throw new TaskError("conflict", `Task ${id} is already ${t.status}`, { task: t });
      }
      if (isReceiver) this.mustHold(t, actor, session);
      const status: Status = isReceiver ? "rejected" : "cancelled";
      const out = this.write(t, { status, result: reason, done_at: this.iso(), lease_until: null });
      this.event(id, status === "rejected" ? "rejected" : "cancelled", session ? `${actor}/${session}` : actor, reason);
      return out;
    })();
  }

  /** Done or rejected tasks this project sent that it has not been shown yet; marks them seen. */
  takeUnseenCompletions(project: string): Task[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks
           WHERE from_project = ? AND status IN ('done','rejected') AND sender_seen_at IS NULL ORDER BY seq`,
        )
        .all(project) as Task[];
      const mark = this.db.prepare("UPDATE tasks SET sender_seen_at = ? WHERE id = ?");
      for (const t of rows) mark.run(this.iso(), t.id);
      return rows;
    })();
  }

  // ---- tokens ----

  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /** Create a token. The plain value is returned once and never stored. */
  addToken(name: string): string {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new TaskError("invalid", "Token name: letters, digits, . _ - (max 64)");
    const token = `ats_${randomBytes(32).toString("base64url")}`;
    const existing = this.db.prepare("SELECT name, revoked_at FROM tokens WHERE name = ?").get(name) as
      | { name: string; revoked_at: string | null }
      | undefined;
    if (existing && existing.revoked_at === null) throw new TaskError("conflict", `Token ${name} already exists`);
    this.db
      .prepare(
        "INSERT INTO tokens (name, hash, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at, revoked_at = NULL",
      )
      .run(name, Store.hashToken(token), this.iso());
    return token;
  }

  revokeToken(name: string): boolean {
    return this.db.transaction(() => {
      // Sign the token's browsers out too; sessions are also bound to the token itself (see getSession).
      this.db.prepare("DELETE FROM ui_sessions WHERE token_name = ?").run(name);
      this.db.prepare("DELETE FROM oauth_tokens WHERE token_name = ?").run(name);
      this.db.prepare("DELETE FROM oauth_codes WHERE token_name = ?").run(name);
      return this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(this.iso(), name).changes === 1;
    })();
  }

  listTokens(): { name: string; created_at: string; revoked_at: string | null; last_used_at: string | null }[] {
    return this.db.prepare("SELECT name, created_at, revoked_at, last_used_at FROM tokens ORDER BY name").all() as {
      name: string;
      created_at: string;
      revoked_at: string | null;
      last_used_at: string | null;
    }[];
  }

  countActiveTokens(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  /** Returns the token's name when it is valid and not revoked, and records when it was last used (at most once a minute). */
  authenticate(token: string): string | undefined {
    const r = (
      token.startsWith(ACCESS_PREFIX)
        ? this.db
            .prepare(
              `SELECT t.name, t.last_used_at FROM oauth_tokens o JOIN tokens t ON t.name = o.token_name AND t.hash = o.token_hash
               WHERE o.hash = ? AND o.kind = 'access' AND o.expires_at > ? AND t.revoked_at IS NULL`,
            )
            .get(Store.hashToken(token), this.iso())
        : this.db.prepare("SELECT name, last_used_at FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(Store.hashToken(token))
    ) as { name: string; last_used_at: string | null } | undefined;
    if (!r) return undefined;
    const now = this.now().getTime();
    if (!r.last_used_at || now - Date.parse(r.last_used_at) > 60_000) {
      this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE name = ?").run(new Date(now).toISOString(), r.name);
    }
    return r.name;
  }

  // ---- pairing codes ----

  /** A one-time code that a new machine exchanges for its own token. Only the hash is stored. */
  createPairing(createdBy: string, opts: { name?: string; minutes?: number } = {}): { code: string; expires_at: string } {
    if (opts.name !== undefined && !TOKEN_NAME.test(opts.name)) throw new TaskError("invalid", "Token name: letters, digits, . _ - (max 64)");
    const minutes = opts.minutes ?? 10;
    if (!(minutes >= 1 && minutes <= 60)) throw new TaskError("invalid", "A pairing code lasts 1 to 60 minutes");
    const code = pairingCode();
    const expires_at = new Date(this.now().getTime() + minutes * 60_000).toISOString();
    this.db
      .prepare("INSERT INTO pairings (hash, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(Store.hashToken(normalisePairingCode(code)), opts.name ?? null, createdBy, this.iso(), expires_at);
    return { code, expires_at };
  }

  /** Exchange a pairing code for a new token. The code works once, before it expires. */
  redeemPairing(code: string, name?: string): { name: string; token: string } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT name, expires_at, used_at FROM pairings WHERE hash = ?").get(Store.hashToken(normalisePairingCode(code))) as
        | { name: string | null; expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.used_at || row.expires_at <= this.iso()) throw new TaskError("forbidden", "Invalid or expired pairing code");
      const tokenName = row.name ?? name;
      if (!tokenName) throw new TaskError("invalid", "Give the new token a name");
      const token = this.addToken(tokenName);
      this.db
        .prepare("UPDATE pairings SET used_at = ?, used_for = ? WHERE hash = ?")
        .run(this.iso(), tokenName, Store.hashToken(normalisePairingCode(code)));
      return { name: tokenName, token };
    })();
  }

  // ---- web UI sessions ----

  createSession(tokenName: string, hours = 12): { sid: string; csrf: string } {
    const sid = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const now = this.now().getTime();
    this.db.prepare("DELETE FROM ui_sessions WHERE expires_at <= ?").run(new Date(now).toISOString());
    const token = this.db.prepare("SELECT hash FROM tokens WHERE name = ? AND revoked_at IS NULL").get(tokenName) as { hash: string } | undefined;
    if (!token) throw new TaskError("forbidden", "No active token with that name");
    this.db
      .prepare("INSERT INTO ui_sessions (hash, token_name, token_hash, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Store.hashToken(sid), tokenName, token.hash, csrf, new Date(now).toISOString(), new Date(now + hours * 3_600_000).toISOString());
    return { sid, csrf };
  }

  /** A live session whose token is still active, or undefined. Bound to the token itself, so a new token under a reused name never revives old sessions. */
  getSession(sid: string): { token_name: string; csrf: string } | undefined {
    return this.db
      .prepare(
        `SELECT s.token_name, s.csrf FROM ui_sessions s JOIN tokens t ON t.name = s.token_name AND t.hash = s.token_hash
         WHERE s.hash = ? AND s.expires_at > ? AND t.revoked_at IS NULL`,
      )
      .get(Store.hashToken(sid), this.iso()) as { token_name: string; csrf: string } | undefined;
  }

  deleteSession(sid: string): void {
    this.db.prepare("DELETE FROM ui_sessions WHERE hash = ?").run(Store.hashToken(sid));
  }

  // ---- OAuth (Claude app connector) ----

  /** Dynamic client registration. Public clients only (PKCE, no secret). Unused registrations are pruned. */
  registerClient(name: string, redirectUris: string[]): { client_id: string; client_id_issued_at: number } {
    return this.db.transaction(() => {
      const now = this.now().getTime();
      const count = () => (this.db.prepare("SELECT count(*) AS n FROM oauth_clients").get() as { n: number }).n;
      if (count() >= MAX_CLIENTS) {
        this.db
          .prepare("DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < ?")
          .run(new Date(now - 24 * 3_600_000).toISOString());
      }
      if (count() >= MAX_CLIENTS) throw new OAuthError("invalid_client_metadata", "Too many registered clients; try again tomorrow");
      const id = `atc_${randomBytes(16).toString("base64url")}`;
      this.db
        .prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
        .run(id, name, JSON.stringify(redirectUris), new Date(now).toISOString());
      return { client_id: id, client_id_issued_at: Math.floor(now / 1000) };
    })();
  }

  getClient(id: string): { id: string; name: string; redirect_uris: string[] } | undefined {
    const r = this.db.prepare("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?").get(id) as
      | { id: string; name: string; redirect_uris: string }
      | undefined;
    return r && { id: r.id, name: r.name, redirect_uris: JSON.parse(r.redirect_uris) as string[] };
  }

  /**
   * The owner approved a client with a pairing code: create the connection's token row (its secret is never shown;
   * the app only gets OAuth tokens bound to it) and a one-time authorization code.
   */
  approveClient(input: {
    pairingCode: string;
    name?: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
  }): { code: string; name: string } {
    return this.db.transaction(() => {
      const { name, token } = this.redeemPairing(input.pairingCode, input.name);
      const code = randomBytes(32).toString("base64url");
      this.db
        .prepare(
          `INSERT INTO oauth_codes (hash, client_id, redirect_uri, code_challenge, token_name, token_hash, scope, expires_at, grant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Store.hashToken(code),
          input.clientId,
          input.redirectUri,
          input.codeChallenge,
          name,
          Store.hashToken(token),
          input.scope,
          new Date(this.now().getTime() + CODE_MS).toISOString(),
          randomBytes(16).toString("base64url"),
        );
      return { code, name };
    })();
  }

  /** authorization_code grant with PKCE (S256). A code works once; replaying it revokes what it issued. */
  exchangeCode(code: string, clientId: string, redirectUri: string, verifier: string): OAuthTokens {
    return this.grantStep(() => {
      const row = this.db.prepare("SELECT * FROM oauth_codes WHERE hash = ?").get(Store.hashToken(code)) as CodeRow | undefined;
      if (!row) throw new OAuthError("invalid_grant", "Unknown authorization code");
      if (row.used_at) throw new GrantReuse(row.grant_id, "Authorization code already used");
      if (row.expires_at <= this.iso()) throw new OAuthError("invalid_grant", "Authorization code expired");
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri) throw new OAuthError("invalid_grant", "Code was issued to another client or redirect URI");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameString(s256(verifier), row.code_challenge)) {
        throw new OAuthError("invalid_grant", "PKCE verification failed");
      }
      this.db.prepare("UPDATE oauth_codes SET used_at = ? WHERE hash = ?").run(this.iso(), row.hash);
      return this.issueTokens(row);
    });
  }

  /** refresh_token grant. Refresh tokens rotate; presenting a used one revokes the whole grant (theft detection). */
  refreshTokens(refreshToken: string, clientId: string): OAuthTokens {
    return this.grantStep(() => {
      const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'").get(Store.hashToken(refreshToken)) as
        | (CodeRow & { used_at: string | null })
        | undefined;
      if (!row) throw new OAuthError("invalid_grant", "Unknown refresh token");
      if (row.client_id !== clientId) throw new OAuthError("invalid_grant", "Refresh token was issued to another client");
      if (row.used_at) throw new GrantReuse(row.grant_id, "Refresh token already used; the connection was revoked");
      if (row.expires_at <= this.iso()) throw new OAuthError("invalid_grant", "Refresh token expired");
      this.db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE hash = ?").run(this.iso(), row.hash);
      return this.issueTokens(row);
    });
  }

  /** Run a token-grant step in a transaction. On a replayed code or refresh token, revoke that grant after the rollback. */
  private grantStep(fn: () => OAuthTokens): OAuthTokens {
    try {
      return this.db.transaction(fn)();
    } catch (e) {
      if (!(e instanceof GrantReuse)) throw e;
      this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").run(e.grantId);
      throw new OAuthError("invalid_grant", e.message);
    }
  }

  /** RFC 7009: revoking either token ends the whole grant. Unknown tokens are not an error. */
  revokeOAuthToken(token: string): void {
    const row = this.db.prepare("SELECT grant_id FROM oauth_tokens WHERE hash = ?").get(Store.hashToken(token)) as { grant_id: string } | undefined;
    if (row) this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").run(row.grant_id);
  }

  private issueTokens(g: { grant_id: string; client_id: string; token_name: string; token_hash: string; scope: string }): OAuthTokens {
    const active = this.db.prepare("SELECT 1 FROM tokens WHERE name = ? AND hash = ? AND revoked_at IS NULL").get(g.token_name, g.token_hash);
    if (!active) throw new OAuthError("invalid_grant", "This connection's token was revoked");
    const now = this.now().getTime();
    const nowIso = new Date(now).toISOString();
    // Housekeeping: drop expired rows (used refresh tokens are kept until expiry for reuse detection).
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(nowIso);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(new Date(now - 24 * 3_600_000).toISOString());
    const access = `${ACCESS_PREFIX}${randomBytes(32).toString("base64url")}`;
    const refresh = `${REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (hash, kind, grant_id, client_id, token_name, token_hash, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(Store.hashToken(access), "access", g.grant_id, g.client_id, g.token_name, g.token_hash, g.scope, nowIso, new Date(now + ACCESS_MS).toISOString());
    insert.run(Store.hashToken(refresh), "refresh", g.grant_id, g.client_id, g.token_name, g.token_hash, g.scope, nowIso, new Date(now + REFRESH_MS).toISOString());
    this.db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?").run(nowIso, g.client_id);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: g.scope };
  }

  /** Per project: open and claimed tasks it received, open tasks it sent. Expired claims count as open. */
  projectSummary(): { id: string; name: string; description: string; inbox_open: number; inbox_claimed: number; sent_active: number }[] {
    const projects = this.listProjects();
    return projects.map((p) => {
      const inbox = this.listInbox(p.id);
      const sent = this.listSent(p.id).filter((t) => t.status === "open" || t.status === "claimed");
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        inbox_open: inbox.filter((t) => t.status === "open").length,
        inbox_claimed: inbox.filter((t) => t.status === "claimed").length,
        sent_active: sent.length,
      };
    });
  }
}

const TOKEN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** An OAuth protocol error: `error` is the RFC 6749 error code sent to the client. */
export class OAuthError extends Error {
  constructor(
    public error: string,
    message: string,
  ) {
    super(message);
  }
}

/** Internal: a replayed code or refresh token. The grant is revoked outside the rolled-back transaction. */
class GrantReuse extends Error {
  constructor(
    public grantId: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OAuthTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface CodeRow {
  hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  token_name: string;
  token_hash: string;
  scope: string;
  expires_at: string;
  used_at: string | null;
  grant_id: string;
}

const ACCESS_PREFIX = "ata_";
const REFRESH_PREFIX = "atr_";
const ACCESS_MS = 3_600_000;
const REFRESH_MS = 30 * 24 * 3_600_000;
const CODE_MS = 5 * 60_000;
const MAX_CLIENTS = 200;

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** No 0/O, 1/I/L: easy to read aloud and type. 8 characters from 31 = about 40 bits, single use, 10 minutes. */
const PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function pairingCode(): string {
  // Rejection sampling: keep only bytes below the largest multiple of 31, so every character is equally likely.
  const limit = 256 - (256 % PAIR_ALPHABET.length);
  const chars: string[] = [];
  while (chars.length < 8) {
    for (const b of randomBytes(16)) if (b < limit && chars.length < 8) chars.push(PAIR_ALPHABET[b % PAIR_ALPHABET.length]);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function normalisePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}
