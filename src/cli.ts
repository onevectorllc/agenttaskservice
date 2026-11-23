#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isLoopback, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { startServer } from "./server.js";
import { Store, TaskError } from "./store.js";

const USAGE = `agenttaskservice <command>

Commands:
  serve                         Start the server
  token add <name>              Create a client token (shown once)
  token list                    List tokens
  token revoke <name>           Revoke a token
  project add <id> [--name N] [--description D] [--alias A ...]
  project list                  List projects

Options:
  --config <path>               Config file (default: $XDG_CONFIG_HOME/agenttaskservice/server.toml)
`;

export function run(argv: string[], out: (s: string) => void = console.log): number {
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
        const token = store.addToken("admin");
        out("No tokens yet. Created the 'admin' token. It is shown only this once; store it safely:");
        out(`  ${token}`);
      }
      if (!isLoopback(cfg.host) && !cfg.tlsCert) {
        console.warn(`warning: listening on ${cfg.host} without TLS. Use a TLS reverse proxy or set tls.cert and tls.key.`);
      }
      startServer(store, cfg);
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
  process.exitCode = run(process.argv.slice(2));
}
