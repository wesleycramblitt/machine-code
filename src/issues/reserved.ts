/**
 * machine_code — reserved Planning & Review anchors (removed).
 *
 * Phase 1 of the epic/feature simplification deleted the reserved-issue
 * hierarchy (Feature 0 / Task 0 coordination anchors). This module keeps the
 * previous export names as inert stubs so existing importers keep compiling
 * while later phases remove their call sites. Every predicate reports false,
 * every ensure call throws, hierarchy audits are empty, and the planning
 * anchor for any issue is the issue itself.
 */
import {
  IssueError,
  refKey,
  type Issue,
  type IssueProvider,
  type IssueRef,
} from "./provider.js";

export function sameRef(a: IssueRef | undefined, b: IssueRef | undefined): boolean {
  return Boolean(a && b && a.number === b.number && a.repo === b.repo);
}

/** Reserved anchors no longer exist; always false. */
export function isReservedFor(_issue: Issue, _parent: IssueRef, _kind: string): boolean {
  return false;
}

/** Reserved anchors no longer exist; always false. */
export function isReserved(_issue: Issue): boolean {
  return false;
}

/** Reserved anchors no longer exist; always false. */
export function isReservedTask(_issue: Issue): boolean {
  return false;
}

export interface ReservedOptions {
  /** Associated-run counts by issue number (ignored; kept for signature compatibility). */
  runCounts?: Map<number, number>;
  /** Ignored; kept for signature compatibility. */
  autoCloseEmpty?: boolean;
}

export interface EnsureResult {
  issue: Issue;
  created: boolean;
  duplicatesClosed: number[];
  duplicatesWithRuns: number[];
}

export interface EpicReserved {
  feature0: Issue;
  task0: Issue;
}

export interface HierarchyAudit {
  missing: Array<{ parent: IssueRef; kind: string }>;
  duplicates: Array<{ parent: IssueRef; kind: string; numbers: number[] }>;
  conflicts: Array<{ parent: IssueRef; kind: string; numbers: number[] }>;
}

/** Reserved anchors were removed; always throws. */
export async function ensureReserved(
  _provider: IssueProvider,
  _parent: IssueRef,
  _kind: string,
  _opts: ReservedOptions = {},
): Promise<EnsureResult> {
  throw new IssueError("reserved_removed", "reserved anchors removed");
}

/** Reserved anchors were removed; always throws. */
export async function ensureEpicReserved(
  _provider: IssueProvider,
  _epic: IssueRef,
  _opts: ReservedOptions = {},
): Promise<EpicReserved> {
  throw new IssueError("reserved_removed", "reserved anchors removed");
}

/** Reserved anchors were removed; always throws. */
export async function ensureFeatureReserved(
  _provider: IssueProvider,
  _feature: IssueRef,
  _opts: ReservedOptions = {},
): Promise<Issue> {
  throw new IssueError("reserved_removed", "reserved anchors removed");
}

/** No reserved hierarchy remains; always empty. */
export async function auditHierarchy(
  _provider: IssueProvider,
  _root: IssueRef,
): Promise<HierarchyAudit> {
  return { missing: [], duplicates: [], conflicts: [] };
}

/**
 * Resolve the issue a run attaches to for planning/review. Reserved anchors
 * were removed, so the input ref is always returned unchanged.
 */
export async function resolvePlanningAnchor(
  _provider: IssueProvider,
  ref: IssueRef,
  _opts: ReservedOptions = {},
): Promise<IssueRef> {
  return ref;
}

/**
 * Validate a run's primary issue association: it must be a Feature, or an
 * Epic when `allowEpic` is set (planner runs attach to Epics).
 */
export async function validateRunIssue(
  provider: IssueProvider,
  ref: IssueRef,
  opts: { allowEpic?: boolean } = {},
): Promise<Issue> {
  const issue = await provider.get(ref);
  if (!issue) throw new IssueError("issue_not_found", `issue ${ref.repo}#${ref.number} not found`);
  if ((issue.kind as string) === "task") {
    throw new IssueError(
      "issue_not_task",
      `runs attach to Features or Epics only (${ref.repo}#${ref.number} is a task, which no longer exists as a kind)`,
    );
  }
  if (issue.kind === "epic" && !opts.allowEpic) {
    throw new IssueError(
      "issue_not_feature",
      `runs attach to Features (${ref.repo}#${ref.number} is an epic); planner runs may pass allowEpic`,
    );
  }
  return issue;
}

/** Convenience: number of runs per issue for canonical/duplicate decisions. */
export function runCountsFrom(runs: ReadonlyArray<{ issue?: IssueRef }>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const run of runs) {
    if (!run.issue) continue;
    counts.set(run.issue.number, (counts.get(run.issue.number) ?? 0) + 1);
  }
  return counts;
}

export { refKey };
