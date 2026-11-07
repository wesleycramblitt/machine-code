/**
 * machine_code — pure TUI status model.
 *
 * Everything here is a deterministic derivation over run summaries:
 * filtering/sorting, header counts, and the awaiting-human queue. The TUI
 * renderer only formats these values, which keeps the status surfaces
 * testable without a terminal.
 */
import type { RunStatus, RunSummary } from "../state/runs.js";

export type RunFilter = "active" | "paused" | "completed" | "awaiting" | "all";
export type SortKey = "activity" | "number" | "severity" | "cost";

export function filterRuns(runs: readonly RunSummary[], filter: RunFilter): RunSummary[] {
  switch (filter) {
    case "active":
      return runs.filter((r) => r.status === "running" || r.status === "awaiting_input" || r.status === "created");
    case "paused":
      return runs.filter((r) => r.status === "paused" || r.status === "interrupted" || r.status === "blocked");
    case "completed":
      return runs.filter((r) => r.status === "completed" || r.status === "failed" || r.status === "cancelled");
    case "awaiting":
      return runs.filter((r) => r.status === "awaiting_input");
    case "all":
    default:
      return [...runs];
  }
}

const STATUS_RANK: Record<RunStatus, number> = {
  running: 0,
  awaiting_input: 1,
  blocked: 2,
  paused: 3,
  failed: 4,
  interrupted: 5,
  created: 6,
  completed: 7,
  cancelled: 8,
};

export function sortRuns(runs: readonly RunSummary[], key: SortKey): RunSummary[] {
  const copy = [...runs];
  switch (key) {
    case "number":
      return copy.sort((a, b) => a.id.localeCompare(b.id));
    case "severity":
      return copy.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || lastActivity(b) - lastActivity(a));
    case "cost":
      return copy.sort((a, b) => b.cost.actual - a.cost.actual);
    case "activity":
    default:
      return copy.sort((a, b) => lastActivity(b) - lastActivity(a));
  }
}

function lastActivity(run: RunSummary): number {
  const t = new Date(run.lastActivityAt ?? run.startedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

export interface HeaderCounts {
  active: number;
  awaiting: number;
  paused: number;
  blocked: number;
  completed: number;
  failed: number;
  openPrs: number;
  approvals: number;
  spend: number;
}

export function headerCounts(runs: readonly RunSummary[], now = Date.now()): HeaderCounts {
  void now;
  return {
    active: runs.filter((r) => r.status === "running").length,
    awaiting: runs.filter((r) => r.status === "awaiting_input").length,
    paused: runs.filter((r) => r.status === "paused" || r.status === "interrupted").length,
    blocked: runs.filter((r) => r.status === "blocked").length,
    completed: runs.filter((r) => r.status === "completed").length,
    failed: runs.filter((r) => r.status === "failed").length,
    openPrs: runs.filter((r) => r.prState === "open").length,
    approvals: runs.filter((r) => r.status === "awaiting_input").length + runs.filter((r) => r.prState === "open").length,
    spend: runs.reduce((sum, r) => sum + r.cost.actual, 0),
  };
}

export interface AwaitingEntry {
  kind: "question" | "pr" | "close";
  runId?: string;
  packetId?: string;
  pr?: number;
  label: string;
  ageMs: number;
  order: number;
}

export function awaitingHuman(
  runs: readonly RunSummary[],
  now = Date.now(),
): AwaitingEntry[] {
  const out: AwaitingEntry[] = [];
  for (const run of runs) {
    if (run.status === "awaiting_input") {
      out.push({
        kind: "question",
        runId: run.id,
        ...(run.packetId ? { packetId: run.packetId } : {}),
        label: `answer question${run.packetId ? ` on ${run.packetId}` : ""}`,
        ageMs: now - lastActivity(run),
        order: 0,
      });
    }
    if (run.prState === "open" && run.status === "completed") {
      out.push({
        kind: "pr",
        runId: run.id,
        ...(run.packetId ? { packetId: run.packetId } : {}),
        pr: run.prNumber,
        label: `review/merge PR #${run.prNumber}${run.packetId ? ` for ${run.packetId}` : ""}`,
        ageMs: now - lastActivity(run),
        order: 1,
      });
    }
  }
  return out.sort((a, b) => a.order - b.order || b.ageMs - a.ageMs);
}
