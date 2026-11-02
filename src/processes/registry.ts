/**
 * machine_code — per-run process registry.
 *
 * `processes.jsonl` is append-only so a crash cannot corrupt earlier records.
 * The supervisor appends once at start and again at exit/kill.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessRecord } from "./types.js";

export function processesDir(runDir: string): string {
  return join(runDir, "processes");
}

export function processesFile(runDir: string): string {
  return join(runDir, "processes.jsonl");
}

export function processLogPaths(runDir: string, id: string): { stdout: string; stderr: string } {
  const dir = processesDir(runDir);
  return { stdout: join(dir, `${id}.stdout.log`), stderr: join(dir, `${id}.stderr.log`) };
}

export function readProcessRecords(runDir: string): ProcessRecord[] {
  const file = processesFile(runDir);
  if (!existsSync(file)) return [];
  const records: ProcessRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ProcessRecord);
    } catch {
      // A torn final line is possible after a crash; earlier records stay valid.
    }
  }
  return records;
}

export function appendProcessRecord(runDir: string, record: ProcessRecord): void {
  mkdirSync(dirname(processesFile(runDir)), { recursive: true });
  mkdirSync(processesDir(runDir), { recursive: true });
  appendFileSync(processesFile(runDir), JSON.stringify(record) + "\n", "utf8");
}

/** Highest numeric suffix + 1, formatted as p-0001. */
export function nextProcessId(records: readonly ProcessRecord[]): string {
  let max = 0;
  for (const record of records) {
    const match = /^p-(\d+)$/.exec(record.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `p-${String(max + 1).padStart(4, "0")}`;
}

export function liveProcessRecords(records: readonly ProcessRecord[]): ProcessRecord[] {
  return records.filter((record) => record.status === "running");
}
