/**
 * machine_code — run directories: run.json + append-only events.jsonl.
 *
 * One writer per run (the owning process). run.json is the summary other
 * processes read; events.jsonl is the detail. Both are plain JSON, readable
 * without any tool — including after a SIGINT. run.json is written atomically
 * (temp + rename); events.jsonl is append-only and never rewritten.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { summarizeRun, readStateView, type StopReason } from "./outcome.js";
import {
  SCHEMA_VERSION,
  isActiveStatus,
  isTerminalStatus,
  migrateRunSummary,
  writeJsonAtomic,
  type RunSettingsSnapshot,
  type RunStatus,
  type RunSummary,
} from "./run-schema.js";

export { SCHEMA_VERSION, isActiveStatus, isTerminalStatus, normalizeStatus } from "./run-schema.js";
export type { RunCost, RunSettingsSnapshot, RunStatus, RunSummary, RunUsage } from "./run-schema.js";

const PROJECTS_FILE = (home: string) => join(home, "projects.jsonl");

/** Register a project root in the machine-wide project registry (deduped). */
export function registerProject(home: string, repoRoot: string): void {
  const file = PROJECTS_FILE(home);
  mkdirSync(join(home), { recursive: true });
  let existing = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim()) existing.add(line.trim());
    }
  }
  if (existing.has(repoRoot)) return;
  appendFileSync(file, repoRoot + "\n", "utf8");
}

/** List all registered project roots. */
export function listProjects(home: string): string[] {
  const file = PROJECTS_FILE(home);
  if (!existsSync(file)) return [];
  const out = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim()) out.add(line.trim());
  }
  return [...out];
}

/** A process is alive if /proc/<pid> exists. */
export function isPidAlive(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}

/**
 * Send a sequenced control request to a run (interrupt/cancel/pause). The
 * owning process polls `control` every 500 ms and acks to `control.ack`.
 */
export function sendControl(
  repoRoot: string,
  runId: string,
  action: "interrupt" | "cancel" | "pause",
  data: Record<string, unknown> = {},
): number {
  const dir = join(repoRoot, ".machine_code", "local", "runs", runId);
  mkdirSync(dir, { recursive: true });
  let seq = 1;
  const ackFile = join(dir, "control.ack");
  try {
    const ack = JSON.parse(readFileSync(ackFile, "utf8")) as { seq?: number };
    if (typeof ack.seq === "number") seq = ack.seq + 1;
  } catch {
    // no ack yet
  }
  writeFileSync(join(dir, "control"), JSON.stringify({ seq, action, from: process.pid, ...data }) + "\n", "utf8");
  return seq;
}

/** Wait (bounded) for the run to ack a control sequence. */
export async function waitForControlAck(
  repoRoot: string,
  runId: string,
  seq: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  const ackFile = join(repoRoot, ".machine_code", "local", "runs", runId, "control.ack");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ack = JSON.parse(readFileSync(ackFile, "utf8")) as { seq?: number };
      if (typeof ack.seq === "number" && ack.seq >= seq) return true;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Reconcile a run: if it still holds an execution slot (running/created) but
 * the owner is dead, mark interrupted. Paused/awaiting_input runs survive
 * owner death by design.
 */
export function reconcileRun(summary: RunSummary): RunSummary {
  if (
    (summary.status === "running" || summary.status === "created") &&
    !isPidAlive(summary.pid)
  ) {
    summary.status = "interrupted";
    const now = new Date().toISOString();
    summary.endedAt = now;
    summary.lastActivityAt = now;
  }
  return summary;
}

/** List runs across all registered projects. */
export function listAllRuns(home: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const project of listProjects(home)) {
    const runsDir = join(project, ".machine_code", "local", "runs");
    if (!existsSync(runsDir)) continue;
    try {
      const entries = readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const entry of entries) {
        const summaryFile = join(runsDir, entry, "run.json");
        try {
          const summary = migrateRunSummary(JSON.parse(readFileSync(summaryFile, "utf8")));
          if (!summary) continue;
          if (!summary.repoRoot) summary.repoRoot = project;
          out.push(reconcileRun(summary));
        } catch {
          // partial run dir — skip
        }
      }
    } catch {
      // unreadable — skip
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Prune runs older than `days` days, skipping any active/interrupted run. */
export function pruneRuns(home: string, days: number): { removed: number; skipped: number } {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let skipped = 0;
  for (const project of listProjects(home)) {
    const runsDir = join(project, ".machine_code", "local", "runs");
    if (!existsSync(runsDir)) continue;
    try {
      const entries = readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const entry of entries) {
        const dir = join(runsDir, entry);
        const summaryFile = join(dir, "run.json");
        let summary: RunSummary | null = null;
        try {
          summary = migrateRunSummary(JSON.parse(readFileSync(summaryFile, "utf8")));
        } catch {
          // no summary — remove as stale
        }
        if (summary && isActiveStatus(summary.status)) {
          skipped += 1;
          continue;
        }
        if (summary && new Date(summary.startedAt).getTime() > cutoff) {
          skipped += 1;
          continue;
        }
        try {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        } catch {
          skipped += 1;
        }
      }
    } catch {
      // unreadable — skip
    }
  }
  return { removed, skipped };
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

  constructor(
    layout: Layout,
    init: {
      agent: string;
      mode: string;
      request: string;
      repoRoot: string;
      packetId?: string;
      itemId?: string;
      forkedFrom?: string;
      parentRunId?: string;
      rootRunId?: string;
      forkReason?: "user_interrupt" | "manual" | "resume";
      preset?: string;
      delegate?: boolean;
      verification?: string;
          ask?: boolean;
      approval?: string;
      ambiguity?: string;
      capabilities?: string[];
      settings?: RunSettingsSnapshot;
            orchestrationId?: string;
      orchestrationScope?: "project" | "epic" | "feature";
                  attempt?: number;
      phase?: string;
      planSnapshotHash?: string;
      planReview?: "agent" | "human";
      resultReview?: "agent" | "human";
      processCount?: number;
      liveProcessCount?: number;
    },
    existing?: RunSummary,
  ) {
    if (existing) {
      // Reopen an existing run (resume): same id, same dir, new owner process.
      this.id = existing.id;
      this.dir = join(layout.runsDir, this.id);
      this.summaryFile = join(this.dir, "run.json");
      this.eventsFile = join(this.dir, "events.jsonl");
      this.summary = existing;
      this.finalized = false;
      // A resumed run is live again; derive a fresh summary on its next
      // finalize instead of showing the previous lifecycle's outcome. Terminal
      // runs are reopened only to append approval/closure evidence, so keep
      // their existing summary.
      if (!isTerminalStatus(existing.status)) {
        this.summary.summary = undefined;
        this.summary.stopReason = undefined;
      }
      // Consume any stale control request: it was already handled by the
      // previous owner (e.g. the pause that preceded this resume). Without
      // this, the new process would replay it on its first poll.
      try {
        rmSync(join(this.dir, "control"), { force: true });
      } catch {
        // ignore
      }
      return;
    }
    this.id = runId();
    this.dir = join(layout.runsDir, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.summaryFile = join(this.dir, "run.json");
    this.eventsFile = join(this.dir, "events.jsonl");
    const now = new Date().toISOString();
    this.summary = {
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      repoRoot: init.repoRoot,
      packetId: init.packetId,
      ...(init.itemId ? { itemId: init.itemId } : {}),
      ...(init.forkedFrom ? { forkedFrom: init.forkedFrom } : {}),
      agent: init.agent,
      mode: init.mode,
      request: init.request,
      status: "running",
      pid: process.pid,
      startedAt: now,
      lastActivityAt: now,
      turns: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        contextChars: 0,
        contextTokens: 0,
        peakContextChars: 0,
        peakContextTokens: 0,
      },
      cost: { actual: 0, estimated: 0 },
      modelCalls: 0,
      ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
      ...(init.rootRunId ? { rootRunId: init.rootRunId } : {}),
      ...(init.forkReason ? { forkReason: init.forkReason } : {}),
      ...(init.preset !== undefined ? { preset: init.preset } : {}),
      ...(init.delegate !== undefined ? { delegate: init.delegate } : {}),
      ...(init.verification !== undefined ? { verification: init.verification } : {}),
        ...(init.ask !== undefined ? { ask: init.ask } : {}),
      ...(init.approval !== undefined ? { approval: init.approval } : {}),
      ...(init.ambiguity !== undefined ? { ambiguity: init.ambiguity } : {}),
      ...(init.capabilities !== undefined ? { capabilities: init.capabilities } : {}),
      ...(init.settings !== undefined ? { settings: init.settings } : {}),
        ...(init.orchestrationId !== undefined ? { orchestrationId: init.orchestrationId } : {}),
      ...(init.orchestrationScope !== undefined ? { orchestrationScope: init.orchestrationScope } : {}),
        ...(init.attempt !== undefined ? { attempt: init.attempt } : {}),
      ...(init.phase !== undefined ? { phase: init.phase } : {}),
      ...(init.planSnapshotHash !== undefined ? { planSnapshotHash: init.planSnapshotHash } : {}),
      ...(init.planReview !== undefined ? { planReview: init.planReview } : {}),
      ...(init.resultReview !== undefined ? { resultReview: init.resultReview } : {}),
      ...(init.processCount !== undefined ? { processCount: init.processCount } : {}),
      ...(init.liveProcessCount !== undefined ? { liveProcessCount: init.liveProcessCount } : {}),
    };
    this.writeSummary();
    this.event("run_start", {
      agent: init.agent,
      mode: init.mode,
      request: init.request,
      ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
    });
  }

  /** Reopen an existing (non-terminal) run in a new owner process. */
  static reopen(layout: Layout, summary: RunSummary): RunRecorder {
    return new RunRecorder(layout, { agent: summary.agent, mode: summary.mode, request: summary.request, repoRoot: summary.repoRoot }, summary);
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.finalized && type !== "run_end") return;
    const now = new Date().toISOString();
    const line: RunEvent = { t: now, type, ...data };
    appendFileSync(this.eventsFile, JSON.stringify(line) + "\n", "utf8");
    this.summary.lastActivityAt = now;
    this.writeSummary();
  }

  /** Transition the run's lifecycle state; records a run_state event. */
  setStatus(status: RunStatus, reason?: string): void {
    if (this.finalized || this.summary.status === status) return;
    const from = this.summary.status;
    this.summary.status = status;
    this.summary.lastActivityAt = new Date().toISOString();
    this.writeSummary();
    this.event("run_state", { from, to: status, ...(reason ? { reason } : {}) });
  }

  recordCall(
    usage: Pick<RunSummary["usage"], "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">,
    costTotal: number | null,
    estimatedCost: number,
  ): void {
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
    this.summary.lastActivityAt = new Date().toISOString();
    this.writeSummary();
  }

  /** Record the run's assistant-turn count (not the model-call count). */
  recordTurn(turns: number): void {
    if (!Number.isFinite(turns) || turns < 0) return;
    this.summary.turns = Math.max(this.summary.turns, Math.floor(turns));
    this.summary.lastActivityAt = new Date().toISOString();
    this.writeSummary();
  }

  /**
   * Record the prompt size for a request. `tokens` is the actual
   * input+cacheRead count when the provider has answered; otherwise the
   * caller's estimate is used.
   */
  recordContext(chars: number, tokens?: number): void {
    if (!Number.isFinite(chars) || chars < 0) return;
    const c = Math.round(chars);
    const t = Math.max(0, Math.round(tokens ?? Math.ceil(chars / 4)));
    this.summary.usage.contextChars = c;
    this.summary.usage.contextTokens = t;
    this.summary.usage.peakContextChars = Math.max(this.summary.usage.peakContextChars, c);
    this.summary.usage.peakContextTokens = Math.max(this.summary.usage.peakContextTokens, t);
    this.summary.lastActivityAt = new Date().toISOString();
    this.writeSummary();
  }

  /** Read the append-only event stream for this run. */
  readEvents(): RunEvent[] {
    if (!existsSync(this.eventsFile)) return [];
    try {
      return readFileSync(this.eventsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch {
      return [];
    }
  }

  /** Terminal transition only; awaiting_input/paused go through setStatus. */
  finalize(status: RunStatus, error?: string, finalText?: string, summary?: string, stopReason?: StopReason): void {
    if (this.finalized) return;
    if (!isTerminalStatus(status)) {
      this.setStatus(status);
      return;
    }
    this.summary.status = status;
    this.summary.endedAt = new Date().toISOString();
    this.summary.lastActivityAt = this.summary.endedAt;
    if (error) this.summary.error = error;
    if (finalText && finalText.trim().length > 0) {
      this.summary.finalText = finalText.length > 8000 ? finalText.slice(0, 8000) + "\n…[truncated]" : finalText;
    }
    // Every terminal run gets an outcome summary, even when the model produced
    // no final text (turn cap, provider failure, interruption).
    const outcome = summarizeRun({
      summary: { ...this.summary, status, error: error ?? this.summary.error },
      events: this.readEvents(),
      state: readStateView(this.dir),
      finalText: finalText ?? this.summary.finalText,
      stopReason,
    });
    this.summary.summary = summary ?? outcome.text;
    this.summary.stopReason = stopReason ?? outcome.stopReason;
    this.writeSummary();
    this.finalized = true;
    const summaryLine: RunEvent = {
      t: this.summary.endedAt,
      type: "run_summary",
      headline: outcome.headline,
      stopReason: this.summary.stopReason,
      text: this.summary.summary,
    };
    appendFileSync(this.eventsFile, JSON.stringify(summaryLine) + "\n", "utf8");
    const line: RunEvent = {
      t: this.summary.endedAt,
      type: "run_end",
      status,
      ...(this.summary.stopReason ? { stopReason: this.summary.stopReason } : {}),
      ...(error ? { error } : {}),
    };
    appendFileSync(this.eventsFile, JSON.stringify(line) + "\n", "utf8");
  }

  /** Record the resolved agent configuration/capabilities for this run. */
  recordConfig(config: {
    preset?: string;
    delegate?: boolean;
    verification?: string;
      ask?: boolean;
    approval?: string;
    ambiguity?: string;
    capabilities?: string[];
  }): void {
    // NOTE: AgentConfig carries a `worktree: boolean` preference flag that
    // must never clobber RunSummary.worktree (the worktree *path* string).
    // Whitelist fields instead of Object.assign so extra spread keys
    // (e.g. {...resolved.config}) cannot corrupt VCS metadata.
    const { preset, delegate, verification, ask, approval, ambiguity, capabilities } = config;
    Object.assign(this.summary, {
      ...(preset !== undefined ? { preset } : {}),
      ...(delegate !== undefined ? { delegate } : {}),
      ...(verification !== undefined ? { verification } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(approval !== undefined ? { approval } : {}),
      ...(ambiguity !== undefined ? { ambiguity } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    });
    this.writeSummary();
    this.event("agent_config", { ...config });
  }

  get current(): RunSummary {
    return { ...this.summary };
  }

  /** Patch writer-owned metadata (VCS fields + owner pid; no event). */
  patchSummary(
    fields: Partial<
      Pick<
        RunSummary,
        | "worktree"
        | "worktreeOwnerRunId"
        | "branch"
        | "baseBranch"
        | "baseRef"
        | "commit"
        | "pid"
        | "orchestrationId"
        | "orchestrationScope"
        | "attempt"
        | "phase"
        | "planSnapshotHash"
        | "planReview"
        | "resultReview"
        | "processCount"
        | "liveProcessCount"
        | "prNumber"
        | "prUrl"
        | "prState"
      >
    >,
  ): void {
    Object.assign(this.summary, fields);
    this.summary.lastActivityAt = new Date().toISOString();
    this.writeSummary();
  }

  private writeSummary(): void {
    writeJsonAtomic(this.summaryFile, this.summary);
  }
}

export function readRun(layout: Layout, id: string): { summary: RunSummary; events: RunEvent[] } | null {
  const dir = join(layout.runsDir, id);
  const summaryFile = join(dir, "run.json");
  if (!existsSync(summaryFile)) return null;
  const summary = migrateRunSummary(JSON.parse(readFileSync(summaryFile, "utf8")));
  if (!summary) return null;
  if (!summary.repoRoot) summary.repoRoot = layout.repoRoot;
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
      const summary = migrateRunSummary(JSON.parse(readFileSync(summaryFile, "utf8")));
      if (summary) out.push(summary);
    } catch {
      // partial run dir — skip
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
