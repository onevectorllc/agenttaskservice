// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get as httpsGet, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "ats-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const noFile = { XDG_CONFIG_HOME: join(dir, "none") };

describe("AC-7: config", () => {
  it("AC-7: defaults are loopback, port 7420, 4-hour leases", () => {
    const c = loadConfig(undefined, noFile);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(7420);
    expect(c.leaseHours).toBe(4);
    expect(c.tlsCert).toBeUndefined();
  });

  it("AC-7: the TOML file sets values and env vars override it", () => {
    const file = join(dir, "server.toml");
    writeFileSync(file, `[server]\nhost = "0.0.0.0"\nport = 8000\n[storage]\ndata_dir = "/srv/ats"\n[tasks]\nlease_hours = 2\n`);
    const c = loadConfig(file, { AGENTTASK_PORT: "9000" });
    expect(c).toMatchObject({ host: "0.0.0.0", port: 9000, dataDir: "/srv/ats", leaseHours: 2 });
  });

  it("AC-7: a mistyped body limit or lease length is an error, not a silent default", () => {
    const file = join(dir, "bad.toml");
    writeFileSync(file, `[server]\nmax_body_bytes = "1MB"\n`);
    expect(() => loadConfig(file, {})).toThrow(/max_body_bytes/);
    expect(() => loadConfig(undefined, { ...noFile, AGENTTASK_LEASE_HOURS: "100000" })).toThrow(/lease_hours/);
  });

  it("AC-7: a missing explicit file, a half TLS setting and a bad port are errors", () => {
    expect(() => loadConfig(join(dir, "missing.toml"), {})).toThrow(/not found/);
    expect(() => loadConfig(undefined, { ...noFile, AGENTTASK_TLS_CERT: "/x.pem" })).toThrow(/both/);
    expect(() => loadConfig(undefined, { ...noFile, AGENTTASK_PORT: "70000" })).toThrow(/port/);
  });

  it("AC-7: with a certificate and key the server speaks HTTPS", async () => {
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], {
      stdio: "ignore",
    });
    const server = startServer(new Store(openDb(":memory:")), {
      host: "127.0.0.1",
      port: 0,
      tlsCert: cert,
      tlsKey: key,
      dataDir: "",
      leaseHours: 4,
      maxBodyBytes: 1000,
    }) as Server;
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      httpsGet({ host: "127.0.0.1", port, path: "/health", rejectUnauthorized: false }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });
    expect(JSON.parse(body).status).toBe("ok");
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("AC-8: CLI", () => {
  const cfgFile = join(dir, "cli.toml");
  writeFileSync(cfgFile, `[storage]\ndata_dir = "${join(dir, "data")}"\n`);
  const cli = (...args: string[]) => {
    const lines: string[] = [];
    const code = run([...args, "--config", cfgFile], (s) => lines.push(s));
    return { code, out: lines.join("\n") };
  };

  it("AC-8: token add prints a token once; list shows names only; revoke works", () => {
    const add = cli("token", "add", "laptop");
    expect(add.code).toBe(0);
    expect(add.out).toMatch(/^ats_/);
    const list = cli("token", "list");
    expect(list.out).toContain("laptop");
    expect(list.out).not.toContain(add.out);
    expect(cli("token", "revoke", "laptop").code).toBe(0);
    expect(cli("token", "revoke", "laptop").code).toBe(1);
    expect(cli("token", "list").out).toContain("revoked");
  });

  it("AC-8: project add and list", () => {
    expect(cli("project", "add", "video-studio", "--name", "Video", "--description", "Makes videos", "--alias", "vs").code).toBe(0);
    expect(cli("project", "list").out).toContain("video-studio\tVideo\tMakes videos");
    expect(cli("project", "add", "Bad Id").code).toBe(1);
  });

  it("AC-8: serve keeps the first admin token out of its output and in a 0600 file", async () => {
    const dataDir = join(dir, "serve-data");
    const file = join(dir, "serve.toml");
    writeFileSync(file, `[server]\nport = 0\n[storage]\ndata_dir = "${dataDir}"\n`);
    const lines: string[] = [];
    let server: import("node:net").Server | undefined;
    expect(run(["serve", "--config", file], (s) => lines.push(s), { onServer: (s) => (server = s) })).toBe(0);
    try {
      expect(lines.join("\n")).not.toMatch(/ats_/);
      const tokenFile = join(dataDir, "admin-token");
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const token = readFileSync(tokenFile, "utf8").trim();
      expect(new Store(openDb(join(dataDir, "agenttaskservice.db"))).authenticate(token)).toBe("admin");
    } finally {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    }
  });

  it("AC-8: unknown commands print usage and fail", () => {
    const r = cli("frobnicate");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Commands:");
  });
});
