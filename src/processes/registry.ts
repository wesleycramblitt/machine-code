/**
 * machine_code — per-run process registry.
 *
 * `processes.jsonl` is append-only so a crash cannot corrupt earlier records.
 * The supervisor appends once at start and again at exit/kill.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessRecord } from "./types.js";

/**
 * Per-run id allocators. The supervisor is the only writer for a run
 * directory, so the next id lives in memory after one seed read; a spawn must
 * never re-parse the append-only log (that made every spawn O(records) and the
 * whole run O(spawns²)).
 */
const nextNumberByRun = new Map<string, number>();

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

function formatProcessId(n: number): string {
  return `p-${String(n).padStart(4, "0")}`;
}

/**
 * Highest process number already recorded in the run directory. Ids are
 * monotonic and each record starts with `{"id":"p-NNNN"`, so the tail of the
 * file is enough; the scan widens only if the tail has no record at all.
 */
export function lastProcessNumber(runDir: string): number {
  const file = processesFile(runDir);
  if (!existsSync(file)) return 0;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    let window = 64 * 1024;
    for (;;) {
      const length = Math.min(size, window);
      const start = size - length;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      let max = 0;
      const pattern = /"id"\s*:\s*"p-(\d+)"/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(buffer.toString("utf8"))) !== null) {
        max = Math.max(max, Number(match[1]));
      }
      if (max > 0 || start === 0) return max;
      window *= 4;
    }
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Allocate the next process id without reading the log again. Safe because a
 * run directory has exactly one supervisor writer; a resumed run re-seeds from
 * the tail once.
 */
export function allocateProcessId(runDir: string): string {
  let next = nextNumberByRun.get(runDir);
  if (next === undefined) next = lastProcessNumber(runDir) + 1;
  nextNumberByRun.set(runDir, next + 1);
  return formatProcessId(next);
}

/** Latest record per process id, preserving first-seen order. */
export function latestProcessRecords(records: readonly ProcessRecord[]): ProcessRecord[] {
  const latest = new Map<string, ProcessRecord>();
  for (const record of records) latest.set(record.id, record);
  return [...latest.values()];
}

export function liveProcessRecords(records: readonly ProcessRecord[]): ProcessRecord[] {
  return latestProcessRecords(records).filter((record) => record.status === "running");
}
