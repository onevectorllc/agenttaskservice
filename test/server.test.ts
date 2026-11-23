// SPDX-License-Identifier: MIT
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";

let server: Server;
let base: string;
let store: Store;
let laptop: string;
let mini: string;

beforeAll(async () => {
  store = new Store(openDb(":memory:"));
  laptop = store.addToken("laptop");
  mini = store.addToken("mini");
  store.upsertProject({ id: "project-b", name: "Project B", description: "Receives tasks" });
  server = startServer(store, { host: "127.0.0.1", port: 0, dataDir: "", leaseHours: 4, maxBodyBytes: 10_000 }) as Server;
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { error: r.isError === true, value: JSON.parse(r.content[0].text) };
}

describe("AC-6: health", () => {
  it("AC-6: /health answers without a token", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok", service: "agenttaskservice" });
  });
});

describe("AC-5: auth", () => {
  it("AC-5: /mcp and /v1/inbox refuse missing or wrong tokens", async () => {
    for (const path of ["/mcp", "/v1/inbox?project=project-b"]) {
      const none = await fetch(`${base}${path}`, { method: path === "/mcp" ? "POST" : "GET", body: path === "/mcp" ? "{}" : undefined });
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toContain("Bearer");
      const wrong = await fetch(`${base}${path}`, { headers: { authorization: "Bearer ats_nope" } });
      expect(wrong.status).toBe(401);
    }
  });

  it("AC-5: a revoked token is refused", async () => {
    const t = store.addToken("temp");
    const okRes = await fetch(`${base}/v1/inbox?project=project-b`, { headers: { authorization: `Bearer ${t}` } });
    expect(okRes.status).toBe(200);
    store.revokeToken("temp");
    const bad = await fetch(`${base}/v1/inbox?project=project-b`, { headers: { authorization: `Bearer ${t}` } });
    expect(bad.status).toBe(401);
  });

  it("AC-5: an oversized MCP body is refused", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${laptop}`, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(20_000) }),
    });
    expect(r.status).toBe(413);
  });

  it("AC-5: unknown paths are 404 and GET /mcp is 405", async () => {
    const h = { authorization: `Bearer ${laptop}` };
    expect((await fetch(`${base}/nope`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { headers: h })).status).toBe(405);
  });
});

describe("AC-6: MCP tools end to end", () => {
  it("AC-6: lists all ten tools", async () => {
    const c = await connect(laptop);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "add_note",
      "claim_task",
      "complete_task",
      "create_task",
      "get_task",
      "list_my_tasks",
      "list_projects",
      "list_sent_tasks",
      "reject_task",
      "release_task",
    ]);
    await c.close();
  });

  it("AC-6: one machine creates a task, another claims and completes it, the sender is told once", async () => {
    const a = await connect(laptop);
    const b = await connect(mini);

    const created = await call(a, "create_task", { project: "project-a", to_project: "project-b", title: "Adopt the gateway", priority: 1 });
    expect(created.error).toBe(false);
    const id = created.value.task.id as string;

    const inbox = await call(b, "list_my_tasks", { project: "project-b" });
    expect(inbox.value.tasks.map((t: { id: string }) => t.id)).toContain(id);

    const claimed = await call(b, "claim_task", { project: "project-b", task_id: id, version: 1, session: "s1" });
    expect(claimed.value.task.claimed_by).toBe("mini/s1");

    const stale = await call(a, "complete_task", { project: "project-b", task_id: id, version: 1, result: "x" });
    expect(stale.error).toBe(true);
    expect(stale.value.error).toBe("conflict");

    await call(b, "add_note", { task_id: id, text: "halfway" });
    const done = await call(b, "complete_task", { project: "project-b", task_id: id, result: "PR 18 merged" });
    expect(done.value.task.status).toBe("done");

    const detail = await call(a, "get_task", { task_id: id });
    expect(detail.value.events.map((e: { kind: string; actor: string }) => `${e.kind}:${e.actor}`)).toEqual([
      "created:laptop",
      "claimed:mini/s1",
      "note:mini",
      "completed:mini",
    ]);

    const sent = await call(a, "list_sent_tasks", { project: "project-a" });
    expect(sent.value.tasks[0].status).toBe("done");

    const h = { authorization: `Bearer ${laptop}` };
    const first = await (await fetch(`${base}/v1/inbox?project=project-a`, { headers: h })).json();
    expect(first.completed.map((t: { id: string }) => t.id)).toEqual([id]);
    const second = await (await fetch(`${base}/v1/inbox?project=project-a`, { headers: h })).json();
    expect(second.completed).toEqual([]);

    const projects = await call(a, "list_projects", {});
    expect(projects.value.projects.map((p: { id: string }) => p.id)).toEqual(["project-a", "project-b"]);

    await a.close();
    await b.close();
  });

  it("AC-6: tool errors come back as isError with a code, not a crash", async () => {
    const c = await connect(laptop);
    const r = await call(c, "get_task", { task_id: "T-9999" });
    expect(r.error).toBe(true);
    expect(r.value.error).toBe("not_found");
    const bad = await call(c, "create_task", { project: "project-a", to_project: "nowhere", title: "x" });
    expect(bad.value.details.known_projects).toContain("project-b");
    await c.close();
  });

  it("AC-6: /v1/inbox needs a valid project id", async () => {
    const r = await fetch(`${base}/v1/inbox?project=Bad%20Id`, { headers: { authorization: `Bearer ${laptop}` } });
    expect(r.status).toBe(400);
  });
});
