/**
 * machine_code — run directories: run.json + append-only events.jsonl.
 *
 * One writer per run (the owning process). run.json is the summary other
 * processes read; events.jsonl is the detail. Both are plain JSON, readable
 * without any tool — including after a SIGINT.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";

export type RunStatus = "running" | "done" | "blocked" | "failed" | "interrupted";

export interface RunSummary {
  id: string;
  agent: string;
  mode: string;
  request: string;
  status: RunStatus;
  pid: number;
  startedAt: string;
  endedAt?: string;
  turns: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  cost: { actual: number; estimated: number };
  modelCalls: number;
  error?: string;
}

export interface RunEvent {
  t: string;
  type: string;
  [key: string]: unknown;
}

function runId(): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export class RunRecorder {
  readonly id: string;
  readonly dir: string;
  private readonly summaryFile: string;
  private readonly eventsFile: string;
  private summary: RunSummary;
  private finalized = false;

  constructor(layout: Layout, init: { agent: string; mode: string; request: string }) {
    this.id = runId();
    this.dir = join(layout.runsDir, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.summaryFile = join(this.dir, "run.json");
    this.eventsFile = join(this.dir, "events.jsonl");
    this.summary = {
      id: this.id,
      agent: init.agent,
      mode: init.mode,
      request: init.request,
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      cost: { actual: 0, estimated: 0 },
      modelCalls: 0,
    };
    this.writeSummary();
    this.event("run_start", { agent: init.agent, mode: init.mode, request: init.request });
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.finalized && type !== "run_end") return;
    const line: RunEvent = { t: new Date().toISOString(), type, ...data };
    appendFileSync(this.eventsFile, JSON.stringify(line) + "\n", "utf8");
  }

  recordCall(usage: RunSummary["usage"], costTotal: number | null, estimatedCost: number): void {
    this.summary.modelCalls += 1;
    this.summary.usage.input += usage.input;
    this.summary.usage.output += usage.output;
    this.summary.usage.cacheRead += usage.cacheRead;
    this.summary.usage.cacheWrite += usage.cacheWrite;
    this.summary.usage.totalTokens += usage.totalTokens;
    if (costTotal !== null && Number.isFinite(costTotal)) {
      this.summary.cost.actual += costTotal;
    } else {
      this.summary.cost.estimated += estimatedCost;
    }
    this.summary.turns += 1;
    this.writeSummary();
  }

  finalize(status: RunStatus, error?: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.summary.status = status;
    this.summary.endedAt = new Date().toISOString();
    if (error) this.summary.error = error;
    this.writeSummary();
    const line: RunEvent = { t: new Date().toISOString(), type: "run_end", status, ...(error ? { error } : {}) };
    appendFileSync(this.eventsFile, JSON.stringify(line) + "\n", "utf8");
  }

  get current(): RunSummary {
    return { ...this.summary };
  }

  private writeSummary(): void {
    writeFileSync(this.summaryFile, JSON.stringify(this.summary, null, 2) + "\n", "utf8");
  }
}

export function readRun(layout: Layout, id: string): { summary: RunSummary; events: RunEvent[] } | null {
  const dir = join(layout.runsDir, id);
  const summaryFile = join(dir, "run.json");
  if (!existsSync(summaryFile)) return null;
  const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as RunSummary;
  const eventsFile = join(dir, "events.jsonl");
  const events: RunEvent[] = existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RunEvent)
    : [];
  return { summary, events };
}

export function listRuns(layout: Layout): RunSummary[] {
  if (!existsSync(layout.runsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(layout.runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const entry of entries) {
    const summaryFile = join(layout.runsDir, entry, "run.json");
    try {
      out.push(JSON.parse(readFileSync(summaryFile, "utf8")) as RunSummary);
    } catch {
      // partial run dir — skip
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
