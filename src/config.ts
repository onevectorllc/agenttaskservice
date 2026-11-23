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

  const cfg: Config = {
    host: env.AGENTTASK_HOST ?? server.host ?? "127.0.0.1",
    port: Number(env.AGENTTASK_PORT ?? server.port ?? 7420),
    tlsCert: env.AGENTTASK_TLS_CERT ?? tls.cert ?? undefined,
    tlsKey: env.AGENTTASK_TLS_KEY ?? tls.key ?? undefined,
    dataDir: expandHome(env.AGENTTASK_DATA_DIR ?? storage.data_dir ?? defaultDataDir(env)),
    leaseHours: Number(env.AGENTTASK_LEASE_HOURS ?? tasks.lease_hours ?? 4),
    maxBodyBytes: Number(server.max_body_bytes ?? 1_000_000),
  };
  if (cfg.tlsCert) cfg.tlsCert = expandHome(cfg.tlsCert);
  if (cfg.tlsKey) cfg.tlsKey = expandHome(cfg.tlsKey);

  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`Invalid port: ${cfg.port}`);
  if (!(cfg.leaseHours > 0)) throw new Error(`Invalid lease_hours: ${cfg.leaseHours}`);
  if (Boolean(cfg.tlsCert) !== Boolean(cfg.tlsKey)) throw new Error("Set both tls.cert and tls.key, or neither");
  return cfg;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
