// SPDX-License-Identifier: MIT
import { createHash, randomBytes } from "node:crypto";
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

  private checkVersion(t: Task, version: number | undefined): void {
    if (version !== undefined && version !== t.version) {
      throw new TaskError("conflict", `Task ${t.id} changed: you have version ${version}, current is ${t.version}`, {
        task: t,
      });
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

  claimTask(actor: string, project: string, id: string, version?: number, session?: string): Task {
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

  addNote(actor: string, id: string, text: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (!text.trim()) throw new TaskError("invalid", "Note text is required");
      this.event(id, "note", actor, text);
      if (t.status === "claimed") return this.write(t, { lease_until: this.iso(this.leaseMs) });
      return t;
    })();
  }

  releaseTask(actor: string, project: string, id: string, version?: number): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (t.to_project !== project) throw new TaskError("forbidden", `Task ${id} is for ${t.to_project}, not ${project}`);
      this.checkVersion(t, version);
      if (t.status !== "claimed") throw new TaskError("conflict", `Task ${id} is ${t.status}`, { task: t });
      const out = this.write(t, { status: "open", claimed_by: null, lease_until: null });
      this.event(id, "released", actor);
      return out;
    })();
  }

  completeTask(actor: string, project: string, id: string, version: number | undefined, result: string): Task {
    return this.db.transaction(() => {
      const t = this.mustGet(id);
      if (t.to_project !== project) throw new TaskError("forbidden", `Task ${id} is for ${t.to_project}, not ${project}`);
      this.checkVersion(t, version);
      if (!result.trim()) throw new TaskError("invalid", "A result is required to complete a task");
      if (t.status !== "open" && t.status !== "claimed") {
        throw new TaskError("conflict", `Task ${id} is already ${t.status}`, { task: t });
      }
      const out = this.write(t, { status: "done", result, done_at: this.iso(), lease_until: null });
      this.event(id, "completed", actor, result);
      return out;
    })();
  }

  /** The receiver rejects a task, or the sender cancels its own. */
  rejectTask(actor: string, project: string, id: string, reason: string, version?: number): Task {
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
      const status: Status = isReceiver ? "rejected" : "cancelled";
      const out = this.write(t, { status, result: reason, done_at: this.iso(), lease_until: null });
      this.event(id, status === "rejected" ? "rejected" : "cancelled", actor, reason);
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
    return this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(this.iso(), name).changes === 1;
  }

  listTokens(): { name: string; created_at: string; revoked_at: string | null }[] {
    return this.db.prepare("SELECT name, created_at, revoked_at FROM tokens ORDER BY name").all() as {
      name: string;
      created_at: string;
      revoked_at: string | null;
    }[];
  }

  countActiveTokens(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  /** Returns the token's name when it is valid and not revoked. */
  authenticate(token: string): string | undefined {
    const r = this.db.prepare("SELECT name FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(Store.hashToken(token)) as
      | { name: string }
      | undefined;
    return r?.name;
  }
}
