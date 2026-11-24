<!-- Copyright (c) 2026 OneVector LLC -->
# Security

## Model

- Every endpoint except `GET /health` requires a bearer token.
- Tokens are random 256-bit values. The server stores only their SHA-256 hash
  and shows a new token once. A token is checked by looking up its hash, so the
  comparison never runs over the secret itself. The first admin token is written
  to a file readable only by its owner, never to stdout or logs. Revoke one with `agenttaskservice token revoke <name>`.
- All tokens belong to one trust domain: any valid token may act for any project.
  Give tokens only to machines and clients you control. Per-project permissions
  are not part of this version.
- The token's name is recorded as the actor on every change.
- The server listens on `127.0.0.1` by default. To expose it, use built-in TLS or
  a TLS-terminating reverse proxy. Plain HTTP beyond loopback sends tokens in clear text.
- Request bodies are limited (1 MB by default), inputs are validated at the
  boundary, and all SQL uses bound parameters.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
("Security" tab, "Report a vulnerability"). Do not open a public issue.
