/**
 * machine_code — deterministic plan validation.
 *
 * The Planner writes issues; this module checks the machine-readable parts
 * before the Orchestrator may dispatch them. It never calls a model.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { refKey, type Issue } from "../issues/provider.js";
import { parsePlanMarker, type PlanMarker } from "./schema.js";
import { parseArtifactReferences } from "../context/references.js";
import { readReference } from "../references/store.js";
import { artifactExists, resolveArtifact } from "../artifacts/registry.js";
import type { Layout } from "../paths.js";

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  plan?: PlanMarker;
}

export interface ValidatePlanOptions {
  /** Require `status: ready`; drafts are otherwise structurally valid. */
  requireReady?: boolean;
  /** When present, validate that mc:context references exist. */
  layout?: Layout;
}

function withinRepo(root: string, path: string): string | null {
  if (path.startsWith("/")) return null;
  const base = resolve(root);
  const abs = resolve(base, path);
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

function skillExists(layout: Layout, name: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return false;
  for (const dir of [join(layout.repoDir, "skills", name), join(layout.home, "skills", name)]) {
    if (existsSync(join(dir, "SKILL.md"))) return true;
  }
  return false;
}

/** Check only the references that can be resolved without network access. */
function contextErrors(issue: Issue, layout: Layout): string[] {
  const refs = parseArtifactReferences(issue.body);
  const errors: string[] = [];
  for (const [kind, paths] of [["file", refs.files], ["knowledge", refs.knowledge]] as const) {
    for (const path of paths) {
      const abs = withinRepo(layout.repoRoot, path);
      if (!abs || !existsSync(abs)) errors.push(`referenced ${kind} ${path} is missing or outside the repo`);
      else {
        try {
          if (!statSync(abs).isFile()) errors.push(`referenced ${kind} ${path} is not a file`);
        } catch {
          errors.push(`referenced ${kind} ${path} is unreadable`);
        }
      }
    }
  }
  for (const citation of refs.references) {
    const read = readReference(layout, citation, 1);
    if (!read.ok) errors.push(`referenced reference ${citation} is missing or outside the store`);
  }
  for (const [kind, names] of [["tool", refs.tools], ["script", refs.scripts]] as const) {
    for (const name of names) {
      const artifact = resolveArtifact(layout, name);
      if (!artifact || !artifactExists(layout, artifact)) errors.push(`referenced ${kind} ${name} is missing`);
    }
  }
  for (const name of refs.skills) {
    if (!skillExists(layout, name)) errors.push(`referenced skill ${name} is missing`);
  }
  return errors;
}

/** A Task is one deliverable, not a feature. */
export const TASK_MAX_ACCEPTANCE = 3;
export const TASK_MAX_BODY_CHARS = 4_000;
export const TASK_MAX_ACCEPTANCE_CHARS = 240;

export interface TaskSizeInput {
  acceptance: readonly string[];
  body: string;
}

/** Structural size limits for a Task packet. */
export function taskSizeErrors(task: TaskSizeInput): string[] {
  const errors: string[] = [];
  if (task.acceptance.length > TASK_MAX_ACCEPTANCE) {
    errors.push(
      `task has ${task.acceptance.length} acceptance criteria; split it into smaller Tasks ` +
        `with at most ${TASK_MAX_ACCEPTANCE} each`,
    );
  }
  const broad = task.acceptance.filter((item) => item.length > TASK_MAX_ACCEPTANCE_CHARS);
  if (broad.length > 0) {
    errors.push(
      `${broad.length} acceptance criterion/criteria exceed ${TASK_MAX_ACCEPTANCE_CHARS} chars; ` +
        "make each a single verifiable result",
    );
  }
  if (task.body.length > TASK_MAX_BODY_CHARS) {
    errors.push(
      `task body is ${task.body.length} chars; keep a Task packet under ${TASK_MAX_BODY_CHARS} chars and split the work`,
    );
  }
  return errors;
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
  errors.push(...taskSizeErrors(issue));
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
  if (options.layout) errors.push(...contextErrors(issue, options.layout));
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
