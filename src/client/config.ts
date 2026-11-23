// SPDX-License-Identifier: MIT
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

export type TokenStore = "keychain" | "secret-tool" | "file";

export interface ClientConfig {
  /** Server base URL, e.g. https://tasks.example.com */
  url?: string;
  tokenStore: TokenStore;
  /** Optional: the first folder under this directory is the project id. */
  workspaceRoot?: string;
}

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agenttaskservice");
}

export function stateDir(env: Env = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agenttaskservice");
}

export function clientConfigPath(env: Env = process.env): string {
  return env.AGENTTASK_CLIENT_CONFIG || join(configDir(env), "client.toml");
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function loadClientConfig(env: Env = process.env): ClientConfig {
  const file = clientConfigPath(env);
  const t = existsSync(file) ? (parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const store = String(env.AGENTTASK_TOKEN_STORE ?? t.token_store ?? "file");
  if (!["keychain", "secret-tool", "file"].includes(store)) throw new Error(`Invalid token_store in ${file}: ${store}`);
  const url = env.AGENTTASK_URL ?? (t.url as string | undefined);
  const root = env.AGENTTASK_WORKSPACE_ROOT ?? (t.workspace_root as string | undefined);
  return {
    url: url ? url.replace(/\/+$/, "") : undefined,
    tokenStore: store as TokenStore,
    workspaceRoot: root ? expandHome(root) : undefined,
  };
}

/** Write client.toml. Never contains the token. */
export function saveClientConfig(cfg: ClientConfig, env: Env = process.env): string {
  const file = clientConfigPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const body: Record<string, string> = { token_store: cfg.tokenStore };
  if (cfg.url) body.url = cfg.url;
  if (cfg.workspaceRoot) body.workspace_root = cfg.workspaceRoot;
  writeFileSync(file, `# agenttaskservice client settings (the token is stored separately)\n${stringify(body)}\n`, { mode: 0o644 });
  return file;
}
