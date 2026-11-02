/**
 * machine_code — deterministic task readiness and dispatch selection.
 *
 * The scheduler reads issues and run records only. It never calls a model and
 * never writes project state. A task is ready when its plan is ready, all
 * blockers are closed, and no active run already owns it.
 */
import { refKey, type Issue, type IssueRef } from "../issues/provider.js";
import { validatePlanGraph, validatePlanIssue } from "../plan/validate.js";
import { isReadyPlan, type PlanMarker } from "../plan/schema.js";
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

function parentOf(issue: Issue, byKey: ReadonlyMap<string, Issue>): Issue | undefined {
  return issue.parent ? byKey.get(refKey(issue.parent)) : undefined;
}

function inScope(issue: Issue, root: Issue, byKey: ReadonlyMap<string, Issue>): boolean {
  const rootKey = refKey(root.ref);
  let current: Issue | undefined = issue;
  const seen = new Set<string>();
  while (current?.parent) {
    const key = refKey(current.parent);
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === rootKey) return true;
    current = parentOf(current, byKey);
  }
  return false;
}

function tasksForScope(issues: readonly Issue[], scope: OrchestrationScope, scopeRef?: IssueRef): Issue[] {
  if (scope === "project") return issues.filter((issue) => issue.kind === "task");
  if (!scopeRef) return [];
  const byKey = new Map(issues.map((issue) => [refKey(issue.ref), issue]));
  const root = byKey.get(refKey(scopeRef));
  if (!root) return [];
  return issues.filter((issue) => issue.kind === "task" && inScope(issue, root, byKey));
}

function activeTaskKeys(runs: readonly RunSummary[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const run of runs ?? []) {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const task = run.taskIssue ?? run.issue;
    if (task) keys.add(refKey(task));
  }
  return keys;
}

/** Latest terminal run per task; automatic dispatch waits for review/closure. */
function terminalTaskRuns(runs: readonly RunSummary[] | undefined): Map<string, RunSummary> {
  const out = new Map<string, RunSummary>();
  for (const run of runs ?? []) {
    if (ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const task = run.taskIssue ?? run.issue;
    if (!task) continue;
    const key = refKey(task);
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
  const active = activeTaskKeys(input.runs);
  const terminal = terminalTaskRuns(input.runs);
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
    const validation = validatePlanIssue(issue, { requireReady: true });
    const plan = validation.plan;
    const reasons: string[] = [];
    if (issue.state !== "open") reasons.push("issue is closed");
    if (!isReadyPlan(plan)) reasons.push("plan is not ready");
    if (!validation.ok) reasons.push(...validation.errors);
    if (active.has(key)) reasons.push("an active run already owns this task");
    const prior = terminal.get(key);
    if (prior) reasons.push(`last run ${prior.id} is ${prior.status}; awaiting review/closure`);
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
