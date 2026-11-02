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

export function childRuns(runs: readonly RunSummary[], parentId: string): RunSummary[] {
  return runs
    .filter((run) => run.parentRunId === parentId || (run.rootRunId === parentId && run.id !== parentId))
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
