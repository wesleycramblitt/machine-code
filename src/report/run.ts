/**
 * machine_code — run inspection shared by `machine_code show` and the TUI.
 * Read-only, bounded, and never trusts event payloads to be well-shaped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunSummary } from "../state/runs.js";
import type { ContextSections, ContextSource } from "../context/types.js";
import { sectionForKind } from "../context/budget.js";

export interface ContextManifest {
  chars: number;
  sources: ContextSource[];
  warnings: string[];
  /** Kept body chars per section; derived from sources for old manifests. */
  sections: ContextSections;
}

/** Per-section chars for manifests written before section budgets existed. */
export function sectionsFromSources(sources: readonly ContextSource[]): ContextSections {
  const sections: ContextSections = {
    issues: 0,
    plans: 0,
    knowledge: 0,
    skills: 0,
    scripts: 0,
    tools: 0,
    references: 0,
    files: 0,
    parents: 0,
    system: 0,
  };
  for (const source of sources) {
    const chars = typeof source.bytes === "number" && Number.isFinite(source.bytes) ? Math.max(0, source.bytes) : 0;
    sections[sectionForKind(source.kind)] += chars;
  }
  return sections;
}

function parseSections(raw: unknown, sources: ContextSource[]): ContextSections {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const sections: ContextSections = {
        issues: 0,
      plans: 0,
      knowledge: 0,
      skills: 0,
      scripts: 0,
      tools: 0,
      references: 0,
      files: 0,
      parents: 0,
      system: 0,
    };
    let valid = true;
    for (const key of Object.keys(sections) as Array<keyof ContextSections>) {
      const value = record[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        valid = false;
        break;
      }
      sections[key] = Math.max(0, value);
    }
    if (valid) return sections;
  }
  return sectionsFromSources(sources);
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
    const raw = JSON.parse(readFileSync(file, "utf8")) as { chars?: unknown; sources?: unknown; warnings?: unknown; sections?: unknown };
    const sources = Array.isArray(raw.sources) ? (raw.sources as ContextSource[]) : [];
    return {
      chars: typeof raw.chars === "number" ? raw.chars : 0,
      sources,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === "string") : [],
      sections: parseSections(raw.sections, sources),
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
  wallMs: number;
  changedPaths: string[];
  gates?: { passed: boolean; total: number; failed: string[] };
  loopReason?: string;
}

/** Compact run scorecard used by `machine_code eval` and thresholds. */
export function runMetrics(summary: RunSummary, events: readonly RunEvent[]): RunMetrics {
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
          (summary.itemId ?? summary.packetId) &&
          (run.itemId ?? run.packetId) === (summary.itemId ?? summary.packetId),
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
  const failed = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_call" && event.isError === true && typeof event.toolCallId === "string") {
      failed.add(event.toolCallId);
    }
  }
  for (const event of events) {
    if (event.type !== "tool_call" && event.type !== "tool_call_start") continue;
    const tool = String(event.tool ?? "");
    if (tool !== "write" && tool !== "edit") continue;
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (id && failed.has(id)) continue;
    const args = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (path) paths.add(path);
  }
  return [...paths];
}

/* ------------------------------------------------- context eval harness */

const CHARS_PER_TOKEN = 4;

/** Estimated tokens per context section, derived from section chars. */
export function sectionTokens(sections: ContextSections): Record<keyof ContextSections, number> {
  const out = {} as Record<keyof ContextSections, number>;
  for (const key of Object.keys(sections) as Array<keyof ContextSections>) {
    out[key] = Math.ceil(Math.max(0, sections[key]) / CHARS_PER_TOKEN);
  }
  return out;
}

export interface GoldRecall {
  expected: string[];
  found: string[];
  missing: string[];
  /** 1 when no gold set is supplied; found/expected otherwise. */
  recall: number;
}

/**
 * Gold-file recall: were the expected files among the context sources?
 * A gold entry matches a source whose ref equals it or extends it with a
 * line range (e.g. gold `src/a.ts` matches source `src/a.ts:2-4`).
 */
export function goldRecall(
  sources: readonly Pick<ContextSource, "ref">[],
  gold: readonly string[],
): GoldRecall {
  const expected = gold.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const found: string[] = [];
  const missing: string[] = [];
  for (const want of expected) {
    const hit = sources.some((source) => source.ref === want || source.ref.startsWith(`${want}:`));
    (hit ? found : missing).push(want);
  }
  return { expected, found, missing, recall: expected.length === 0 ? 1 : found.length / expected.length };
}

export interface CitedClaim {
  path: string;
  line: number;
}

export interface FaithfulnessResult {
  citations: CitedClaim[];
  /** Human-readable failures: uncited file claims and unresolvable citations. */
  failures: string[];
}

/** Repo-relative `path` or `path:line` mentions (`path/to/file.ext[:line]`). */
const FILE_MENTION = /([\w.~\-]+(?:\/[\w.~\-]+)+\.[\w]+)(?::(\d+))?/g;

/**
 * Faithfulness spot-check for model text: every repo-file claim must cite
 * a `path:line`, and every cited line must resolve via `lineExists` (wired
 * to a repo grep/read in production, faked in tests). Pure function, no
 * model calls.
 */
export function checkFaithfulness(
  modelText: string,
  lineExists: (path: string, line: number) => boolean,
): FaithfulnessResult {
  const citations: CitedClaim[] = [];
  const failures: string[] = [];
  for (const match of modelText.matchAll(FILE_MENTION)) {
    const path = match[1]!;
    const rawLine = match[2];
    if (rawLine === undefined) {
      failures.push(`uncited file claim: ${path} cites no path:line`);
      continue;
    }
    const line = Number(rawLine);
    citations.push({ path, line });
    if (!lineExists(path, line)) {
      failures.push(`unresolved citation: ${path}:${line} not found`);
    }
  }
  return { citations, failures };
}

/** `lineExists` backed by on-disk reads under `repoRoot`. */
export function diskLineExists(repoRoot: string): (path: string, line: number) => boolean {
  return (path, line) => {
    if (!Number.isInteger(line) || line < 1) return false;
    if (path.includes("..")) return false;
    try {
      const content = readFileSync(join(repoRoot, path), "utf8").split("\n");
      return line <= content.length;
    } catch {
      return false;
    }
  };
}
