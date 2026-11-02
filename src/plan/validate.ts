/**
 * machine_code — deterministic plan validation.
 *
 * The Planner writes issues; this module checks the machine-readable parts
 * before the Orchestrator may dispatch them. It never calls a model.
 */
import { refKey, type Issue } from "../issues/provider.js";
import { parsePlanMarker, type PlanMarker } from "./schema.js";

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  plan?: PlanMarker;
}

export interface ValidatePlanOptions {
  /** Require `status: ready`; drafts are otherwise structurally valid. */
  requireReady?: boolean;
}

export function validatePlanIssue(issue: Issue, options: ValidatePlanOptions = {}): PlanValidation {
  const parsed = parsePlanMarker(issue.body);
  if (!parsed.present) return { ok: false, errors: ["missing mc:plan marker"] };
  if (parsed.error || !parsed.plan) return { ok: false, errors: [parsed.error ?? "invalid mc:plan marker"] };
  const plan = parsed.plan;
  const errors: string[] = [];
  if (issue.kind !== "task") errors.push("mc:plan applies to Task issues");
  if (issue.reserved) errors.push("reserved anchors cannot be deliverable plans");
  if (issue.acceptance.length === 0) errors.push("missing acceptance criteria");
  for (const blocker of issue.blockedBy) {
    if (blocker.repo !== issue.ref.repo) {
      errors.push(`blocker ${blocker.repo}#${blocker.number} is in another repository`);
    }
    if (blocker.repo === issue.ref.repo && blocker.number === issue.ref.number) {
      errors.push("a task cannot block itself");
    }
  }
  if (options.requireReady && plan.status !== "ready") {
    errors.push("plan is still draft");
  }
  return { ok: errors.length === 0, errors, plan };
}

export interface PlanGraphValidation {
  ok: boolean;
  errors: string[];
}

/** Validate markers plus cycles across a set of Task issues. */
export function validatePlanGraph(issues: readonly Issue[], options: ValidatePlanOptions = {}): PlanGraphValidation {
  const errors: string[] = [];
  const tasks = issues.filter((issue) => issue.kind === "task");
  const byKey = new Map(tasks.map((issue) => [refKey(issue.ref), issue]));
  for (const issue of tasks) {
    const result = validatePlanIssue(issue, options);
    for (const error of result.errors) errors.push(`#${issue.ref.number}: ${error}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (issue: Issue, path: string[]): void => {
    const key = refKey(issue.ref);
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      errors.push(`dependency cycle: ${[...path, key].join(" -> ")}`);
      return;
    }
    visiting.add(key);
    for (const blocker of issue.blockedBy) {
      const next = byKey.get(refKey(blocker));
      if (next) visit(next, [...path, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const issue of tasks) visit(issue, []);
  return { ok: errors.length === 0, errors };
}
