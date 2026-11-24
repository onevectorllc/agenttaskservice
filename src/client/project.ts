// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";

type Env = Record<string, string | undefined>;

export interface ProjectGuess {
  id: string;
  source: "env" | "file" | "workspace" | "git-remote" | "git-root" | "folder";
}

/** Lowercase and replace anything outside the project id rule with '-'. */
export function normaliseProjectId(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return s || "default";
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `.agenttask` in the directory or a parent, stopping at the git root (or the filesystem root). */
function findMarker(start: string, stop: string | undefined): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const f = join(dir, ".agenttask");
    if (existsSync(f)) {
      const t = parse(readFileSync(f, "utf8")) as { project?: unknown };
      if (typeof t.project === "string" && t.project.trim()) return t.project;
    }
    if (stop && resolve(dir) === resolve(stop)) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Repo name from a remote URL: git@host:owner/repo.git or https://host/owner/repo. */
export function repoNameFromRemote(url: string): string | undefined {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

export function detectProject(cwd: string, opts: { workspaceRoot?: string; env?: Env } = {}): ProjectGuess {
  const env = opts.env ?? process.env;
  if (env.AGENTTASK_PROJECT) return { id: normaliseProjectId(env.AGENTTASK_PROJECT), source: "env" };

  const gitRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  const marker = findMarker(cwd, gitRoot);
  if (marker) return { id: normaliseProjectId(marker), source: "file" };

  if (opts.workspaceRoot) {
    const rel = relative(resolve(opts.workspaceRoot), resolve(cwd));
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) {
      return { id: normaliseProjectId(rel.split(sep)[0]), source: "workspace" };
    }
  }

  if (gitRoot) {
    const remote = git(gitRoot, ["remote", "get-url", "origin"]);
    const name = remote && repoNameFromRemote(remote);
    if (name) return { id: normaliseProjectId(name), source: "git-remote" };
    return { id: normaliseProjectId(basename(gitRoot)), source: "git-root" };
  }
  return { id: normaliseProjectId(basename(resolve(cwd))), source: "folder" };
}
