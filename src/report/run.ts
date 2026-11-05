/**
 * machine_code — run inspection shared by `machine_code show` and the TUI.
 * Read-only, bounded, and never trusts event payloads to be well-shaped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunSummary } from "../state/runs.js";
import type { ContextSource } from "../context/types.js";

export interface ContextManifest {
  chars: number;
  sources: ContextSource[];
}

export interface ContextUsageView {
  chars: number;
  tokens: number;
  peakTokens: number;
}

/**
 * Current and peak prompt size. New runs record this in run.json. Old runs
 * fall back to the last model_request chars and the actual call usage.
 */
export function contextUsage(
  usage: { contextChars?: number; contextTokens?: number; peakContextTokens?: number },
  events: readonly RunEvent[],
): ContextUsageView {
  let lastChars = 0;
  let lastTokens = 0;
  let peakTokens = 0;
  for (const event of events) {
    if (event.type === "model_request" && typeof event.chars === "number") {
      lastChars = event.chars;
    }
    if (event.type !== "model_call_end") continue;
    const u = (event.usage ?? {}) as { input?: number; cacheRead?: number };
    const tokens = Number(u.input ?? 0) + Number(u.cacheRead ?? 0);
    if (tokens > 0) {
      lastTokens = tokens;
      peakTokens = Math.max(peakTokens, tokens);
    }
  }
  const chars = usage.contextChars && usage.contextChars > 0 ? usage.contextChars : lastChars;
  const tokens = usage.contextTokens && usage.contextTokens > 0
    ? usage.contextTokens
    : lastTokens > 0
      ? lastTokens
      : Math.ceil(chars / 4);
  const peak = Math.max(
    usage.peakContextTokens ?? 0,
    peakTokens,
    lastChars > 0 ? Math.ceil(lastChars / 4) : 0,
  );
  return { chars, tokens, peakTokens: peak };
}

export function readContextManifest(runDir: string): ContextManifest | null {
  const file = join(runDir, "context.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { chars?: unknown; sources?: unknown };
    return {
      chars: typeof raw.chars === "number" ? raw.chars : 0,
      sources: Array.isArray(raw.sources) ? (raw.sources as ContextSource[]) : [],
    };
  } catch {
    return null;
  }
}

export interface ContextPackItemManifest {
  kind: string;
  ref: string;
  chars: number;
  tokens: number;
  reason: string;
}

export interface ContextPackManifest {
  updatedAt?: string;
  model?: string;
  contextWindow?: number;
  inputBudgetTokens?: number;
  overviewChars?: number;
  stateChars?: number;
  toolChars?: number;
  pack: {
    chars: number;
    tokens: number;
    files: string[];
    items: ContextPackItemManifest[];
  };
  rendered: {
    chars: number;
    included: number;
    omitted: Array<{ ref: string; reason: string }>;
  };
  ledger: {
    chars: number;
    entries: Array<{
      key: string;
      path: string;
      label: string;
      kind: string;
      chars: number;
      turn: number;
    }>;
  };
}

/** The task pack and ledger that the model actually received. */
export function readContextPackManifest(runDir: string): ContextPackManifest | null {
  const file = join(runDir, "context-pack.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ContextPackManifest>;
    const pack = raw.pack;
    const rendered = raw.rendered;
    const ledger = raw.ledger;
    if (!pack || !Array.isArray(pack.items)) return null;
    return {
      ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
      ...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
      ...(typeof raw.inputBudgetTokens === "number" ? { inputBudgetTokens: raw.inputBudgetTokens } : {}),
      ...(typeof raw.overviewChars === "number" ? { overviewChars: raw.overviewChars } : {}),
      ...(typeof raw.stateChars === "number" ? { stateChars: raw.stateChars } : {}),
      ...(typeof raw.toolChars === "number" ? { toolChars: raw.toolChars } : {}),
      pack: {
        chars: typeof pack.chars === "number" ? pack.chars : 0,
        tokens: typeof pack.tokens === "number" ? pack.tokens : 0,
        files: Array.isArray(pack.files) ? pack.files.filter((item): item is string => typeof item === "string") : [],
        items: pack.items.filter((item) => item && typeof item.ref === "string").map((item) => ({
          kind: typeof item.kind === "string" ? item.kind : "item",
          ref: item.ref,
          chars: typeof item.chars === "number" ? item.chars : 0,
          tokens: typeof item.tokens === "number" ? item.tokens : 0,
          reason: typeof item.reason === "string" ? item.reason : "",
        })),
      },
      rendered: {
        chars: typeof rendered?.chars === "number" ? rendered.chars : 0,
        included: typeof rendered?.included === "number" ? rendered.included : 0,
        omitted: Array.isArray(rendered?.omitted)
          ? rendered.omitted.filter((item) => item && typeof item.ref === "string")
          : [],
      },
      ledger: {
        chars: typeof ledger?.chars === "number" ? ledger.chars : 0,
        entries: Array.isArray(ledger?.entries)
          ? ledger.entries.filter((item) => item && typeof item.path === "string")
          : [],
      },
    };
  } catch {
    return null;
  }
}

export interface RunMetrics {
  id: string;
  agent: string;
  status: string;
  stopReason: string | null;
  model?: string;
  modelCalls: number;
  toolCalls: number;
  toolCallsByTool: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costActual: number;
  costEstimated: number;
  peakContextTokens: number;
  contextTokens: number;
  packChars: number;
  packTokens: number;
  renderedPackChars: number;
  omittedPackItems: number;
  ledgerChars: number;
  overviewChars: number;
  wallMs: number;
  changedPaths: string[];
  gates?: { passed: boolean; total: number; failed: string[] };
  loopReason?: string;
}

/** Compact run scorecard used by `machine_code eval` and thresholds. */
export function runMetrics(summary: RunSummary, events: readonly RunEvent[], runDir: string): RunMetrics {
  const toolCallsByTool: Record<string, number> = {};
  let toolCalls = 0;
  let modelCalls = 0;
  let loopReason: string | undefined;
  let gates: RunMetrics["gates"];
  for (const event of events) {
    if (event.type === "tool_call") {
      toolCalls += 1;
      const tool = String(event.tool ?? "tool");
      toolCallsByTool[tool] = (toolCallsByTool[tool] ?? 0) + 1;
    }
    if (event.type === "model_call_end") modelCalls += 1;
    if (event.type === "loop_blocked" && !loopReason) loopReason = String(event.reason ?? "loop");
    if (event.type === "gates") {
      const results = Array.isArray(event.results) ? event.results as Array<Record<string, unknown>> : [];
      gates = {
        passed: event.passed === true,
        total: results.length,
        failed: results.filter((result) => result.passed !== true).map((result) => String(result.command ?? "?")),
      };
    }
  }
  const lastModel = [...events].reverse().find((event) => event.type === "model_select" && typeof event.key === "string");
  const context = contextUsage(summary.usage, events);
  const pack = readContextPackManifest(runDir);
  const started = Date.parse(summary.startedAt);
  const ended = Date.parse(summary.lastActivityAt);
  return {
    id: summary.id,
    agent: summary.agent,
    status: summary.status,
    stopReason: summary.stopReason ?? null,
    ...(lastModel?.key ? { model: String(lastModel.key) } : {}),
    modelCalls: summary.modelCalls || modelCalls,
    toolCalls,
    toolCallsByTool,
    inputTokens: summary.usage.input,
    outputTokens: summary.usage.output,
    cacheReadTokens: summary.usage.cacheRead,
    cacheWriteTokens: summary.usage.cacheWrite,
    totalTokens: summary.usage.totalTokens,
    costActual: summary.cost.actual,
    costEstimated: summary.cost.estimated,
    peakContextTokens: context.peakTokens,
    contextTokens: context.tokens,
    packChars: pack?.pack.chars ?? 0,
    packTokens: pack?.pack.tokens ?? 0,
    renderedPackChars: pack?.rendered.chars ?? 0,
    omittedPackItems: pack?.rendered.omitted.length ?? 0,
    ledgerChars: pack?.ledger.chars ?? 0,
    overviewChars: pack?.overviewChars ?? 0,
    wallMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
    changedPaths: touchedPaths(events),
    ...(gates ? { gates } : {}),
    ...(loopReason ? { loopReason } : {}),
  };
}

export interface MetricsLimits {
  maxCalls?: number;
  maxCost?: number;
  maxTokens?: number;
  maxContextTokens?: number;
}

/** Returns the exceeded limits, formatted for an eval failure. */
export function exceededLimits(metrics: RunMetrics, limits: MetricsLimits): string[] {
  const failures: string[] = [];
  if (limits.maxCalls !== undefined && metrics.modelCalls > limits.maxCalls) {
    failures.push(`model calls ${metrics.modelCalls} > ${limits.maxCalls}`);
  }
  if (limits.maxCost !== undefined && metrics.costActual > limits.maxCost) {
    failures.push(`cost $${metrics.costActual.toFixed(4)} > $${limits.maxCost}`);
  }
  if (limits.maxTokens !== undefined && metrics.totalTokens > limits.maxTokens) {
    failures.push(`tokens ${metrics.totalTokens} > ${limits.maxTokens}`);
  }
  if (limits.maxContextTokens !== undefined && metrics.peakContextTokens > limits.maxContextTokens) {
    failures.push(`peak context ${metrics.peakContextTokens} > ${limits.maxContextTokens}`);
  }
  return failures;
}

export function childRuns(runs: readonly RunSummary[], parentId: string): RunSummary[] {
  return runs
    .filter((run) => run.parentRunId === parentId || (run.rootRunId === parentId && run.id !== parentId))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Parent, fork siblings, resume lineage, and same-orchestration task siblings. */
export function relatedRuns(runs: readonly RunSummary[], summary: RunSummary): RunSummary[] {
  return runs
    .filter((run) => {
      if (run.id === summary.id) return false;
      if (run.parentRunId === summary.id || summary.parentRunId === run.id) return true;
      if (summary.rootRunId && run.rootRunId === summary.rootRunId) return true;
      if (summary.resumedFrom === run.id || run.resumedFrom === summary.id) return true;
      return Boolean(
        summary.orchestrationId &&
          run.orchestrationId === summary.orchestrationId &&
          summary.taskIssue &&
          run.taskIssue &&
          summary.taskIssue.repo === run.taskIssue.repo &&
          summary.taskIssue.number === run.taskIssue.number,
      );
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export interface ThinkingChunk {
  at: string;
  /** 1-based attempt. Call indices reset after a retry, so this keeps them apart. */
  attempt?: number;
  call?: number;
  kind: "text" | "thinking";
  text: string;
  complete: boolean;
}

/** Live deltas + authoritative turn text, grouped by attempt and provider call. */
export function thinkingChunks(events: readonly RunEvent[]): ThinkingChunk[] {
  const out = new Map<string, ThinkingChunk>();
  const order: string[] = [];
  let attempt = 0;
  const get = (
    key: string,
    at: string,
    attemptNo: number,
    call?: number,
    kind: "text" | "thinking" = "text",
  ): ThinkingChunk => {
    let chunk = out.get(key);
    if (!chunk) {
      chunk = { at, attempt: attemptNo, call, kind, text: "", complete: false };
      out.set(key, chunk);
      order.push(key);
    }
    return chunk;
  };
  for (const event of events) {
    // Each attempt starts with the loop's upfront call 0 selection.
    if (event.type === "model_select" && event.call === 0) attempt += 1;
    const call = typeof event.call === "number" ? event.call : undefined;
    if (event.type === "model_delta") {
      const kind = event.kind === "thinking" ? "thinking" : "text";
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) continue;
      const chunk = get(`${attempt}:${call ?? "?"}:${kind}`, String(event.t ?? ""), attempt, call, kind);
      chunk.text += text;
      chunk.at = String(event.t ?? chunk.at);
      continue;
    }
    if (event.type !== "model_call_end") continue;
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!text) continue;
    for (const existing of out.values()) {
      if (existing.attempt === attempt && existing.call === call) existing.complete = true;
    }
    const key = `${attempt}:${call ?? "?"}:text`;
    const chunk = get(key, String(event.t ?? ""), attempt, call, "text");
    chunk.text = text;
    chunk.at = String(event.t ?? chunk.at);
    chunk.complete = true;
  }
  return order.map((key) => out.get(key)!).filter((chunk) => chunk.text.trim().length > 0);
}

export interface ChangeSummary {
  status: string;
  diffStat: string;
  recent: string;
  error?: string;
}

function git(cwd: string, args: string[], timeout = 4_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 512 * 1024,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

/** Best-effort working-tree summary for a run's worktree. */
export function changesFor(worktree: string | undefined): ChangeSummary {
  if (!worktree || !existsSync(worktree)) {
    return { status: "", diffStat: "", recent: "", error: "no worktree" };
  }
  try {
    return {
      status: git(worktree, ["status", "--short", "--branch"]),
      diffStat: git(worktree, ["diff", "--stat", "--no-color", "HEAD"]),
      recent: git(worktree, ["log", "--oneline", "--no-color", "-5"]),
    };
  } catch (error) {
    return {
      status: "",
      diffStat: "",
      recent: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Paths touched by write/edit tool events, for the run timeline. */
export function touchedPaths(events: readonly RunEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_call" && event.type !== "tool_call_start") continue;
    const tool = String(event.tool ?? "");
    if (tool !== "write" && tool !== "edit") continue;
    const args = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (path) paths.add(path);
  }
  return [...paths];
}
