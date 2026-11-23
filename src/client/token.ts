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

export function writeToken(store: TokenStore, token: string, env: Env = process.env): void {
  if (store === "keychain") {
    // -U updates an existing item. The value is briefly visible to local `ps`; the keychain offers no stdin option.
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", token], { stdio: "ignore" });
    return;
  }
  if (store === "secret-tool") {
    execFileSync("secret-tool", ["store", "--label", SERVICE, "service", SERVICE, "account", ACCOUNT], { input: token, stdio: ["pipe", "ignore", "ignore"] });
    return;
  }
  const f = tokenFile(env);
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(f, `${token}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
}
