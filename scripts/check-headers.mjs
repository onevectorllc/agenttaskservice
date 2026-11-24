#!/usr/bin/env node
// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
// Every tracked source file and doc must start with the copyright line (within its first three lines,
// to leave room for a shebang or an XML declaration). Files that can't hold a comment are skipped.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const root = resolve(args.includes("--root") ? args[args.indexOf("--root") + 1] : process.cwd());
// The holder comes from LICENSE ("Copyright (c) <year> <holder>"), so this script names nobody itself.
const license = /^Copyright \(c\) \d{4} (.+?)\s*$/m.exec(readFileSync(join(root, "LICENSE"), "utf8"));
if (!license) {
  console.error('check-headers: LICENSE has no "Copyright (c) <year> <holder>" line');
  process.exit(1);
}
const holder = license[1];
const LINE = new RegExp(`Copyright \\(c\\) \\d{4} ${holder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const CHECKED = /\.(ts|mjs|js|md|yml|yaml|toml|service|plist)$|^\.gitignore$|(^|\/)tsconfig\.json$/;

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
const missing = files.filter((f) => CHECKED.test(f) && !LINE.test(readFileSync(join(root, f), "utf8").split("\n").slice(0, 3).join("\n")));
if (missing.length) {
  console.error(`check-headers: ${missing.length} file(s) do not start with "Copyright (c) <year> ${holder}":`);
  for (const f of missing) console.error(`  ${f}`);
  process.exit(1);
}
console.log("check-headers: ok");
