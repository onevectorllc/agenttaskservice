#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Fails when tracked files (or commit authors) contain personal or secret data:
// home-directory paths, real email addresses, private IP addresses, key material
// and API tokens. Extra private strings (names, domains, hostnames) are read from
// the SANITIZE_DENYLIST env var or a local, untracked .sanitize-denylist file,
// one per line, so the strings themselves never enter the repo.
//
// Usage: node scripts/sanitize.mjs [--commits <git range>] [--root <dir>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = opt("--root") ?? process.cwd();
const commitRange = opt("--commits");

/** Files that may carry names by the owner's choice. */
const ALLOWED_NAME_FILES = new Set(["LICENSE"]);
const SKIP_FILES = new Set(["package-lock.json"]);

const PLACEHOLDER_USERS = new Set(["alice", "bob", "you", "user", "example", "runner", "node"]);
const EMAIL_OK = [/@example\.(com|org|net)$/i, /^noreply@/i, /@users\.noreply\.github\.com$/i];

const RULES = [
  {
    id: "home-path",
    re: /(?:\/Users|\/home)\/([A-Za-z0-9._-]+)/g,
    ok: (m) => PLACEHOLDER_USERS.has(m[1].toLowerCase()) || m[1] === "<name>",
  },
  { id: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ok: (m) => EMAIL_OK.some((r) => r.test(m[0])) },
  { id: "private-ip", re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "token", re: /\b(?:ats_[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9-]{30,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{20,})/g },
];

function denylist() {
  const lines = [];
  if (process.env.SANITIZE_DENYLIST) lines.push(...process.env.SANITIZE_DENYLIST.split(/\r?\n/));
  const local = join(root, ".sanitize-denylist");
  if (existsSync(local)) lines.push(...readFileSync(local, "utf8").split(/\r?\n/));
  return lines.map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

function scanText(text, file, deny, findings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.ok?.(m)) continue;
        findings.push(`${file}:${i + 1}: ${rule.id}`);
      }
    }
    if (!ALLOWED_NAME_FILES.has(file)) {
      const lower = line.toLowerCase();
      for (const d of deny) if (lower.includes(d.toLowerCase())) findings.push(`${file}:${i + 1}: denylisted string`);
    }
  });
}

export function sanitize() {
  const deny = denylist();
  const findings = [];
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    const buf = readFileSync(join(root, file));
    if (buf.includes(0)) continue; // binary
    scanText(buf.toString("utf8"), file, deny, findings);
  }
  if (commitRange) {
    const log = execFileSync("git", ["log", "--format=%an <%ae>%n%cn <%ce>%n%B", commitRange], { cwd: root }).toString();
    scanText(log, `commits(${commitRange})`, deny, findings);
  }
  return findings;
}

const findings = sanitize();
if (findings.length) {
  // Report locations and rule ids only, never the matched text.
  console.error(`sanitize: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log("sanitize: clean");
