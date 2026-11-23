#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { closeSync, openSync, realpathSync, writeSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLIENT_USAGE, runClient } from "./client/commands.js";
import { runInit } from "./client/init.js";
import { isLoopback, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { startServer } from "./server.js";
import { Store, TaskError } from "./store.js";

const USAGE = `agenttaskservice <command>

Server commands:
  serve                         Start the server
  token add <name>              Create a client token (shown once)
  token list                    List tokens
  token revoke <name>           Revoke a token
  project add <id> [--name N] [--description D] [--alias A ...]
  project list                  List projects

Options:
  --config <path>               Config file (default: $XDG_CONFIG_HOME/agenttaskservice/server.toml)

${CLIENT_USAGE}`;

const SERVER_COMMANDS = new Set(["serve", "token", "project"]);

/** Entry point for every command. Client commands are async; server ones are not. */
export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const cmd = argv.find((a) => !a.startsWith("-"));
  if (cmd === "init") return runInit(argv.slice(argv.indexOf("init") + 1), out);
  if (cmd && !SERVER_COMMANDS.has(cmd)) {
    const code = await runClient(argv, out);
    if (code !== undefined) return code;
  }
  return run(argv, out);
}

export interface RunHooks {
  /** Called with the listening server after `serve` starts (used by tests). */
  onServer?: (server: Server) => void;
}

export function run(argv: string[], out: (s: string) => void = console.log, hooks: RunHooks = {}): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      alias: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, arg] = positionals;
  if (values.help || !cmd) {
    out(USAGE);
    return cmd ? 0 : 1;
  }

  const cfg = loadConfig(values.config);
  const store = new Store(openDb(join(cfg.dataDir, "agenttaskservice.db")), { leaseMs: cfg.leaseHours * 3_600_000 });

  try {
    if (cmd === "serve") {
      if (store.countActiveTokens() === 0) {
        // Never print the token: service managers keep stdout in their logs.
        const file = join(cfg.dataDir, "admin-token");
        // "wx": never follow or overwrite an existing file or symlink.
        const fd = openSync(file, "wx", 0o600);
        try {
          writeSync(fd, `${store.addToken("admin")}\n`);
        } finally {
          closeSync(fd);
        }
        out(`No tokens yet. Created the 'admin' token and saved it to ${file} (readable only by you).`);
        out("Copy it somewhere safe, then delete that file.");
      }
      if (!isLoopback(cfg.host) && !cfg.tlsCert) {
        console.warn(`warning: listening on ${cfg.host} without TLS. Use a TLS reverse proxy or set tls.cert and tls.key.`);
      }
      const server = startServer(store, cfg);
      hooks.onServer?.(server);
      out(`agenttaskservice listening on ${cfg.tlsCert ? "https" : "http"}://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);
      return 0;
    }
    if (cmd === "token" && sub === "add" && arg) {
      out(store.addToken(arg));
      return 0;
    }
    if (cmd === "token" && sub === "list") {
      for (const t of store.listTokens()) out(`${t.name}\tcreated ${t.created_at}${t.revoked_at ? `\trevoked ${t.revoked_at}` : ""}`);
      return 0;
    }
    if (cmd === "token" && sub === "revoke" && arg) {
      if (!store.revokeToken(arg)) {
        out(`No active token named ${arg}`);
        return 1;
      }
      out(`Revoked ${arg}`);
      return 0;
    }
    if (cmd === "project" && sub === "add" && arg) {
      const p = store.upsertProject({ id: arg, name: values.name, description: values.description, aliases: values.alias });
      out(`${p.id}\t${p.name}\t${p.description}`);
      return 0;
    }
    if (cmd === "project" && sub === "list") {
      for (const p of store.listProjects()) out(`${p.id}\t${p.name}\t${p.description}`);
      return 0;
    }
    out(USAGE);
    return 1;
  } catch (e) {
    if (e instanceof TaskError) {
      out(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    },
  );
}
