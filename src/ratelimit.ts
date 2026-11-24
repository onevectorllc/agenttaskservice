// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import type { IncomingMessage } from "node:http";
import { isLoopback } from "./config.js";

/**
 * Counts failures per client in a sliding window, plus a global cap. Used for sign-in and pairing attempts.
 * A request with no usable client key (see clientKey) counts only toward the global cap.
 */
export class FailureLimit {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private perKey = 10,
    private global = 100,
    private windowMs = 10 * 60_000,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Drop keys with no recent failures, at most once a window, so the map can't grow without bound. */
  private sweep(): void {
    if (this.now() - this.lastSweep < this.windowMs) return;
    this.lastSweep = this.now();
    for (const k of [...this.hits.keys()]) this.recent(k);
  }

  blocked(key: string | undefined): boolean {
    this.sweep();
    return (key !== undefined && this.recent(key).length >= this.perKey) || this.recent("*").length >= this.global;
  }

  fail(key: string | undefined): void {
    for (const k of key === undefined ? ["*"] : [key, "*"]) this.hits.set(k, [...this.recent(k), this.now()]);
  }

  /** Number of keys tracked (for tests). */
  get size(): number {
    return this.hits.size;
  }
}

/**
 * The client address to rate limit by. With trustProxy and a loopback peer (a proxy on this host), the last
 * X-Forwarded-For entry, which that proxy added.
 * Without it, a loopback peer is taken to be a reverse proxy shared by everyone, so it gets no key of its own:
 * one client's failures must not lock out every user.
 */
export function clientKey(req: IncomingMessage, trustProxy = false): string | undefined {
  const peer = req.socket.remoteAddress ?? "";
  // Only a proxy on this host may speak for the client: a direct caller could forge the header.
  if (trustProxy && isLoopback(peer.replace(/^::ffff:/, ""))) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (fwd) return fwd;
  }
  const bare = peer.replace(/^::ffff:/, "");
  if (!bare || (isLoopback(bare) && !trustProxy)) return undefined;
  return bare;
}
