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

export interface SpendBucket {
  actual: number;
  estimated: number;
  calls: number;
  /** Billable token volume. */
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SpendSummary {
  totalActual: number;
  totalEstimated: number;
  totalTokens: number;
  byProvider: Record<string, SpendBucket>;
  byModel: Record<string, SpendBucket>;
  byAgent: Record<string, SpendBucket>;
  byDay: Record<string, SpendBucket>;
  byProject: Record<string, SpendBucket>;
}

export interface SpendQuery {
  /** Include records whose UTC day is within the last N days. */
  days?: number;
  provider?: string;
  model?: string;
  agent?: string;
  project?: string;
}

function emptyBucket(): SpendBucket {
  return { actual: 0, estimated: 0, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function add(bucket: SpendBucket, rec: SpendRecord): void {
  const actual = rec.cost.actual ?? 0;
  const tokens = rec.usage.totalTokens || rec.usage.input + rec.usage.output + rec.usage.cacheRead + rec.usage.cacheWrite;
  bucket.actual += actual;
  bucket.estimated += rec.cost.estimated;
  bucket.calls += 1;
  bucket.tokens += tokens;
  bucket.input += rec.usage.input;
  bucket.output += rec.usage.output;
  bucket.cacheRead += rec.usage.cacheRead;
  bucket.cacheWrite += rec.usage.cacheWrite;
}

function matches(rec: SpendRecord, query: SpendQuery): boolean {
  if (query.provider && rec.provider !== query.provider) return false;
  if (query.agent && rec.agent !== query.agent) return false;
  if (query.project && rec.repoRoot !== query.project) return false;
  if (query.model && !(rec.model === query.model || `${rec.provider}/${rec.model}` === query.model)) return false;
  if (query.days !== undefined) {
    const cutoff = Date.now() - query.days * 24 * 60 * 60 * 1000;
    const t = new Date(rec.t).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
  }
  return true;
}

export function readSpendRecords(home: string): SpendRecord[] {
  const file = spendFile(home);
  if (!existsSync(file)) return [];
  const out: SpendRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SpendRecord);
    } catch {
      // skip a partial/corrupt append; never fail the whole view
    }
  }
  return out;
}

export function summarizeSpend(records: readonly SpendRecord[]): SpendSummary {
  const summary: SpendSummary = {
    totalActual: 0,
    totalEstimated: 0,
    totalTokens: 0,
    byProvider: {},
    byModel: {},
    byAgent: {},
    byDay: {},
    byProject: {},
  };
  for (const rec of records) {
    const actual = rec.cost.actual ?? 0;
    const tokens = rec.usage.totalTokens || rec.usage.input + rec.usage.output + rec.usage.cacheRead + rec.usage.cacheWrite;
    summary.totalActual += actual;
    summary.totalEstimated += rec.cost.estimated;
    summary.totalTokens += tokens;
    const day = rec.t.slice(0, 10);
    for (const [bucket, key] of [
      [summary.byProvider, rec.provider],
      [summary.byModel, `${rec.provider}/${rec.model}`],
      [summary.byAgent, rec.agent || "unknown"],
      [summary.byDay, day],
      [summary.byProject, rec.repoRoot],
    ] as Array<[Record<string, SpendBucket>, string]>) {
      const entry = bucket[key] ?? emptyBucket();
      add(entry, rec);
      bucket[key] = entry;
    }
  }
  return summary;
}

/** Read and optionally filter the ledger. */
export function readSpendSummary(home: string, query: SpendQuery = {}): SpendSummary {
  return summarizeSpend(readSpendRecords(home).filter((rec) => matches(rec, query)));
}

/** Chronological daily totals, with missing days filled so charts stay stable. */
export function spendDays(summary: SpendSummary, days: number): Array<{ day: string; bucket: SpendBucket }> {
  const out: Array<{ day: string; bucket: SpendBucket }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const day = d.toISOString().slice(0, 10);
    out.push({ day, bucket: summary.byDay[day] ?? emptyBucket() });
  }
  return out;
}

/** A compact Unicode bar for spend/cost visualizations. */
export function spendBar(value: number, max: number, width: number): string {
  if (width <= 0) return "";
  if (max <= 0 || value <= 0) return " ".repeat(width);
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(Math.min(width, filled)).padEnd(width, " ");
}
