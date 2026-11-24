// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface Config {
  host: string;
  port: number;
  /** Paths to a PEM certificate and key. Both set = serve HTTPS. */
  tlsCert?: string;
  tlsKey?: string;
  dataDir: string;
  leaseHours: number;
  /** Maximum request body in bytes. */
  maxBodyBytes: number;
  /** A reverse proxy in front sets X-Forwarded-For; rate limits use its last entry. */
  trustProxy?: boolean;
  /** The web UI runs on its own listener, so a proxy that forwards only the API port never exposes it. */
  ui?: UiConfig;
}

export interface UiConfig {
  host: string;
  port: number;
  /** The API URL clients should use; shown in the setup guide's commands. */
  apiUrl?: string;
  /** Where the setup guide tells new machines to get the code (git clone URL). */
  repoUrl?: string;
}

type Env = Record<string, string | undefined>;

/** Where data lives by default: XDG on Linux, Application Support on macOS. */
export function defaultDataDir(env: Env = process.env): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "agenttaskservice");
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "agenttaskservice");
}

export function defaultConfigPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agenttaskservice", "server.toml");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Load settings: built-in defaults, then the TOML file, then AGENTTASK_* env vars.
 * The file is optional unless AGENTTASK_CONFIG (or an explicit path) names one.
 */
export function loadConfig(path?: string, env: Env = process.env): Config {
  const explicit = path ?? env.AGENTTASK_CONFIG;
  const file = explicit ?? defaultConfigPath(env);
  let t: Record<string, any> = {};
  if (existsSync(file)) {
    t = parse(readFileSync(file, "utf8")) as Record<string, any>;
  } else if (explicit) {
    throw new Error(`Config file not found: ${file}`);
  }
  const server = t.server ?? {};
  const tls = t.tls ?? {};
  const storage = t.storage ?? {};
  const tasks = t.tasks ?? {};
  const ui = t.ui ?? {};
  const uiEnabled = (env.AGENTTASK_UI_ENABLED ?? String(ui.enabled ?? false)) === "true" || env.AGENTTASK_UI_ENABLED === "1";

  const cfg: Config = {
    host: env.AGENTTASK_HOST ?? server.host ?? "127.0.0.1",
    port: Number(env.AGENTTASK_PORT ?? server.port ?? 7420),
    tlsCert: env.AGENTTASK_TLS_CERT ?? tls.cert ?? undefined,
    tlsKey: env.AGENTTASK_TLS_KEY ?? tls.key ?? undefined,
    dataDir: expandHome(env.AGENTTASK_DATA_DIR ?? storage.data_dir ?? defaultDataDir(env)),
    leaseHours: Number(env.AGENTTASK_LEASE_HOURS ?? tasks.lease_hours ?? 4),
    maxBodyBytes: Number(server.max_body_bytes ?? 1_000_000),
    trustProxy: (env.AGENTTASK_TRUST_PROXY ?? String(server.trust_proxy ?? false)) === "true" || env.AGENTTASK_TRUST_PROXY === "1",
    ui: uiEnabled
      ? {
          host: env.AGENTTASK_UI_HOST ?? ui.host ?? "127.0.0.1",
          port: Number(env.AGENTTASK_UI_PORT ?? ui.port ?? 7421),
          apiUrl: (env.AGENTTASK_UI_API_URL ?? ui.api_url ?? undefined)?.replace(/\/+$/, ""),
          repoUrl: env.AGENTTASK_UI_REPO_URL ?? ui.repo_url ?? undefined,
        }
      : undefined,
  };
  if (cfg.tlsCert) cfg.tlsCert = expandHome(cfg.tlsCert);
  if (cfg.tlsKey) cfg.tlsKey = expandHome(cfg.tlsKey);

  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`Invalid port: ${cfg.port}`);
  if (!(cfg.leaseHours > 0 && cfg.leaseHours <= 720)) throw new Error(`Invalid lease_hours (0 < hours <= 720): ${cfg.leaseHours}`);
  if (!Number.isInteger(cfg.maxBodyBytes) || cfg.maxBodyBytes < 1024 || cfg.maxBodyBytes > 100_000_000) {
    throw new Error(`Invalid server.max_body_bytes (whole bytes, 1024 to 100000000): ${server.max_body_bytes}`);
  }
  if (cfg.ui) {
    if (!Number.isInteger(cfg.ui.port) || cfg.ui.port < 0 || cfg.ui.port > 65535) throw new Error(`Invalid ui.port: ${cfg.ui.port}`);
    if (cfg.ui.port !== 0 && cfg.ui.port === cfg.port && cfg.ui.host === cfg.host) throw new Error("ui.port must differ from server.port");
  }
  if (Boolean(cfg.tlsCert) !== Boolean(cfg.tlsKey)) throw new Error("Set both tls.cert and tls.key, or neither");
  return cfg;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Loopback or a private-network address (RFC 1918, link-local, unique-local). Hostnames other than localhost are unknown. */
export function isPrivateAddress(host: string): boolean {
  if (isLoopback(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:|^fe80:/i.test(host);
}
