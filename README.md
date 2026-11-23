# agenttaskservice

A small task service that lets AI agent projects hand TODOs to each other.

One project creates a task ("adopt the new gateway"), another project's next
session sees it, claims it, works it and completes it with a result. Every
machine talks to one server, so there is nothing to sync and nothing to merge.
Clients use it through [MCP](https://modelcontextprotocol.io) (Streamable HTTP),
so Claude Code and other MCP clients can call it directly.

- One process, one SQLite file.
- Claims with leases: a crashed session never holds a task forever.
- Version checks on every write: two sessions can't overwrite each other.
- Append-only history of every change.
- Runs on its own (optional built-in TLS) or behind any reverse proxy.

> Status: early. Phase 1 (the core service) is here; the session-start hook,
> an offline queue and a web UI with a setup guide are planned.

## Quick start

Requires Node.js 22 or newer.

```sh
npx agenttaskservice serve
```

The first start creates an `admin` token and saves it to `admin-token` in the
data directory, readable only by you (it is never printed, so it can't end up in
service logs). Copy it somewhere safe and delete the file. If every token is later revoked,
the next start creates a new admin token the same way.
Create one token per machine or client:

```sh
npx agenttaskservice token add laptop
```

Then set up each machine that runs Claude Code (see [Client setup](#client-setup)):

```sh
npm install -g agenttaskservice
agenttaskservice init --url https://tasks.example.com --token <token>
```

Register the projects that receive tasks, so others can find them:

```sh
npx agenttaskservice project add project-b --name "Project B" --description "Builds the video pipeline"
```

## MCP tools

| Tool | What it does |
| --- | --- |
| `create_task` | Hand a TODO to another project (`client_key` makes retries safe) |
| `list_my_tasks` | Inbox: tasks sent to your project |
| `list_sent_tasks` | Outbox: tasks your project sent, with status |
| `get_task` | One task with its full history |
| `claim_task` | Take a task; the claim expires after `lease_hours` unless renewed |
| `add_note` | Progress note; renews your claim |
| `release_task` | Give a claimed task back |
| `complete_task` | Mark done with a result |
| `reject_task` | Receiver hands a task back; sender cancels its own |
| `list_projects` | Known projects and what they do |

Each tool takes `project`, the caller's project id (lowercase letters, digits,
`.`, `_`, `-`). Claim, release, complete and reject require `version` from the
task you last read, so nobody's change is overwritten. While a claim is live,
only its holder (the same token, and the same `session` label if one was used)
can complete, release or reject the task, and only the holder's notes renew the
lease. The sending project can always cancel its own task.

## HTTP endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | Bearer token | MCP, stateless Streamable HTTP |
| `GET /v1/inbox?project=<id>` | Bearer token | Open tasks for a project, plus the project's sent tasks that finished since it last asked (each shown once). Meant for session-start hooks. |
| `GET /health` | none | Liveness check |

## Configuration

Settings come from built-in defaults, then a TOML file, then environment variables.
The file is `$XDG_CONFIG_HOME/agenttaskservice/server.toml` (or `--config <path>`,
or `AGENTTASK_CONFIG`). See [`examples/server.toml`](examples/server.toml).

| Setting | Env var | Default |
| --- | --- | --- |
| `server.host` | `AGENTTASK_HOST` | `127.0.0.1` |
| `server.port` | `AGENTTASK_PORT` | `7420` |
| `tls.cert`, `tls.key` | `AGENTTASK_TLS_CERT`, `AGENTTASK_TLS_KEY` | unset (plain HTTP) |
| `storage.data_dir` | `AGENTTASK_DATA_DIR` | `~/.local/share/agenttaskservice` (Linux), `~/Library/Application Support/agenttaskservice` (macOS) |
| `tasks.lease_hours` | `AGENTTASK_LEASE_HOURS` | `4` (max 720) |
| `server.max_body_bytes` | | `1000000` |

### Two ways to run it

- **Standalone:** set `server.host` to a LAN address and `tls.cert` / `tls.key`
  to a certificate. The server warns if it listens beyond loopback without TLS.
- **Behind a reverse proxy** (Caddy, nginx, Traefik or similar): keep the default
  loopback address and let the proxy terminate TLS. Auth stays on in the service
  either way.

Example service units are in [`examples/`](examples/).

## Client setup

`agenttaskservice init` connects one machine to a server. It checks the server and
the token, lists what it will change, and asks before writing anything:

- stores the token in the macOS Keychain, the Linux secret service (`secret-tool`),
  or a file readable only by you, in that order of preference;
- writes `$XDG_CONFIG_HOME/agenttaskservice/client.toml` (server URL, optional
  workspace root; never the token);
- registers the MCP server with Claude Code at user scope. Claude Code gets the
  token from `agenttaskservice auth-header`, so it is not stored in Claude Code's config;
- adds a `SessionStart` hook to `~/.claude/settings.json`, keeping your other hooks;
- with `--rule`, adds a short task rule to `~/.claude/CLAUDE.md` (otherwise it prints it).

Use `--dry-run` to only list the changes, `--yes` to skip the prompt. Running it
again is safe: it changes only what differs.

At every session start the hook prints the project's open tasks and the tasks it
sent that have finished, so Claude sees them before you type. It waits at most
2 seconds and never blocks the session: if the server is down it prints one line.

**Which project am I?** The first match wins:

1. `AGENTTASK_PROJECT` environment variable
2. a `.agenttask` file with `project = "<id>"`, in the folder or a parent up to the git root
3. `workspace_root` in `client.toml`: the first folder under it
4. the git remote `origin` repository name
5. the git root folder name, then the current folder name

`agenttaskservice whoami` shows the result.

**Offline:** when the server can't be reached, `agenttaskservice task create|note|complete|reject`
queue the change in `$XDG_STATE_HOME/agenttaskservice/outbox.jsonl`. `agenttaskservice flush`
or the next session start sends it. A change the server refuses on replay (for example,
someone else finished the task first) is reported and dropped.

## CLI

```text
agenttaskservice serve
agenttaskservice token add <name> | token list | token revoke <name>
agenttaskservice project add <id> [--name N] [--description D] [--alias A ...]
agenttaskservice project list

agenttaskservice init [--url U] [--token T] [--workspace-root D] [--rule] [--yes] [--dry-run]
agenttaskservice whoami | flush | auth-header | hook session-start
agenttaskservice task create --to P --title T [--body B|-] [--priority 1|2|3]
agenttaskservice task list [--sent] | show <id> | claim <id> | note <id> <text>
agenttaskservice task complete <id> --result R | reject <id> --reason R
```

Task commands accept `--project P`. Without `--version`, complete, reject and claim
act on the task as it is when the command is sent.

| Client env var | Purpose |
| --- | --- |
| `AGENTTASK_URL` | Server URL (overrides `client.toml`) |
| `AGENTTASK_TOKEN` | Token (overrides the stored one) |
| `AGENTTASK_PROJECT` | Project id for this shell |
| `AGENTTASK_WORKSPACE_ROOT` | Workspace root (overrides `client.toml`) |
| `AGENTTASK_TOKEN_STORE` | `keychain`, `secret-tool` or `file` |
| `AGENTTASK_CLIENT_CONFIG` | Path to `client.toml` |

## Development

```sh
npm install
npm run check   # typecheck, tests, sanitize
```

`npm run sanitize` fails on home-directory paths, real email addresses, private
IP addresses, keys and tokens in tracked files. Put extra private strings
(one per line) in an untracked `.sanitize-denylist` file to have them checked too.

## License

MIT. See [LICENSE](LICENSE).
