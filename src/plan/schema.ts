/**
 * machine_code — the `mc:plan` issue marker.
 *
 * A deliverable Task carries one JSON marker. Draft tasks are ignored by the
 * orchestrator; a ready marker supplies the build/review policy. Unknown keys
 * are ignored so the marker can grow without breaking older readers.
 */
export type PlanStatus = "draft" | "ready";
export type PlanRole = "build" | "review";
export type PlanVerification = "direct" | "verified" | "redundant";
export type PlanWorktree = "required" | "optional";
export type PlanReview = "agent" | "human";

export interface PlanMarker {
  v: 1;
  status: PlanStatus;
  role: PlanRole;
  verification: PlanVerification;
  worktree: PlanWorktree;
  retriesBeforeReplan: number;
  planReview: PlanReview;
  resultReview: PlanReview;
}

export interface PlanParseResult {
  /** True when the body contains an mc:plan comment, even if it is invalid. */
  present: boolean;
  plan?: PlanMarker;
  error?: string;
}

const STATUSES: readonly PlanStatus[] = ["draft", "ready"];
const ROLES: readonly PlanRole[] = ["build", "review"];
const VERIFICATIONS: readonly PlanVerification[] = ["direct", "verified", "redundant"];
const WORKTREES: readonly PlanWorktree[] = ["required", "optional"];
const REVIEWS: readonly PlanReview[] = ["agent", "human"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function parsePlanMarker(body: string): PlanParseResult {
  const match = body.match(/<!--\s*mc:plan\s*([\s\S]*?)-->/);
  if (!match) return { present: false };
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]!.trim());
  } catch {
    return { present: true, error: "mc:plan must contain valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { present: true, error: "mc:plan must be a JSON object" };
  }
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (value.v !== 1) errors.push("v must be 1");
  const status = oneOf(value.status, STATUSES) ?? "draft";
  if (value.status !== undefined && !oneOf(value.status, STATUSES)) {
    errors.push("status must be draft or ready");
  }
  const role = oneOf(value.role, ROLES) ?? "build";
  if (value.role !== undefined && !oneOf(value.role, ROLES)) {
    errors.push("role must be build or review");
  }
  const verification = oneOf(value.verification, VERIFICATIONS) ?? "verified";
  if (value.verification !== undefined && !oneOf(value.verification, VERIFICATIONS)) {
    errors.push("verification must be direct, verified, or redundant");
  }
  const worktree = oneOf(value.worktree, WORKTREES) ?? "required";
  if (value.worktree !== undefined && !oneOf(value.worktree, WORKTREES)) {
    errors.push("worktree must be required or optional");
  }
  const retriesRaw = value.retries_before_replan ?? 2;
  const retriesBeforeReplan =
    typeof retriesRaw === "number" && Number.isInteger(retriesRaw) && retriesRaw >= 0 && retriesRaw <= 20
      ? retriesRaw
      : undefined;
  if (retriesBeforeReplan === undefined) errors.push("retries_before_replan must be an integer in 0-20");
  const planReview = oneOf(value.plan_review, REVIEWS) ?? "agent";
  if (value.plan_review !== undefined && !oneOf(value.plan_review, REVIEWS)) {
    errors.push("plan_review must be agent or human");
  }
  const resultReview = oneOf(value.result_review, REVIEWS) ?? "agent";
  if (value.result_review !== undefined && !oneOf(value.result_review, REVIEWS)) {
    errors.push("result_review must be agent or human");
  }
  if (errors.length > 0) return { present: true, error: errors.join("; ") };
  return {
    present: true,
    plan: {
      v: 1,
      status,
      role,
      verification,
      worktree,
      retriesBeforeReplan: retriesBeforeReplan!,
      planReview,
      resultReview,
    },
  };
}

/** Render the canonical marker for a Planner update. */
export function renderPlanMarker(plan: PlanMarker): string {
  return [
    "<!-- mc:plan",
    JSON.stringify({
      v: plan.v,
      status: plan.status,
      role: plan.role,
      verification: plan.verification,
      worktree: plan.worktree,
      retries_before_replan: plan.retriesBeforeReplan,
      plan_review: plan.planReview,
      result_review: plan.resultReview,
    }),
    "-->",
  ].join("\n");
}

export function isReadyPlan(plan: PlanMarker | undefined): boolean {
  return plan?.status === "ready";
}
