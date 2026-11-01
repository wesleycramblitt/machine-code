/**
 * machine_code — navigable work hierarchy.
 *
 * The TUI and `machine_code runs` share this flat, selection-friendly view of
 * Epic → Feature → Task → runs, plus the two escape hatches that matter:
 * planning runs and untracked runs with no issue.
 *
 * Rows are intentionally flat so keyboard navigation stays simple; `depth`
 * carries the visual hierarchy and `parent` identifies fold groups.
 */
import type { Issue, IssueRef } from "../issues/provider.js";
import type { RunSummary } from "../state/runs.js";
import { healthOf, isDeliverable, rollupIssue, sortRuns, type IssueHealth, type IssueRollup } from "./status.js";

export type WorkRow =
  | {
      kind: "section";
      id: string;
      label: string;
      count: number;
      depth: number;
      collapsible: boolean;
      collapsed: boolean;
    }
  | {
      kind: "issue";
      id: string;
      issue: Issue;
      depth: number;
      rollup: IssueRollup;
      parent?: string;
      collapsible: boolean;
      collapsed: boolean;
      childCount: number;
      directRuns: number;
    }
  | {
      kind: "run";
      id: string;
      run: RunSummary;
      depth: number;
      parent?: string;
    };

export interface WorkOptions {
  issues: readonly Issue[];
  runs: readonly RunSummary[];
  collapsed?: ReadonlySet<string>;
  /** Case-insensitive substring over issue titles/numbers and run fields. */
  text?: string;
  /** Only keep work that needs a human or is in flight. */
  attentionOnly?: boolean;
  now?: number;
}

export interface WorkIndex {
  rows: WorkRow[];
  /** Rows a cursor can land on, including collapsible section headings. */
  selectable: WorkRow[];
  byRunId: Map<string, WorkRow & { kind: "run" }>;
  byIssueKey: Map<string, WorkRow & { kind: "issue" }>;
  untracked: RunSummary[];
  planning: RunSummary[];
  orphaned: RunSummary[];
  attention: number;
}

function keyOf(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

function issueText(issue: Issue): string {
  return `#${issue.ref.number} ${issue.title} ${issue.kind} ${issue.labels.join(" ")}`;
}

function runText(run: RunSummary): string {
  return [
    run.id,
    run.agent,
    run.mode,
    run.request,
    run.status,
    run.prNumber ? `pr #${run.prNumber}` : "",
    run.issue ? `#${run.issue.number}` : "",
  ].join(" ");
}

function statusNeedsAttention(run: RunSummary): boolean {
  return (
    run.status === "running" ||
    run.status === "awaiting_input" ||
    run.status === "blocked" ||
    run.status === "paused" ||
    run.status === "interrupted" ||
    run.status === "failed" ||
    run.prState === "open"
  );
}

const ATTENTION_HEALTH = new Set<IssueHealth>([
  "attention",
  "awaiting-human",
  "review",
  "paused",
  "blocked",
  "stalled",
]);

export function buildWorkIndex(options: WorkOptions): WorkIndex {
  const now = options.now ?? Date.now();
  const collapsed = options.collapsed ?? new Set<string>();
  const text = options.text?.trim().toLowerCase() ?? "";
  const rows: WorkRow[] = [];
  const byRunId = new Map<string, WorkRow & { kind: "run" }>();
  const byIssueKey = new Map<string, WorkRow & { kind: "issue" }>();

  const byIssue = new Map<string, RunSummary[]>();
  for (const run of options.runs) {
    if (!run.issue) continue;
    const key = keyOf(run.issue);
    const list = byIssue.get(key) ?? [];
    list.push(run);
    byIssue.set(key, list);
  }

  const issues = [...options.issues];
  const known = new Set(issues.map((issue) => keyOf(issue.ref)));
  const childrenOf = (issue: Issue) =>
    issues.filter((candidate) => candidate.parent && candidate.parent.repo === issue.ref.repo && candidate.parent.number === issue.ref.number);

  const ownMatch = (issue: Issue): boolean => !text || issueText(issue).toLowerCase().includes(text);
  const runMatch = (run: RunSummary): boolean => !text || runText(run).toLowerCase().includes(text);
  const issueRuns = (issue: Issue) => byIssue.get(keyOf(issue.ref)) ?? [];

  const relevantCache = new Map<string, boolean>();
  const issueRelevant = (issue: Issue): boolean => {
    const key = keyOf(issue.ref);
    const cached = relevantCache.get(key);
    if (cached !== undefined) return cached;
    const descendants = childrenOf(issue);
    const relevant =
      ownMatch(issue) ||
      issueRuns(issue).some(runMatch) ||
      descendants.some((child) => issueRelevant(child));
    relevantCache.set(key, relevant);
    return relevant;
  };

  const pushRuns = (issue: Issue | undefined, list: readonly RunSummary[], depth: number, parent?: string): void => {
    const sorted = sortRuns(list, "activity");
    for (const run of sorted) {
      if (options.attentionOnly && !statusNeedsAttention(run)) continue;
      if (text && !runMatch(run) && !(issue && ownMatch(issue))) continue;
      const row: WorkRow = { kind: "run", id: `run:${run.id}`, run, depth, parent };
      rows.push(row);
      byRunId.set(run.id, row as WorkRow & { kind: "run" });
    }
  };

  const walk = (issue: Issue, depth: number, parent?: string): void => {
    if (!issueRelevant(issue)) return;
    const children = childrenOf(issue).sort((a, b) => {
      const ar = a.kind === "epic" ? 0 : a.kind === "feature" ? 1 : 2;
      const br = b.kind === "epic" ? 0 : b.kind === "feature" ? 1 : 2;
      return ar - br || a.ref.number - b.ref.number;
    });
    const directRuns = issueRuns(issue);
    const rollup = rollupIssue(
      issue,
      directRuns,
      children.filter((child) => isDeliverable(child)),
      (child) => issueRuns(child),
      now,
    );
    const id = `issue:${keyOf(issue.ref)}`;
    const collapsible = children.length > 0 || directRuns.length > 0;
    const isCollapsed = collapsed.has(id);
    const row: WorkRow = {
      kind: "issue",
      id,
      issue,
      depth,
      rollup,
      parent,
      collapsible,
      collapsed: isCollapsed,
      childCount: children.length,
      directRuns: directRuns.length,
    };
    rows.push(row);
    byIssueKey.set(keyOf(issue.ref), row as WorkRow & { kind: "issue" });
    if (isCollapsed) return;
    for (const child of children) walk(child, depth + 1, id);
    pushRuns(issue, directRuns, depth + 1, id);
  };

  const epics = issues.filter((issue) => issue.kind === "epic");
  for (const epic of epics) walk(epic, 0);

  const planning: RunSummary[] = [];
  const untracked: RunSummary[] = [];
  const orphaned: RunSummary[] = [];
  for (const run of options.runs) {
    if (!run.issue) {
      if (run.agent === "architect" && (!run.mode || run.mode === "plan" || run.mode === "solo")) planning.push(run);
      else untracked.push(run);
      continue;
    }
    if (!known.has(keyOf(run.issue))) orphaned.push(run);
  }

  const pushSection = (
    label: string,
    id: string,
    list: readonly RunSummary[],
    depth = 0,
  ): void => {
    const filtered = list.filter(
      (run) => (!options.attentionOnly || statusNeedsAttention(run)) && (!text || runMatch(run)),
    );
    if (filtered.length === 0) return;
    const isCollapsed = collapsed.has(id);
    rows.push({ kind: "section", id, label, count: filtered.length, depth, collapsible: true, collapsed: isCollapsed });
    if (isCollapsed) return;
    pushRuns(undefined, filtered, depth + 1, id);
  };

  pushSection("Planning", "section:planning", planning);
  pushSection("Untracked", "section:untracked", untracked);
  pushSection("Orphaned issue", "section:orphaned", orphaned);

  const selectable = rows;
  const attentionIssues = [...byIssueKey.values()].filter((row) => ATTENTION_HEALTH.has(row.rollup.health)).length;
  const attentionRuns = options.runs.filter(statusNeedsAttention).length;
  return {
    rows,
    selectable,
    byRunId,
    byIssueKey,
    untracked: sortRuns(untracked, "activity"),
    planning: sortRuns(planning, "activity"),
    orphaned: sortRuns(orphaned, "activity"),
    attention: attentionIssues + attentionRuns,
  };
}

/** Next/previous cursor row. Section headings are normal cursor stops. */
export function moveSelection(index: number, delta: number, selectable: readonly WorkRow[]): number {
  if (selectable.length === 0) return 0;
  return Math.max(0, Math.min(selectable.length - 1, index + delta));
}

export function runOf(row: WorkRow | undefined): RunSummary | undefined {
  return row?.kind === "run" ? row.run : undefined;
}

export function issueOf(row: WorkRow | undefined): Issue | undefined {
  return row?.kind === "issue" ? row.issue : undefined;
}
