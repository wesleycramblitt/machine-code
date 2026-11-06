/**
 * machine_code — deterministic feature readiness and dispatch selection.
 *
 * The scheduler reads issues and run records only. It never calls a model and
 * never writes project state. A feature is ready when it is open, carries
 * acceptance criteria, all blockers are closed, and no active run owns it.
 * No `mc:plan` marker is required.
 */
import { refKey, type Issue, type IssueRef } from "../issues/provider.js";
import { validatePlanGraph } from "../plan/validate.js";
import { parsePlanMarker, type PlanMarker } from "../plan/schema.js";
import type { RunSummary } from "../state/runs.js";

export type OrchestrationScope = "project" | "epic" | "feature";

export interface ScheduleInput {
  issues: readonly Issue[];
  scope: OrchestrationScope;
  /** Required for epic/feature scope. */
  scopeRef?: IssueRef;
  /** Current run records; active runs suppress duplicate dispatch. */
  runs?: readonly RunSummary[];
  maxParallel?: number;
}

export interface ScheduledTask {
  issue: Issue;
  plan?: PlanMarker;
  ready: boolean;
  reason?: string;
  /** Position in deterministic dependency order. */
  order: number;
}

export interface ScheduleResult {
  scope: OrchestrationScope;
  scopeRef?: IssueRef;
  tasks: ScheduledTask[];
  ready: ScheduledTask[];
  dispatch: ScheduledTask[];
  blocked: ScheduledTask[];
  errors: string[];
}

const ACTIVE_RUN_STATUSES = new Set(["created", "running", "awaiting_input", "paused", "interrupted"]);

function assignedIssue(run: RunSummary): IssueRef | undefined {
  return run.issue ?? run.taskIssue;
}

function tasksForScope(issues: readonly Issue[], scope: OrchestrationScope, scopeRef?: IssueRef): Issue[] {
  const features = issues.filter((issue) => issue.kind === "feature");
  // "project" is a deprecated alias for an epic-wide sweep: every feature.
  if (scope === "project") return features;
  if (!scopeRef) return [];
  if (scope === "feature") {
    return features.filter((issue) => issue.ref.repo === scopeRef.repo && issue.ref.number === scopeRef.number);
  }
  // Epic scope: features whose parent is the epic root.
  return features.filter(
    (issue) => issue.parent?.repo === scopeRef.repo && issue.parent.number === scopeRef.number,
  );
}

function activeFeatureKeys(runs: readonly RunSummary[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const run of runs ?? []) {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const assigned = assignedIssue(run);
    if (assigned) keys.add(refKey(assigned));
  }
  return keys;
}

/** Latest terminal run per feature; automatic dispatch waits for review/closure. */
function terminalFeatureRuns(runs: readonly RunSummary[] | undefined): Map<string, RunSummary> {
  const out = new Map<string, RunSummary>();
  for (const run of runs ?? []) {
    if (ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const assigned = assignedIssue(run);
    if (!assigned) continue;
    const key = refKey(assigned);
    const prior = out.get(key);
    if (!prior || prior.startedAt <= run.startedAt) out.set(key, run);
  }
  return out;
}

function deterministicOrder(tasks: readonly Issue[]): Issue[] {
  const byKey = new Map(tasks.map((issue) => [refKey(issue.ref), issue]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const issue of tasks) {
    const key = refKey(issue.ref);
    indegree.set(key, 0);
  }
  for (const issue of tasks) {
    const key = refKey(issue.ref);
    for (const blocker of issue.blockedBy) {
      const blockerKey = refKey(blocker);
      if (!byKey.has(blockerKey)) continue;
      indegree.set(key, (indegree.get(key) ?? 0) + 1);
      const list = dependents.get(blockerKey) ?? [];
      list.push(key);
      dependents.set(blockerKey, list);
    }
  }
  const keyOf = (key: string) => byKey.get(key)!;
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([key]) => key);
  ready.sort((a, b) => keyOf(a).ref.number - keyOf(b).ref.number);
  const out: Issue[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    out.push(keyOf(key));
    for (const dependent of dependents.get(key) ?? []) {
      const next = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((a, b) => keyOf(a).ref.number - keyOf(b).ref.number);
      }
    }
  }
  if (out.length < tasks.length) {
    const seen = new Set(out.map((issue) => refKey(issue.ref)));
    out.push(...tasks.filter((issue) => !seen.has(refKey(issue.ref))).sort((a, b) => a.ref.number - b.ref.number));
  }
  return out;
}

export function planSchedule(input: ScheduleInput): ScheduleResult {
  const byKey = new Map(input.issues.map((issue) => [refKey(issue.ref), issue]));
  const scopeTasks = tasksForScope(input.issues, input.scope, input.scopeRef);
  const order = deterministicOrder(scopeTasks);
  const active = activeFeatureKeys(input.runs);
  const terminal = terminalFeatureRuns(input.runs);
  const errors: string[] = [];
  if (input.scope !== "project" && !input.scopeRef) {
    errors.push(`${input.scope} scope requires scopeRef`);
  } else if (input.scopeRef && !byKey.has(refKey(input.scopeRef))) {
    errors.push(`scope root ${input.scopeRef.repo}#${input.scopeRef.number} was not loaded`);
  }
  const scheduled: ScheduledTask[] = [];

  for (let index = 0; index < order.length; index++) {
    const issue = order[index]!;
    const key = refKey(issue.ref);
    const plan = parsePlanMarker(issue.body).plan;
    const reasons: string[] = [];
    if (issue.state !== "open") reasons.push("issue is closed");
    if (issue.acceptance.length === 0) reasons.push("feature has no acceptance criteria");
    if (active.has(key)) reasons.push("an active run already owns this feature");
    const prior = terminal.get(key);
    // A terminal run proven to have zero model calls never started work
    // (setup or worktree failure): there is nothing to review, so it must not
    // suppress redispatch. Anything that ran — or might have — is held for
    // review/closure as before.
    if (prior && prior.modelCalls !== 0) {
      reasons.push(`last run ${prior.id} is ${prior.status}; awaiting review/closure`);
    }
    for (const blocker of issue.blockedBy) {
      const target = byKey.get(refKey(blocker));
      if (!target) reasons.push(`blocker ${blocker.repo}#${blocker.number} is not loaded`);
      else if (target.state !== "closed") reasons.push(`blocked by #${blocker.number}`);
    }
    const value: ScheduledTask = {
      issue,
      ...(plan ? { plan } : {}),
      ready: reasons.length === 0,
      ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
      order: index,
    };
    scheduled.push(value);
  }

  const graph = validatePlanGraph(scopeTasks, { requireReady: true });
  for (const error of graph.errors) {
    if (error.includes("dependency cycle")) errors.push(error);
  }
  const ready = scheduled.filter((task) => task.ready);
  const maxParallel = Math.max(0, Math.floor(input.maxParallel ?? ready.length));
  return {
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    tasks: scheduled,
    ready,
    dispatch: ready.slice(0, maxParallel),
    blocked: scheduled.filter((task) => !task.ready),
    errors,
  };
}
