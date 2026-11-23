// SPDX-License-Identifier: MIT
import type { Conn } from "./api.js";
import { loadClientConfig, urlProblem } from "./config.js";
import { readToken } from "./token.js";

type Env = Record<string, string | undefined>;

/**
 * The server connection, or undefined when this machine is not set up.
 * Throws when the URL would send the token in clear text (plain http beyond loopback).
 */
export function connect(env: Env = process.env, timeoutMs?: number): Conn | undefined {
  const cfg = loadClientConfig(env);
  if (!cfg.url) return undefined;
  const problem = urlProblem(cfg.url, cfg.allowInsecureHttp);
  if (problem) throw new Error(problem);
  const token = readToken(cfg.tokenStore, env);
  if (!token) return undefined;
  return { url: cfg.url, token, timeoutMs };
}
