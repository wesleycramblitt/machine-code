/**
 * machine_code — pure TUI status model.
 *
 * Everything here is a deterministic derivation over run summaries and cached
 * issues: grouping, rollups, health, header counts, the awaiting-human queue,
 * and filtering/sorting. The TUI renderer only formats these values, which
 * keeps the status surfaces testable without a terminal.
 */
import type { Issue, IssueRef } from "../issues/provider.js";
import type { RunStatus, RunSummary } from "../state/runs.js";

export type RunFilter = "active" | "paused" | "completed" | "awaiting" | "all";
export type SortKey = "activity" | "number" | "severity" | "cost";

export type IssueHealth =
  | "on-track"
  | "awaiting-human"
  | "review"
  | "paused"
  | "blocked"
  | "attention"
  | "stalled"
  | "done";

const HEALTH_SEVERITY: Record<IssueHealth, number> = {
  attention: 0,
  blocked: 1,
  "awaiting-human": 2,
  paused: 3,
  review: 4,
  stalled: 5,
  "on-track": 6,
  done: 7,
};

export function issueKey(issue: IssueRef | undefined): string | null {
  return issue ? `${issue.repo}#${issue.number}` : null;
}

export function runIssueKey(run: RunSummary): string | null {
  return issueKey(run.issue);
}

export function isReservedIssue(issue: Issue): boolean {
  return Boolean(issue.reserved) || issue.labels.some((l) => l.startsWith("mc:reserved"));
}

/** Reserved Feature 0 / Task 0 are coordination anchors, not deliverables. */
export function isDeliverable(issue: Issue): boolean {
  return !isReservedIssue(issue);
}

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
      return copy.sort((a, b) => {
        const an = a.issue?.number;
        const bn = b.issue?.number;
        if (an === undefined && bn === undefined) return a.id.localeCompare(b.id);
        if (an === undefined) return 1;
        if (bn === undefined) return -1;
        return an - bn || a.id.localeCompare(b.id);
      });
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

export interface IssueRollup {
  issue: Issue;
  key: string;
  pct?: number;
  tasksClosed: number;
  tasksTotal: number;
  runsActive: number;
  runsTotal: number;
  cost: number;
  lastActivity?: string;
  health: IssueHealth;
  branch?: string;
  prState?: string;
  approval?: string;
  blockers: number;
}

export interface IssueTree {
  epics: Array<{
    epic: Issue;
    rollup: IssueRollup;
    features: Array<{
      feature: Issue;
      rollup: IssueRollup;
      tasks: Array<{ task: Issue; rollup: IssueRollup; runs: RunSummary[] }>;
      runs: RunSummary[];
    }>;
    runs: RunSummary[];
  }>;
  planning: RunSummary[];
  untracked: RunSummary[];
  orphaned: RunSummary[];
}

function runsFor(issue: Issue, byIssue: Map<string, RunSummary[]>): RunSummary[] {
  return byIssue.get(`${issue.ref.repo}#${issue.ref.number}`) ?? [];
}

/** Issue-row glyphs stay about the issue, not about the runs below it. */
export type IssueGlyphKind = "closed" | "blocked" | "ready" | "draft" | "open";

export function issueGlyphKind(issue: Issue): IssueGlyphKind {
  if (issue.state === "closed") return "closed";
  if (issue.kind === "epic") return "open";
  if (issue.blockedBy.length > 0) return "blocked";
  if (issue.kind === "task") {
    if (issue.plan?.status === "ready") return "ready";
    if (issue.plan?.status === "draft") return "draft";
  }
  return "open";
}

export function healthOf(
  issue: Issue,
  runs: readonly RunSummary[],
  now = Date.now(),
  stallMs = 24 * 60 * 60 * 1000,
): IssueHealth {
  if (issue.state === "closed") return "done";
  if (runs.some((r) => r.status === "failed")) return "attention";
  if (runs.some((r) => r.status === "blocked")) return "attention";
  if (issue.blockedBy.length > 0 && issue.state === "open") return "blocked";
  if (runs.some((r) => r.status === "awaiting_input")) return "awaiting-human";
  if (runs.some((r) => r.status === "paused" || r.status === "interrupted")) return "paused";
  if (runs.some((r) => r.agent === "review" && (r.status === "running" || r.status === "completed"))) return "review";
  const latest = runs.reduce((max, r) => Math.max(max, lastActivity(r)), 0);
  if (latest > 0 && now - latest > stallMs) return "stalled";
  return "on-track";
}

export function rollupIssue(
  issue: Issue,
  runs: readonly RunSummary[],
  tasks: readonly Issue[] = [],
  descendantRuns: readonly RunSummary[] = [],
  now = Date.now(),
): IssueRollup {
  const allRuns = [...runs, ...descendantRuns];
  const deliverableTasks = tasks.filter((c) => c.kind === "task" && isDeliverable(c));
  const tasksClosed = deliverableTasks.filter((c) => c.state === "closed").length;
  const tasksTotal = deliverableTasks.length;
  const latest = allRuns.reduce((max, r) => Math.max(max, lastActivity(r)), 0);
  const latestRun = [...allRuns].sort((a, b) => lastActivity(b) - lastActivity(a))[0];
  return {
    issue,
    key: `${issue.ref.repo}#${issue.ref.number}`,
    pct: tasksTotal > 0 ? Math.round((tasksClosed / tasksTotal) * 100) : undefined,
    tasksClosed,
    tasksTotal,
    runsActive: allRuns.filter((r) => r.status === "running" || r.status === "awaiting_input").length,
    runsTotal: allRuns.length,
    cost: allRuns.reduce((sum, r) => sum + r.cost.actual, 0),
    lastActivity: latest > 0 ? new Date(latest).toISOString() : undefined,
    health: healthOf(issue, allRuns, now),
    branch: latestRun?.branch,
    prState: latestRun?.prState,
    approval: issue.approval,
    blockers: issue.blockedBy.length,
  };
}

export function buildIssueTree(
  issues: readonly Issue[],
  runs: readonly RunSummary[],
  now = Date.now(),
): IssueTree {
  const byIssue = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = runIssueKey(run);
    if (!key) continue;
    const list = byIssue.get(key) ?? [];
    list.push(run);
    byIssue.set(key, list);
  }
  const byNumber = new Map<string, Issue>();
  for (const issue of issues) byNumber.set(`${issue.ref.repo}#${issue.ref.number}`, issue);

  const childrenOf = (issue: Issue) => issues.filter((i) => i.parent?.number === issue.ref.number && i.parent.repo === issue.ref.repo);
  const known = new Set(issues.map((i) => `${i.ref.repo}#${i.ref.number}`));

  const epics = issues
    .filter((i) => i.kind === "epic")
    .map((epic) => {
      const features = childrenOf(epic)
        .filter((f) => f.kind === "feature")
        .map((feature) => {
          const tasks = childrenOf(feature)
            .filter((t) => t.kind === "task")
            .map((task) => ({
              task,
              rollup: rollupIssue(task, runsFor(task, byIssue), [], [], now),
              runs: sortRuns(runsFor(task, byIssue), "activity"),
            }));
          const deliverableTasks = tasks.filter((t) => isDeliverable(t.task));
          return {
            feature,
            rollup: rollupIssue(
              feature,
              runsFor(feature, byIssue),
              deliverableTasks.map((t) => t.task),
              tasks.flatMap((t) => runsFor(t.task, byIssue)),
              now,
            ),
            tasks: sortTasks(tasks),
            runs: sortRuns(runsFor(feature, byIssue), "activity"),
          };
        });
      const allFeatureTasks = features.flatMap((f) =>
        f.tasks.filter((t) => isDeliverable(t.task)).map((t) => t.task),
      );
      const allFeatureRuns = features.flatMap((f) => [
        ...f.runs,
        ...f.tasks.flatMap((t) => t.runs),
      ]);
      return {
        epic,
        rollup: rollupIssue(epic, runsFor(epic, byIssue), allFeatureTasks, allFeatureRuns, now),
        features: sortFeatures(features),
        runs: sortRuns(runsFor(epic, byIssue), "activity"),
      };
    });

  const planning: RunSummary[] = [];
  const untracked: RunSummary[] = [];
  const orphaned: RunSummary[] = [];
  for (const run of runs) {
    if (!run.issue) {
      untracked.push(run);
      continue;
    }
    if (!known.has(`${run.issue.repo}#${run.issue.number}`)) orphaned.push(run);
  }

  return {
    epics: sortEpics(epics),
    planning: sortRuns(planning, "activity"),
    untracked: sortRuns(untracked, "activity"),
    orphaned: sortRuns(orphaned, "activity"),
  };
}

function sortTasks<T extends { task: Issue }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const ra = isReservedIssue(a.task) ? 0 : 1;
    const rb = isReservedIssue(b.task) ? 0 : 1;
    return ra - rb || a.task.ref.number - b.task.ref.number;
  });
}

function sortFeatures<T extends { feature: Issue }>(features: T[]): T[] {
  return [...features].sort((a, b) => {
    const ra = isReservedIssue(a.feature) ? 0 : 1;
    const rb = isReservedIssue(b.feature) ? 0 : 1;
    return ra - rb || a.feature.ref.number - b.feature.ref.number;
  });
}

function sortEpics<T extends { epic: Issue }>(epics: T[]): T[] {
  return [...epics].sort((a, b) => a.epic.ref.number - b.epic.ref.number);
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
  issue?: IssueRef;
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
        issue: run.issue,
        label: `answer question${run.issue ? ` on #${run.issue.number}` : ""}`,
        ageMs: now - lastActivity(run),
        order: healthOrder("awaiting-human"),
      });
    }
    if (run.prState === "open" && run.status === "completed") {
      out.push({
        kind: "pr",
        runId: run.id,
        issue: run.issue,
        pr: run.prNumber,
        label: `review/merge PR #${run.prNumber}${run.issue ? ` for #${run.issue.number}` : ""}`,
        ageMs: now - lastActivity(run),
        order: healthOrder("awaiting-human") + 1,
      });
    }
  }
  return out.sort((a, b) => a.order - b.order || b.ageMs - a.ageMs);
}

function healthOrder(h: IssueHealth): number {
  return HEALTH_SEVERITY[h];
}

export function severityOf(health: IssueHealth): number {
  return HEALTH_SEVERITY[health];
}
