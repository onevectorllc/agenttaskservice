// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Store, TaskError } from "../src/store.js";

let clock: Date;
let store: Store;

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00.000Z");
  store = new Store(openDb(":memory:"), { leaseMs: 60_000, now: () => clock });
  store.upsertProject({ id: "project-a", name: "Project A", aliases: ["Alpha"] });
  store.upsertProject({ id: "project-b", name: "Project B" });
});

const create = (extra: Record<string, unknown> = {}) =>
  store.createTask("laptop", { from_project: "project-a", to_project: "project-b", title: "Do the thing", ...extra }).task;

/** The task's current version. */
const v = (id: string) => store.getTask(id).task.version;

function expectError(fn: () => unknown, code: TaskError["code"]): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TaskError);
    expect((e as TaskError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("AC-1: create and inbox", () => {
  it("AC-1: a created task shows in the receiver's inbox, not the sender's", () => {
    const t = create();
    expect(t.id).toBe("T-0001");
    expect(t.status).toBe("open");
    expect(store.listInbox("project-b").map((x) => x.id)).toEqual(["T-0001"]);
    expect(store.listInbox("project-a")).toEqual([]);
    expect(store.listSent("project-a").map((x) => x.id)).toEqual(["T-0001"]);
  });

  it("AC-1: the same client_key returns the existing task", () => {
    const a = store.createTask("laptop", { from_project: "project-a", to_project: "project-b", title: "x", client_key: "key-12345" });
    const b = store.createTask("laptop", { from_project: "project-a", to_project: "project-b", title: "x", client_key: "key-12345" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
    expect(store.listInbox("project-b")).toHaveLength(1);
  });

  it("AC-1: an unknown receiver is refused and the known projects are listed", () => {
    try {
      create({ to_project: "nope" });
      throw new Error("expected failure");
    } catch (e) {
      expect((e as TaskError).code).toBe("not_found");
      expect((e as TaskError).details).toEqual({ known_projects: ["project-a", "project-b"] });
    }
  });

  it("AC-1: a receiver alias resolves to its id; a new sender is registered", () => {
    const t = store.createTask("laptop", { from_project: "project-c", to_project: "alpha", title: "hi" }).task;
    expect(t.to_project).toBe("project-a");
    expect(store.getProject("project-c")).toBeDefined();
  });

  it("AC-1: invalid project ids, empty titles and bad priorities are refused", () => {
    expectError(() => store.createTask("x", { from_project: "Bad Id", to_project: "project-b", title: "t" }), "invalid");
    expectError(() => create({ title: "   " }), "invalid");
    expectError(() => create({ priority: 5 }), "invalid");
  });

  it("AC-1: the inbox is sorted by priority, then age", () => {
    create({ title: "low", priority: 3 });
    create({ title: "high", priority: 1 });
    create({ title: "normal" });
    expect(store.listInbox("project-b").map((t) => t.title)).toEqual(["high", "normal", "low"]);
  });
});

describe("AC-2: claims and leases", () => {
  it("AC-2: claiming needs the current version and blocks a second claim", () => {
    const t = create();
    const claimed = store.claimTask("mini", "project-b", t.id, t.version, "s1");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimed_by).toBe("mini/s1");
    expectError(() => store.claimTask("laptop", "project-b", t.id, claimed.version), "conflict");
    expectError(() => store.claimTask("laptop", "project-b", t.id, t.version), "conflict");
  });

  it("AC-2: only the receiving project can claim", () => {
    const t = create();
    expectError(() => store.claimTask("mini", "project-a", t.id, v(t.id)), "forbidden");
  });

  it("AC-2: an expired lease makes the task open again and claimable", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    clock = new Date(clock.getTime() + 61_000);
    expect(store.getTask(t.id).task.status).toBe("open");
    const again = store.claimTask("laptop", "project-b", t.id, v(t.id));
    expect(again.claimed_by).toBe("laptop");
  });

  it("AC-2: a note renews the lease", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    clock = new Date(clock.getTime() + 50_000);
    store.addNote("mini", t.id, "halfway");
    clock = new Date(clock.getTime() + 50_000);
    expect(store.getTask(t.id).task.status).toBe("claimed");
  });

  it("AC-2: release opens a claimed task again", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    expect(store.releaseTask("mini", "project-b", t.id, v(t.id)).status).toBe("open");
  });
});

describe("AC-2/AC-3: versions and claim holders", () => {
  it("AC-2: claim, complete, release and reject refuse a missing version", () => {
    const t = create();
    const missing = undefined as unknown as number;
    expectError(() => store.claimTask("mini", "project-b", t.id, missing), "invalid");
    expectError(() => store.completeTask("mini", "project-b", t.id, missing, "ok"), "invalid");
    expectError(() => store.rejectTask("mini", "project-b", t.id, "no", missing), "invalid");
    store.claimTask("mini", "project-b", t.id, v(t.id));
    expectError(() => store.releaseTask("mini", "project-b", t.id, missing), "invalid");
  });

  it("AC-2: only the claim holder can complete or release; others get conflict", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id), "s1");
    expectError(() => store.completeTask("laptop", "project-b", t.id, v(t.id), "mine now"), "conflict");
    expectError(() => store.releaseTask("laptop", "project-b", t.id, v(t.id)), "conflict");
    expectError(() => store.completeTask("mini", "project-b", t.id, v(t.id), "x", "other-session"), "conflict");
    expect(store.completeTask("mini", "project-b", t.id, v(t.id), "done", "s1").claimed_by).toBe("mini/s1");
  });

  it("AC-2: only the claim holder can reject; the sender can still cancel", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id), "s1");
    expectError(() => store.rejectTask("laptop", "project-b", t.id, "nope", v(t.id)), "conflict");
    expect(store.rejectTask("mini", "project-b", t.id, "wrong project", v(t.id), "s1").status).toBe("rejected");
    const u = create();
    store.claimTask("mini", "project-b", u.id, v(u.id));
    expect(store.rejectTask("laptop", "project-a", u.id, "no longer needed", v(u.id)).status).toBe("cancelled");
  });

  it("AC-2: a note from someone else is recorded but does not renew the lease", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    clock = new Date(clock.getTime() + 50_000);
    store.addNote("laptop", t.id, "nudge");
    clock = new Date(clock.getTime() + 20_000);
    expect(store.getTask(t.id).task.status).toBe("open");
    expect(store.getTask(t.id).events.map((e) => e.kind)).toContain("note");
  });

  it("AC-2: after a lease expires, anyone in the project may complete it", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    clock = new Date(clock.getTime() + 61_000);
    expect(store.completeTask("laptop", "project-b", t.id, v(t.id), "picked up").status).toBe("done");
  });

  it("AC-4: release and cancel are recorded in the history", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    store.releaseTask("mini", "project-b", t.id, v(t.id));
    store.rejectTask("laptop", "project-a", t.id, "not needed", v(t.id));
    expect(store.getTask(t.id).events.map((e) => e.kind)).toEqual(["created", "claimed", "released", "cancelled"]);
  });
});

describe("AC-3: completion", () => {
  it("AC-3: completing needs a result", () => {
    const t = create();
    expectError(() => store.completeTask("mini", "project-b", t.id, v(t.id), "  "), "invalid");
    const done = store.completeTask("mini", "project-b", t.id, v(t.id), "Merged PR 18");
    expect(done.status).toBe("done");
    expect(done.result).toBe("Merged PR 18");
    expect(done.done_at).not.toBeNull();
  });

  it("AC-3: a stale version is refused with the current task", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    try {
      store.completeTask("laptop", "project-b", t.id, t.version, "done");
      throw new Error("expected conflict");
    } catch (e) {
      expect((e as TaskError).code).toBe("conflict");
      expect(((e as TaskError).details as { task: { version: number } }).task.version).toBe(2);
    }
  });

  it("AC-3: a finished task cannot be completed again", () => {
    const t = create();
    store.completeTask("mini", "project-b", t.id, v(t.id), "ok");
    expectError(() => store.completeTask("mini", "project-b", t.id, v(t.id), "again"), "conflict");
  });
});

describe("AC-4: notes, reject, history, projects", () => {
  it("AC-4: every change is recorded in the history, in order", () => {
    const t = create();
    store.claimTask("mini", "project-b", t.id, v(t.id));
    store.addNote("mini", t.id, "working");
    store.completeTask("mini", "project-b", t.id, v(t.id), "done");
    const { events } = store.getTask(t.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "claimed", "note", "completed"]);
    expect(events[2]).toMatchObject({ actor: "mini", text: "working" });
  });

  it("AC-4: the history cannot be edited or deleted", () => {
    const db = openDb(":memory:");
    const s = new Store(db);
    s.ensureProject("p");
    s.createTask("x", { from_project: "p", to_project: "p", title: "t" });
    expect(() => db.prepare("UPDATE task_events SET text = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM task_events").run()).toThrow(/append-only/);
  });

  it("AC-4: the receiver rejects, the sender cancels, others are refused", () => {
    const a = create();
    expect(store.rejectTask("mini", "project-b", a.id, "wrong project", v(a.id)).status).toBe("rejected");
    const b = create();
    expect(store.rejectTask("laptop", "project-a", b.id, "not needed", v(b.id)).status).toBe("cancelled");
    const c = create();
    store.ensureProject("project-c");
    expectError(() => store.rejectTask("x", "project-c", c.id, "meh", v(c.id)), "forbidden");
    expectError(() => store.rejectTask("mini", "project-b", c.id, " ", v(c.id)), "invalid");
  });

  it("AC-4: unknown task ids are not_found", () => {
    expectError(() => store.getTask("T-9999"), "not_found");
  });

  it("AC-4: list_projects returns ids, names and aliases", () => {
    expect(store.listProjects()).toEqual([
      { id: "project-a", name: "Project A", aliases: ["Alpha"], description: "" },
      { id: "project-b", name: "Project B", aliases: [], description: "" },
    ]);
  });
});

describe("AC-6: unseen completions for the sender", () => {
  it("AC-6: done and rejected tasks are shown to the sender once", () => {
    const a = create();
    const b = create();
    create();
    store.completeTask("mini", "project-b", a.id, v(a.id), "ok");
    store.rejectTask("mini", "project-b", b.id, "no", v(b.id));
    expect(store.takeUnseenCompletions("project-a").map((t) => t.id)).toEqual([a.id, b.id]);
    expect(store.takeUnseenCompletions("project-a")).toEqual([]);
  });
});

describe("AC-5: tokens", () => {
  it("AC-5: tokens are stored hashed, authenticate by value and can be revoked", () => {
    const db = openDb(":memory:");
    const s = new Store(db);
    const token = s.addToken("laptop");
    expect(token).toMatch(/^ats_/);
    const row = db.prepare("SELECT hash FROM tokens WHERE name = 'laptop'").get() as { hash: string };
    expect(row.hash).toBe(Store.hashToken(token));
    expect(row.hash).not.toContain(token);
    expect(s.authenticate(token)).toBe("laptop");
    expect(s.authenticate("ats_wrong")).toBeUndefined();
    expect(s.revokeToken("laptop")).toBe(true);
    expect(s.authenticate(token)).toBeUndefined();
    const fresh = s.addToken("laptop");
    expect(s.authenticate(fresh)).toBe("laptop");
    expect(s.authenticate(token)).toBeUndefined();
  });

  it("AC-5: a duplicate active token name is refused", () => {
    const s = new Store(openDb(":memory:"));
    s.addToken("a");
    expectError(() => s.addToken("a"), "conflict");
    expectError(() => s.addToken("bad name"), "invalid");
  });
});
