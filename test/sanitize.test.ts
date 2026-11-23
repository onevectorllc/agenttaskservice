// SPDX-License-Identifier: MIT
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(__dirname, "..", "scripts", "sanitize.mjs");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "ats-san-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  execFileSync("git", ["add", "-A"], { cwd: d });
  return d;
}

function check(d: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [script, "--root", d], { env: { ...process.env, SANITIZE_DENYLIST: "", ...env } });
  return { code: r.status, err: r.stderr.toString() };
}

describe("AC-9: sanitize check", () => {
  it("AC-9: clean placeholders pass", () => {
    const d = repo({ "a.md": "Run as /Users/alice/x or /home/you/x. Mail noreply@example.com. Host 127.0.0.1, api.example.internal." });
    expect(check(d).code).toBe(0);
  });

  it("AC-9: home paths, emails, private IPs, keys and tokens fail without echoing them", () => {
    const d = repo({
      "a.md": [
        // Built from parts so this file does not trip the check itself.
        ["", "Users", "realperson", "project"].join("/"),
        ["contact someone", "company.test"].join("@"),
        ["server 192", "168", "1", "20"].join("."),
        ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
        `token ats_${"x".repeat(40)}`,
        ["ssh build-box", "internal"].join("."),
      ].join("\n"),
    });
    const r = check(d);
    expect(r.code).toBe(1);
    for (const id of ["home-path", "email", "private-ip", "private-hostname", "private-key", "token"]) expect(r.err).toContain(id);
    expect(r.err).not.toContain("realperson");
  });

  it("AC-9: denylisted strings fail everywhere except LICENSE", () => {
    const d = repo({ LICENSE: "Copyright Jane Example", "README.md": "Thanks Jane Example" });
    const r = check(d, { SANITIZE_DENYLIST: "Jane Example" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("README.md:1: denylisted string");
    expect(r.err).not.toContain("LICENSE");
  });

  it("AC-9: the repo itself is clean", () => {
    expect(check(join(__dirname, "..")).code).toBe(0);
  });

  it("AC-9: every source and test file starts with an SPDX MIT header", () => {
    const root = join(__dirname, "..");
    const files = ["src", "test", "scripts"].flatMap((dir) =>
      readdirSync(join(root, dir))
        .map((f) => join(root, dir, f))
        .filter((f) => statSync(f).isFile() && /\.(ts|mjs|js)$/.test(f)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, "utf8").split("\n").slice(0, 3).join("\n"), f).toContain("SPDX-License-Identifier: MIT");
  });

  it("AC-9: LICENSE names the copyright holder", () => {
    const text = readFileSync(join(__dirname, "..", "LICENSE"), "utf8");
    expect(text).toMatch(/^MIT License/);
    expect(text).toContain(`Copyright (c) 2026 ${"One" + "Vector"} LLC`);
  });
});
