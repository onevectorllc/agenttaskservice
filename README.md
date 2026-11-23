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

Requires Node.js 20 or newer.

```sh
npx agenttaskservice serve
```

The first start creates an `admin` token and saves it to `admin-token` in the
data directory, readable only by you (it is never printed, so it can't end up in
service logs). Copy it somewhere safe and delete the file.
Create one token per machine or client:

```sh
npx agenttaskservice token add laptop
```

Add the server to Claude Code (user scope, so every project sees it):

```sh
claude mcp add --scope user --transport http agenttaskservice http://127.0.0.1:7420/mcp \
  --header "Authorization: Bearer <token>"
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
can complete or release the task, and only the holder's notes renew the lease.

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

## CLI

```text
agenttaskservice serve
agenttaskservice token add <name> | token list | token revoke <name>
agenttaskservice project add <id> [--name N] [--description D] [--alias A ...]
agenttaskservice project list
```

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
