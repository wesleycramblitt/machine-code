/**
 * Mark registry entries whose owner died without writing an exit record.
 * Only records that still claim to be running are touched.
 */
import { existsSync } from "node:fs";
import { appendProcessRecord, latestProcessRecords, readProcessRecords } from "./registry.js";
import type { ProcessRecord } from "./types.js";

export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return false;
  return existsSync(`/proc/${pid}`);
}

export function reconcileProcessRecords(runDir: string, now = Date.now()): ProcessRecord[] {
  const records = latestProcessRecords(readProcessRecords(runDir));
  const reconciled: ProcessRecord[] = [];
  for (const record of records) {
    if (record.status !== "running") {
      reconciled.push(record);
      continue;
    }
    const staleNoPid = record.pid === undefined && now - Date.parse(record.startedAt) > 5 * 60_000;
    if (record.pid !== undefined && pidAlive(record.pid)) {
      reconciled.push(record);
      continue;
    }
    if (!staleNoPid && record.pid === undefined) {
      reconciled.push(record);
      continue;
    }
    const next: ProcessRecord = {
      ...record,
      status: "failed",
      endedAt: new Date(now).toISOString(),
      error: record.pid === undefined ? "process never reported a pid" : "process exited without an exit record",
    };
    appendProcessRecord(runDir, next);
    reconciled.push(next);
  }
  return reconciled;
}
