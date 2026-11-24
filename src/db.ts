// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE tasks (
    id             TEXT PRIMARY KEY,
    seq            INTEGER NOT NULL UNIQUE,
    client_key     TEXT NOT NULL UNIQUE,
    from_project   TEXT NOT NULL REFERENCES projects(id),
    to_project     TEXT NOT NULL REFERENCES projects(id),
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','claimed','done','rejected','cancelled')),
    priority       INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1,2,3)),
    claimed_by     TEXT,
    lease_until    TEXT,
    result         TEXT,
    parent_id      TEXT REFERENCES tasks(id),
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (${NOW}),
    updated_at     TEXT NOT NULL DEFAULT (${NOW}),
    done_at        TEXT,
    sender_seen_at TEXT,
    CHECK (status <> 'done' OR (result IS NOT NULL AND result <> ''))
  );
  CREATE INDEX tasks_inbox  ON tasks (to_project, status, priority);
  CREATE INDEX tasks_outbox ON tasks (from_project, status, sender_seen_at);

  CREATE TABLE task_events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    kind    TEXT NOT NULL CHECK (kind IN
            ('created','claimed','note','released','completed','rejected','cancelled')),
    actor   TEXT NOT NULL,
    text    TEXT NOT NULL DEFAULT '',
    at      TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX task_events_by_task ON task_events (task_id, seq);

  CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
  BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
  CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
  BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;

  CREATE TABLE tokens (
    name       TEXT PRIMARY KEY,
    hash       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    revoked_at TEXT
  );
  `,
  // 2: last-seen time per token, one-time pairing codes, web UI sessions
  `
  ALTER TABLE tokens ADD COLUMN last_used_at TEXT;

  CREATE TABLE pairings (
    hash       TEXT PRIMARY KEY,
    name       TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    used_for   TEXT
  );

  CREATE TABLE ui_sessions (
    hash       TEXT PRIMARY KEY,
    token_name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    csrf       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
  // 3: OAuth for the Claude app connector. Every secret is stored as a SHA-256 hash.
  // Grants are bound to a token row (name + hash), so `token revoke` cuts the app off.
  `
  CREATE TABLE oauth_clients (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
  );

  CREATE TABLE oauth_codes (
    hash           TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    token_name     TEXT NOT NULL,
    token_hash     TEXT NOT NULL,
    scope          TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used_at        TEXT,
    grant_id       TEXT NOT NULL
  );

  CREATE TABLE oauth_tokens (
    hash       TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    grant_id   TEXT NOT NULL,
    client_id  TEXT NOT NULL,
    token_name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scope      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
  `,
];

/** Open (and create or migrate) the database. Use ":memory:" in tests. */
export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
