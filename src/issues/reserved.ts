/**
 * machine_code — reserved Planning & Review issues.
 *
 * Invariants (enforced here and by the issue tool):
 *   Epic    → exactly one reserved Feature 0  (kind epic-pr)
 *   Feature → exactly one reserved Task 0     (kind feature-pr)
 *
 * Reserved issues are real GitHub issues identified by an invisible body
 * marker, falling back to a reserved label, then the exact title. Duplicates
 * are resolved deterministically: the canonical is the marker match, then the
 * one with the most runs, then oldest, then lowest number. Empty duplicates
 * (zero associated runs) are auto-closed; duplicates with runs are reported
 * for manual consolidation and never closed automatically.
 */
import {
  IssueError,
  RESERVED_LABELS,
  RESERVED_TITLES,
  refKey,
  reservedMarker,
  type Issue,
  type IssueProvider,
  type IssueRef,
  type ReservedKind,
} from "./provider.js";

export function sameRef(a: IssueRef | undefined, b: IssueRef | undefined): boolean {
  return Boolean(a && b && a.number === b.number && a.repo === b.repo);
}

/** Does this issue claim the reserved role `kind` under `parent`? */
export function isReservedFor(issue: Issue, parent: IssueRef, kind: ReservedKind): boolean {
  if (issue.reserved) {
    return issue.reserved.kind === kind && sameRef(issue.reserved.for, parent);
  }
  if (issue.labels.includes(RESERVED_LABELS[kind])) return true;
  return issue.title.trim() === RESERVED_TITLES[kind];
}

export function isReserved(issue: Issue): boolean {
  return Boolean(issue.reserved) || issue.labels.some((l) => l.startsWith("mc:reserved"));
}

export function isReservedTask(issue: Issue): boolean {
  return issue.kind === "task" && issue.reserved?.kind === "feature-pr";
}

export interface ReservedOptions {
  /** Associated-run counts by issue number, used to pick the canonical and
   *  to decide whether an empty duplicate may be auto-closed. */
  runCounts?: Map<number, number>;
  /** When false, ensure reports duplicates but never closes them. */
  autoCloseEmpty?: boolean;
}

function reservedBody(parent: IssueRef, kind: ReservedKind): string {
  const role = kind === "epic-pr" ? "Epic" : "Feature";
  return [
    reservedMarker(parent, kind),
    "",
    `Reserved ${role} coordination anchor for ${parent.repo}#${parent.number}.`,
    "",
    "## Scope",
    `Planning, delegation, and review runs for this ${role.toLowerCase()} attach here.`,
    "This is an execution anchor, not a deliverable; it is excluded from completion rollups.",
    "",
    "## Acceptance criteria",
    "- Child issues are created or linked before implementation starts.",
    "- Every deliverable child is reviewed before the parent closes.",
    "- The parent's own acceptance criteria are reviewed before closure.",
    "",
    '<!-- mc:approval {"mode":"human","reason":"reserved coordination anchor"} -->',
    "",
  ].join("\n");
}

function canonical(matches: Issue[], runCounts?: Map<number, number>): { canonical: Issue; extras: Issue[] } {
  const scored = [...matches].sort((a, b) => {
    const markerA = a.reserved ? 1 : 0;
    const markerB = b.reserved ? 1 : 0;
    if (markerA !== markerB) return markerB - markerA;
    const runsA = runCounts?.get(a.ref.number) ?? 0;
    const runsB = runCounts?.get(b.ref.number) ?? 0;
    if (runsA !== runsB) return runsB - runsA;
    const createdA = a.createdAt ?? "";
    const createdB = b.createdAt ?? "";
    if (createdA !== createdB) return createdA < createdB ? -1 : 1;
    return a.ref.number - b.ref.number;
  });
  const [first, ...rest] = scored;
  if (!first) throw new IssueError("reserved_missing", "no reserved issue candidates");
  return { canonical: first, extras: rest };
}

export interface EnsureResult {
  issue: Issue;
  created: boolean;
  duplicatesClosed: number[];
  duplicatesWithRuns: number[];
}

/** Ensure exactly one reserved issue of `kind` under `parent`. */
export async function ensureReserved(
  provider: IssueProvider,
  parent: IssueRef,
  kind: ReservedKind,
  opts: ReservedOptions = {},
): Promise<EnsureResult> {
  const children = await provider.children(parent);
  const matches = children.filter((c) => isReservedFor(c, parent, kind));
  if (matches.length === 0) {
    const created = await provider.create({
      title: RESERVED_TITLES[kind],
      body: reservedBody(parent, kind),
      kind: kind === "epic-pr" ? "feature" : "task",
      parent,
      labels: ["mc:reserved", "mc:planning-review", RESERVED_LABELS[kind]],
    });
    return { issue: created, created: true, duplicatesClosed: [], duplicatesWithRuns: [] };
  }
  const { canonical: canonicalIssue, extras } = canonical(matches, opts.runCounts);
  const duplicatesClosed: number[] = [];
  const duplicatesWithRuns: number[] = [];
  for (const extra of extras) {
    const runs = opts.runCounts?.get(extra.ref.number) ?? 0;
    if (runs > 0) {
      duplicatesWithRuns.push(extra.ref.number);
      continue;
    }
    if (opts.autoCloseEmpty === false) continue;
    try {
      await provider.close(extra.ref, "not planned");
      duplicatesClosed.push(extra.ref.number);
    } catch {
      // non-fatal: report stays in the audit
    }
  }
  return {
    issue: canonicalIssue,
    created: false,
    duplicatesClosed,
    duplicatesWithRuns,
  };
}

export interface EpicReserved {
  feature0: Issue;
  task0: Issue;
}

/** Ensure an Epic's reserved Feature 0 and the Task 0 beneath it. */
export async function ensureEpicReserved(
  provider: IssueProvider,
  epic: IssueRef,
  opts: ReservedOptions = {},
): Promise<EpicReserved> {
  const feature0 = await ensureReserved(provider, epic, "epic-pr", opts);
  const task0 = await ensureReserved(provider, feature0.issue.ref, "feature-pr", opts);
  return { feature0: feature0.issue, task0: task0.issue };
}

/** Ensure a Feature's reserved Task 0. */
export async function ensureFeatureReserved(
  provider: IssueProvider,
  feature: IssueRef,
  opts: ReservedOptions = {},
): Promise<Issue> {
  const task0 = await ensureReserved(provider, feature, "feature-pr", opts);
  return task0.issue;
}

export interface HierarchyAudit {
  missing: Array<{ parent: IssueRef; kind: ReservedKind }>;
  duplicates: Array<{ parent: IssueRef; kind: ReservedKind; numbers: number[] }>;
  conflicts: Array<{ parent: IssueRef; kind: ReservedKind; numbers: number[] }>;
}

function conflicting(issue: Issue, parent: IssueRef, kind: ReservedKind): boolean {
  if (issue.reserved) return !sameRef(issue.reserved.for, parent);
  return issue.title.trim() === RESERVED_TITLES[kind] && !isReservedFor(issue, parent, kind);
}

/** Read-only audit of an Epic/Feature's reserved hierarchy. */
export async function auditHierarchy(
  provider: IssueProvider,
  root: IssueRef,
): Promise<HierarchyAudit> {
  const audit: HierarchyAudit = { missing: [], duplicates: [], conflicts: [] };
  const issue = await provider.get(root);
  if (!issue) return audit;
  const kinds: ReservedKind[] = issue.kind === "epic" ? ["epic-pr", "feature-pr"] : ["feature-pr"];
  // For an epic, feature-pr is checked under its Feature 0.
  const feature0s =
    issue.kind === "epic"
      ? (await provider.children(root)).filter((c) => isReservedFor(c, root, "epic-pr"))
      : [issue];
  if (issue.kind === "epic" && feature0s.length === 0) audit.missing.push({ parent: root, kind: "epic-pr" });
  for (const parent of feature0s) {
    const children = await provider.children(parent.ref);
    const matches = children.filter((c) => isReservedFor(c, parent.ref, "feature-pr"));
    const conflicts = children.filter((c) => conflicting(c, parent.ref, "feature-pr"));
    if (matches.length === 0) audit.missing.push({ parent: parent.ref, kind: "feature-pr" });
    if (matches.length > 1) {
      audit.duplicates.push({ parent: parent.ref, kind: "feature-pr", numbers: matches.map((m) => m.ref.number) });
    }
    if (conflicts.length > 0) {
      audit.conflicts.push({ parent: parent.ref, kind: "feature-pr", numbers: conflicts.map((c) => c.ref.number) });
    }
  }
  // For an epic, report duplicate Feature 0s at the epic level.
  if (issue.kind === "epic" && feature0s.length > 1) {
    audit.duplicates.push({ parent: root, kind: "epic-pr", numbers: feature0s.map((f) => f.ref.number) });
  }
  return audit;
}

/**
 * Resolve the Task a run must attach to for planning/review:
 *   Epic → its reserved Feature 0's Task 0
 *   Feature → its reserved Task 0
 *   Task → itself
 */
export async function resolvePlanningAnchor(
  provider: IssueProvider,
  ref: IssueRef,
  opts: ReservedOptions = {},
): Promise<IssueRef> {
  const issue = await provider.get(ref);
  if (!issue) throw new IssueError("issue_not_found", `issue ${ref.repo}#${ref.number} not found`);
  if (issue.kind === "task") return issue.ref;
  if (issue.kind === "feature") {
    const task0 = await ensureFeatureReserved(provider, issue.ref, opts);
    return task0.ref;
  }
  const { task0 } = await ensureEpicReserved(provider, issue.ref, opts);
  return task0.ref;
}

/**
 * Validate a run's primary issue association: it must be a Task. Build-like
 * runs must target deliverable Tasks (not reserved Task 0).
 */
export async function validateRunIssue(
  provider: IssueProvider,
  ref: IssueRef,
  opts: { allowReserved?: boolean } = {},
): Promise<Issue> {
  const issue = await provider.get(ref);
  if (!issue) throw new IssueError("issue_not_found", `issue ${ref.repo}#${ref.number} not found`);
  if (issue.kind !== "task") {
    throw new IssueError(
      "issue_not_task",
      `runs attach to Tasks only (${ref.repo}#${ref.number} is a ${issue.kind}); use its reserved Task 0 for planning/review`,
    );
  }
  if (!opts.allowReserved && isReservedTask(issue)) {
    throw new IssueError(
      "issue_is_reserved_task",
      `${ref.repo}#${ref.number} is a reserved Task 0 (planning/review anchor); implementation runs need a deliverable Task`,
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
