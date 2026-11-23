// SPDX-License-Identifier: MIT
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store, TaskError, type Status } from "./store.js";

const STATUSES = ["open", "claimed", "done", "rejected", "cancelled"] as const;
const project = z.string().min(1).max(64).describe("Your project id (the caller), e.g. 'video-studio'");
const taskId = z.string().min(1).max(32).describe("Task id, e.g. 'T-0042'");
const version = z.number().int().positive().optional().describe("The task version you last saw; stale versions are refused");

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): Result {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function wrap<A>(fn: (args: A) => unknown): (args: A) => Promise<Result> {
  return async (args: A) => {
    try {
      return ok(fn(args));
    } catch (e) {
      if (e instanceof TaskError) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e.code, message: e.message, details: e.details }, null, 2) }], isError: true };
      }
      throw e;
    }
  };
}

/** One MCP server per request; `actor` is the authenticated token name. */
export function createMcpServer(store: Store, actor: string): McpServer {
  const server = new McpServer({ name: "agenttaskservice", version: "0.1.0" });

  server.registerTool(
    "create_task",
    {
      description: "Hand a TODO to another project. Use list_projects to find valid receivers.",
      inputSchema: {
        project,
        to_project: z.string().min(1).max(64).describe("Receiving project id or alias"),
        title: z.string().min(1).max(200),
        body: z.string().max(20000).optional().describe("Markdown: context, acceptance criteria, links"),
        priority: z.number().int().min(1).max(3).optional().describe("1 high, 2 normal (default), 3 low"),
        client_key: z.string().min(8).max(128).optional().describe("Your own unique key; retrying with the same key never duplicates"),
        parent_id: z.string().max(32).optional(),
      },
    },
    wrap((a) => {
      const { task, created } = store.createTask(actor, { ...a, from_project: a.project });
      return { created, task };
    }),
  );

  server.registerTool(
    "list_my_tasks",
    {
      description: "Inbox: tasks other projects sent to your project (default: open and claimed).",
      inputSchema: { project, status: z.array(z.enum(STATUSES)).optional() },
    },
    wrap((a) => {
      store.ensureProject(a.project);
      return { tasks: store.listInbox(a.project, a.status as Status[] | undefined) };
    }),
  );

  server.registerTool(
    "list_sent_tasks",
    {
      description: "Outbox: tasks your project asked others for, with their status.",
      inputSchema: { project, status: z.array(z.enum(STATUSES)).optional() },
    },
    wrap((a) => {
      store.ensureProject(a.project);
      return { tasks: store.listSent(a.project, a.status as Status[] | undefined) };
    }),
  );

  server.registerTool(
    "get_task",
    { description: "A task with its full event history.", inputSchema: { task_id: taskId } },
    wrap((a) => store.getTask(a.task_id)),
  );

  server.registerTool(
    "claim_task",
    {
      description: "Take a task before working on it. The claim lasts a few hours; add_note renews it.",
      inputSchema: { project, task_id: taskId, version, session: z.string().max(64).optional().describe("Optional label for this session") },
    },
    wrap((a) => ({ task: store.claimTask(actor, a.project, a.task_id, a.version, a.session) })),
  );

  server.registerTool(
    "add_note",
    {
      description: "Add a progress note to a task. Renews your claim.",
      inputSchema: { task_id: taskId, text: z.string().min(1).max(20000) },
    },
    wrap((a) => ({ task: store.addNote(actor, a.task_id, a.text) })),
  );

  server.registerTool(
    "release_task",
    {
      description: "Give a claimed task back so it is open again.",
      inputSchema: { project, task_id: taskId, version },
    },
    wrap((a) => ({ task: store.releaseTask(actor, a.project, a.task_id, a.version) })),
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task done. The result should say what was done and link any PR.",
      inputSchema: { project, task_id: taskId, version, result: z.string().min(1).max(20000) },
    },
    wrap((a) => ({ task: store.completeTask(actor, a.project, a.task_id, a.version, a.result) })),
  );

  server.registerTool(
    "reject_task",
    {
      description: "Receiver: hand a task back with a reason (wrong project, won't do). Sender: cancel your own task.",
      inputSchema: { project, task_id: taskId, version, reason: z.string().min(1).max(20000) },
    },
    wrap((a) => ({ task: store.rejectTask(actor, a.project, a.task_id, a.reason, a.version) })),
  );

  server.registerTool(
    "list_projects",
    { description: "Projects that can receive tasks, with one-line descriptions.", inputSchema: {} },
    wrap(() => ({ projects: store.listProjects() })),
  );

  return server;
}
