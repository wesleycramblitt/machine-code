/**
 * machine_code — machine-wide spend ledger (~/.machine_code/spend.jsonl).
 *
 * Append-only: one record per provider call attempt, linked by a unique call
 * ID. Other processes read it for status/spend views. Never rewritten.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SpendRecord {
  id: string;
  t: string;
  repoRoot: string;
  runId: string;
  agent: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  cost: {
    actual: number | null;
    estimated: number;
  };
  stopReason: string;
}

export function spendFile(home: string): string {
  return join(home, "spend.jsonl");
}

export function appendSpendRecord(home: string, record: SpendRecord): void {
  mkdirSync(join(home), { recursive: true });
  const line = JSON.stringify(record);
  // Cap at 4 KiB per plan.
  const capped = line.length > 4096 ? line.slice(0, 4093) + "..." : line;
  appendFileSync(spendFile(home), capped + "\n", "utf8");
}

export interface SpendSummary {
  totalActual: number;
  totalEstimated: number;
  byProvider: Record<string, { actual: number; estimated: number; calls: number }>;
  byModel: Record<string, { actual: number; estimated: number; calls: number }>;
  byDay: Record<string, { actual: number; estimated: number; calls: number }>;
  byProject: Record<string, { actual: number; estimated: number; calls: number }>;
}

export function readSpendSummary(home: string): SpendSummary {
  const summary: SpendSummary = {
    totalActual: 0,
    totalEstimated: 0,
    byProvider: {},
    byModel: {},
    byDay: {},
    byProject: {},
  };
  const file = spendFile(home);
  if (!existsSync(file)) return summary;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: SpendRecord;
    try { rec = JSON.parse(line) as SpendRecord; } catch { continue; }
    const actual = rec.cost.actual ?? 0;
    const estimated = rec.cost.estimated;
    summary.totalActual += actual;
    summary.totalEstimated += estimated;
    const day = rec.t.slice(0, 10);
    for (const [bucket, key] of [
      [summary.byProvider, rec.provider],
      [summary.byModel, `${rec.provider}/${rec.model}`],
      [summary.byDay, day],
      [summary.byProject, rec.repoRoot],
    ] as Array<[Record<string, { actual: number; estimated: number; calls: number }>, string]>) {
      const entry = bucket[key] ?? { actual: 0, estimated: 0, calls: 0 };
      entry.actual += actual;
      entry.estimated += estimated;
      entry.calls += 1;
      bucket[key] = entry;
    }
  }
  return summary;
}