// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./config.js";

type Env = Record<string, string | undefined>;

export interface WorkJob {
  inbox: string;
  /** Minutes between runs. */
  every: number;
  /** Folder the headless session works in. */
  dir: string;
  promptFile?: string;
  /** How to run this CLI, as argv (e.g. ["agenttaskservice"] or [node, script]). */
  self: string[];
  /** PATH for the job, so it finds `claude` and `node` (launchd and systemd start with a bare PATH). */
  path: string;
}

export interface ScheduleStep {
  what: string;
  apply: () => void;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** systemd command-line quoting: double quotes, with \ " $ % escaped. */
const sd = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$").replace(/%/g, "%%")}"`;

export function jobLabel(inbox: string): string {
  return `io.github.agenttaskservice.work.${inbox}`;
}

function homeOf(env: Env): string {
  return env.HOME || homedir();
}

export function workArgv(job: WorkJob): string[] {
  return [...job.self, "work", "--inbox", job.inbox, "--dir", job.dir, ...(job.promptFile ? ["--prompt-file", job.promptFile] : [])];
}

export function launchdPlist(job: WorkJob, env: Env = process.env): string {
  const log = join(stateDir(env), `work-${job.inbox}.log`);
  const args = workArgv(job)
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(jobLabel(job.inbox))}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(job.path)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${Math.round(job.every * 60)}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function systemdUnits(job: WorkJob): { service: string; timer: string } {
  return {
    service: `[Unit]
Description=agenttaskservice: handle the ${job.inbox} inbox

[Service]
Type=oneshot
Environment=${sd(`PATH=${job.path}`)}
ExecStart=${workArgv(job).map(sd).join(" ")}
`,
    timer: `[Unit]
Description=agenttaskservice: handle the ${job.inbox} inbox every ${job.every} min

[Timer]
OnBootSec=5min
OnUnitActiveSec=${job.every}min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

function run(cmd: string, args: string[], env: Env): { ok: boolean; err: string } {
  const r = spawnSync(cmd, args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] });
  return { ok: r.status === 0, err: r.error?.message ?? r.stderr?.toString().trim() ?? "" };
}

/**
 * Steps that install (every > 0) or remove (every = 0) the scheduled job for one inbox.
 * macOS uses a launchd agent; Linux a systemd user timer.
 */
export function scheduleSteps(job: WorkJob, platform: NodeJS.Platform, env: Env = process.env): ScheduleStep[] {
  const home = homeOf(env);
  if (platform === "darwin") {
    const label = jobLabel(job.inbox);
    const file = join(home, "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${process.getuid?.() ?? ""}`;
    if (job.every <= 0) {
      if (!existsSync(file)) return [];
      return [
        {
          what: `Remove the scheduled job ${label}`,
          apply: () => {
            run("launchctl", ["bootout", `${domain}/${label}`], env);
            rmSync(file, { force: true });
          },
        },
      ];
    }
    return [
      {
        what: `Schedule \`work --inbox ${job.inbox}\` every ${job.every} min with launchd (${file})`,
        apply: () => {
          mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
          mkdirSync(stateDir(env), { recursive: true });
          writeFileSync(file, launchdPlist(job, env));
          run("launchctl", ["bootout", `${domain}/${label}`], env); // not loaded yet is fine
          const r = run("launchctl", ["bootstrap", domain, file], env);
          if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.err}`);
        },
      },
    ];
  }
  if (platform === "linux") {
    const dir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user");
    const name = `agenttaskservice-work-${job.inbox}`;
    if (job.every <= 0) {
      if (!existsSync(join(dir, `${name}.timer`))) return [];
      return [
        {
          what: `Remove the scheduled job ${name}.timer`,
          apply: () => {
            run("systemctl", ["--user", "disable", "--now", `${name}.timer`], env);
            rmSync(join(dir, `${name}.timer`), { force: true });
            rmSync(join(dir, `${name}.service`), { force: true });
            run("systemctl", ["--user", "daemon-reload"], env);
          },
        },
      ];
    }
    return [
      {
        what: `Schedule \`work --inbox ${job.inbox}\` every ${job.every} min with a systemd user timer (${dir}/${name}.timer)`,
        apply: () => {
          const u = systemdUnits(job);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${name}.service`), u.service);
          writeFileSync(join(dir, `${name}.timer`), u.timer);
          run("systemctl", ["--user", "daemon-reload"], env);
          const r = run("systemctl", ["--user", "enable", "--now", `${name}.timer`], env);
          if (!r.ok) throw new Error(`systemctl enable failed: ${r.err}`);
        },
      },
    ];
  }
  throw new Error(`scheduling is not supported on ${platform}; run \`agenttaskservice work --inbox ${job.inbox}\` from your own scheduler`);
}
