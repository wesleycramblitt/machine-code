/**
 * machine_code — run record schema: statuses, v1→v2 migration, atomic JSON.
 *
 * v1 summaries (no schemaVersion) are migrated on read: legacy "done" becomes
 * "completed" and `lastActivityAt` falls back to endedAt/startedAt. Files are
 * never rewritten during migration; the next writer-owned update persists v2.
 *
 * Every state file this module writes is atomic: a temp file in the target
 * directory, then rename. Readers never observe a partial JSON document.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

export const SCHEMA_VERSION = 2 as const;

export type RunStatus =
  | "created"
  | "running"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "blocked"
  | "failed"
  | "interrupted"
  | "cancelled";

const STATUSES: readonly RunStatus[] = [
  "created",
  "running",
  "awaiting_input",
  "paused",
  "completed",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
];

/** Legacy v1 status names mapped onto v2. */
const LEGACY_STATUS: Record<string, RunStatus> = {
  done: "completed",
};

/**
 * Normalize any stored status string to the v2 union. Legacy names migrate;
 * unknown/corrupt values degrade to "failed" so every summary stays typed.
 */
export function normalizeStatus(value: unknown): RunStatus {
  if (typeof value === "string") {
    if ((STATUSES as readonly string[]).includes(value)) return value as RunStatus;
    const legacy = LEGACY_STATUS[value];
    if (legacy) return legacy;
  }
  return "failed";
}

/**
 * States that must never be pruned or auto-finalized: the run still has (or
 * can regain) an owner. `interrupted` counts as active — it is resumable.
 */
const ACTIVE_STATES: readonly RunStatus[] = [
  "created",
  "running",
  "awaiting_input",
  "paused",
  "interrupted",
];

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(status);
}

/** States that end a run: nothing further will ever be appended. */
const TERMINAL_STATES: readonly RunStatus[] = ["completed", "blocked", "failed", "cancelled"];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(status);
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Prompt size for the most recent request, in characters. */
  contextChars: number;
  /** Prompt tokens for the most recent request (input + cacheRead). */
  contextTokens: number;
  /** Largest prompt seen during the run. */
  peakContextChars: number;
  peakContextTokens: number;
}

export interface RunCost {
  actual: number;
  estimated: number;
}

/** Selection settings captured at run start so a fork can reproduce them. */
export interface RunSettingsSnapshot {
  tier?: "free" | "paid";
  /** Explicit model pin. Absent means the selector chose the model. */
  model?: string;
  /** Explicit minimum fit; null is an explicit zero. */
  minFit?: number | null;
  /** Explicit per-axis floors. */
  minAxes?: Record<string, number>;
}

export interface RunSummary {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  repoRoot: string;
  /** Queued packet id this run executed, if any. */
  packetId?: string;
  /** Parent run this one was forked from. */
  forkedFrom?: string;
  /** Plan item (feature/bug/idea) this run belongs to, contract or not. */
  itemId?: string;
  agent: string;
  mode: string;
  /** Resolved agent configuration snapshot (Phase 3). */
  preset?: string;
  delegate?: boolean;
  verification?: string;
  ask?: boolean;
  approval?: string;
  ambiguity?: string;
  capabilities?: string[];
  /** Selection settings captured at start; absent on old runs. */
  settings?: RunSettingsSnapshot;
  request: string;
  status: RunStatus;
  pid: number;
  startedAt: string;
  /** Bumped on every event, model call, and state change. */
  lastActivityAt: string;
  endedAt?: string;
  /** Worktree path if the run mutated files. */
  worktree?: string;
  /** Run that owns the worktree this run inspects (Review shares Build's). */
  worktreeOwnerRunId?: string;
  /** Branch checked out in this run's worktree (mc/feature/<n>[-<slug>], mc/run/<id>). */
  branch?: string;
  /** Branch the worktree was based on. */
  baseBranch?: string;
  /** Commit the worktree was created from. */
  baseRef?: string;
  /** Commit created by the runner after gates/review passed. */
  commit?: string;
  /** Deterministic orchestration fields (optional until Phase 5). */
  orchestrationId?: string;
  orchestrationScope?: "project" | "epic" | "feature";
  attempt?: number;
  phase?: "build" | "review";
  planSnapshotHash?: string;
  planReview?: "agent" | "human";
  resultReview?: "agent" | "human";
  processCount?: number;
  liveProcessCount?: number;
  /** Latest PR for this run's branch. */
  prNumber?: number;
  prUrl?: string;
  prState?: "none" | "open" | "merged" | "closed";
  /** Prior run this one resumed from. */
  resumedFrom?: string;
  /** Parent run when this run was forked/delegated from another. */
  parentRunId?: string;
  /** Root of this run's fork tree (self when top-level). */
  rootRunId?: string;
  /** Why this run was forked. */
  forkReason?: "user_interrupt" | "manual" | "resume";
  turns: number;
  usage: RunUsage;
  cost: RunCost;
  modelCalls: number;
  error?: string;
  /** Final assistant text, capped; shown in the TUI run detail. */
  finalText?: string;
  /** Harness-generated outcome summary; always written on finalize. */
  summary?: string;
  /** Why the run stopped: completed, turn-cap, budget, loop, error, ... */
  stopReason?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function migrateUsage(value: unknown): RunUsage {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    input: num(raw.input),
    output: num(raw.output),
    cacheRead: num(raw.cacheRead),
    cacheWrite: num(raw.cacheWrite),
    totalTokens: num(raw.totalTokens),
    contextChars: num(raw.contextChars),
    contextTokens: num(raw.contextTokens),
    peakContextChars: num(raw.peakContextChars),
    peakContextTokens: num(raw.peakContextTokens),
  };
}

function migrateCost(value: unknown): RunCost {
  const raw = (value ?? {}) as Record<string, unknown>;
  return { actual: num(raw.actual), estimated: num(raw.estimated) };
}

function migrateRunSettings(value: unknown): RunSettingsSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const out: RunSettingsSnapshot = {};
  if (r.tier === "free" || r.tier === "paid") out.tier = r.tier;
  if (typeof r.model === "string" && r.model.trim().length > 0) out.model = r.model;
  if (typeof r.minFit === "number" && Number.isFinite(r.minFit)) out.minFit = r.minFit;
  else if (r.minFit === null) out.minFit = null;
  if (r.minAxes && typeof r.minAxes === "object" && !Array.isArray(r.minAxes)) {
    const axes: Record<string, number> = {};
    for (const [axis, raw] of Object.entries(r.minAxes as Record<string, unknown>)) {
      if (typeof raw === "number" && Number.isFinite(raw)) axes[axis] = raw;
    }
    if (Object.keys(axes).length > 0) out.minAxes = axes;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse + migrate any stored summary (v1 or v2) into the v2 shape.
 * Returns null when the record is unusable (missing id, not an object).
 */
export function migrateRunSummary(raw: unknown): RunSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const startedAt = str(r.startedAt) ?? new Date(0).toISOString();
  const endedAt = str(r.endedAt);
  const status = normalizeStatus(r.status);
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    repoRoot: str(r.repoRoot) ?? "",
    packetId: str(r.packetId),
    itemId: str(r.itemId),
    agent: str(r.agent) ?? "unknown",
    mode: str(r.mode) ?? "unknown",
    preset: str(r.preset),
    delegate: typeof r.delegate === "boolean" ? r.delegate : undefined,
    verification: str(r.verification),
    ask: typeof r.ask === "boolean" ? r.ask : undefined,
    approval: str(r.approval),
    ambiguity: str(r.ambiguity),
    capabilities: Array.isArray(r.capabilities)
      ? (r.capabilities as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined,
    settings: migrateRunSettings(r.settings),
    request: str(r.request) ?? "",
    status,
    pid: num(r.pid),
    startedAt,
    lastActivityAt: str(r.lastActivityAt) ?? endedAt ?? startedAt,
    endedAt,
    worktree: str(r.worktree),
    worktreeOwnerRunId: str(r.worktreeOwnerRunId),
    branch: str(r.branch),
    baseBranch: str(r.baseBranch),
    baseRef: str(r.baseRef),
    commit: str(r.commit),
    orchestrationId: str(r.orchestrationId),
    orchestrationScope:
      r.orchestrationScope === "project" || r.orchestrationScope === "epic" || r.orchestrationScope === "feature"
        ? r.orchestrationScope
        : undefined,
    attempt: typeof r.attempt === "number" && Number.isFinite(r.attempt) ? r.attempt : undefined,
    phase: r.phase === "build" || r.phase === "review" ? r.phase : undefined,
    planSnapshotHash: str(r.planSnapshotHash),
    planReview: r.planReview === "agent" || r.planReview === "human" ? r.planReview : undefined,
    resultReview: r.resultReview === "agent" || r.resultReview === "human" ? r.resultReview : undefined,
    processCount: typeof r.processCount === "number" && Number.isFinite(r.processCount) ? r.processCount : undefined,
    liveProcessCount:
      typeof r.liveProcessCount === "number" && Number.isFinite(r.liveProcessCount) ? r.liveProcessCount : undefined,
    prNumber: typeof r.prNumber === "number" ? r.prNumber : undefined,
    prUrl: str(r.prUrl),
    prState:
      r.prState === "open" || r.prState === "closed" || r.prState === "merged" || r.prState === "none"
        ? r.prState
        : undefined,
    resumedFrom: str(r.resumedFrom),
    parentRunId: str(r.parentRunId),
    rootRunId: str(r.rootRunId),
    forkReason: (["user_interrupt", "manual", "resume"] as const).find((v) => v === r.forkReason),
    turns: num(r.turns),
    usage: migrateUsage(r.usage),
    cost: migrateCost(r.cost),
    modelCalls: num(r.modelCalls),
    error: str(r.error),
    finalText: str(r.finalText),
    summary: str(r.summary),
    // A recovered plan checkpoint can leave an old loop reason on a run that
    // later completed. The terminal status wins.
    stopReason: status === "completed" && str(r.stopReason) === "loop" ? "completed" : str(r.stopReason),
  };
}

/** Atomic JSON write: temp file in the target directory, then rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${dir}/.${basename(file)}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}
