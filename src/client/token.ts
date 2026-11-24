// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { configDir, type TokenStore } from "./config.js";

type Env = Record<string, string | undefined>;
const SERVICE = "agenttaskservice";
const ACCOUNT = "default";

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

/** The best store this machine offers. */
export function defaultTokenStore(): TokenStore {
  if (platform() === "darwin" && has("security")) return "keychain";
  if (platform() === "linux" && has("secret-tool") && process.env.DBUS_SESSION_BUS_ADDRESS) return "secret-tool";
  return "file";
}

export function tokenFile(env: Env = process.env): string {
  return join(configDir(env), "token");
}

export function readToken(store: TokenStore, env: Env = process.env): string | undefined {
  if (env.AGENTTASK_TOKEN) return env.AGENTTASK_TOKEN;
  try {
    if (store === "keychain") {
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || undefined;
    }
    if (store === "secret-tool") {
      return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || undefined;
    }
    const f = tokenFile(env);
    return existsSync(f) ? readFileSync(f, "utf8").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** Run a store command. On failure the error names the tool and exit status only, never its arguments (they hold the token). */
function store(cmd: string, args: string[], input: string | undefined, hint: string, env: Env): void {
  const r = spawnSync(cmd, args, { env: env as NodeJS.ProcessEnv, input, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
  if (r.status === 0) return;
  const why = r.error ? (r.error as NodeJS.ErrnoException).code ?? "could not start" : `exit ${r.status ?? r.signal}`;
  throw new Error(`could not store the token with ${cmd} (${why}). ${hint}`);
}

export function writeToken(store_: TokenStore, token: string, env: Env = process.env): void {
  const fallback = "Set AGENTTASK_TOKEN_STORE=file to keep it in a file readable only by you instead.";
  if (store_ === "keychain") {
    // -U updates an existing item. The value is briefly visible to local `ps`; the keychain offers no stdin option.
    store("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", token], undefined,
      `If the keychain is locked (common over SSH), run \`security unlock-keychain\` first. ${fallback}`, env);
    return;
  }
  if (store_ === "secret-tool") {
    store("secret-tool", ["store", "--label", SERVICE, "service", SERVICE, "account", ACCOUNT], token, fallback, env);
    return;
  }
  const f = tokenFile(env);
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(f, `${token}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
}

/** Printable ASCII with no spaces: what the server issues. Anything else is a paste mistake. */
export const TOKEN_SHAPE = /^[\x21-\x7e]{8,512}$/;
export const BAD_TOKEN = "the stored token is malformed (it must be one line of printable characters); run `agenttaskservice init` again";

/** Remove a secret from text before it is shown or logged. */
export function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
