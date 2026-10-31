/**
 * machine_code — instance registration.
 *
 * Each machine_code process registers a PID/heartbeat file in
 * ~/.machine_code/instances/. Other processes (the TUI) list these to
 * discover running owners. A dead owner is never restarted; its runs are
 * reported as interrupted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InstanceInfo {
  pid: number;
  startedAt: string;
  heartbeat: string;
  repoRoot?: string;
}

export function instanceDir(home: string): string {
  return join(home, "instances");
}

export function registerInstance(home: string, repoRoot?: string): string {
  const dir = instanceDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  const info: InstanceInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    repoRoot,
  };
  writeFileSync(file, JSON.stringify(info) + "\n", "utf8");
  return file;
}

export function heartbeatInstance(home: string): void {
  const file = join(instanceDir(home), `${process.pid}.json`);
  if (!existsSync(file)) return;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as InstanceInfo;
    info.heartbeat = new Date().toISOString();
    writeFileSync(file, JSON.stringify(info) + "\n", "utf8");
  } catch {
    // ignore
  }
}

export function unregisterInstance(home: string): void {
  const file = join(instanceDir(home), `${process.pid}.json`);
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
}

export function listInstances(home: string): InstanceInfo[] {
  const dir = instanceDir(home);
  if (!existsSync(dir)) return [];
  const out: InstanceInfo[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const info = JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as InstanceInfo;
        if (existsSync(`/proc/${info.pid}`)) out.push(info);
      } catch {
        // stale/corrupt — remove
        try { rmSync(join(dir, entry.name), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch {
    // unreadable
  }
  return out;
}
