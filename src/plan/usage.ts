/**
 * machine_code — artifact usage events.
 *
 * The Planner uses actual use, not intuition, to decide whether a tool or
 * script belongs at Task, Feature, or Epic scope. Records are JSON objects in
 * run event logs; unknown fields are ignored.
 */
import type { IssueRef } from "../issues/provider.js";

export type ArtifactKind = "tool" | "script" | "command" | "skill" | "knowledge" | "file";
export type ArtifactScope = "task" | "feature" | "epic";
export type ArtifactAction = "list" | "show" | "usage" | "create" | "update" | "run" | "attach";

export interface ArtifactUsage {
  artifact: string;
  kind: ArtifactKind;
  scope: ArtifactScope;
  issue?: IssueRef;
  runId: string;
  role: string;
  at: string;
  success: boolean;
  action: ArtifactAction;
}

const KINDS: readonly ArtifactKind[] = ["tool", "script", "command", "skill", "knowledge", "file"];
const SCOPES: readonly ArtifactScope[] = ["task", "feature", "epic"];
const ACTIONS: readonly ArtifactAction[] = ["list", "show", "usage", "create", "update", "run", "attach"];

function ref(value: unknown): IssueRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || typeof raw.repo !== "string" || typeof raw.number !== "number") return undefined;
  return { provider: raw.provider, repo: raw.repo, number: raw.number };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function parseArtifactUsage(value: unknown): ArtifactUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const artifact = typeof raw.artifact === "string" && raw.artifact.trim() ? raw.artifact.trim() : undefined;
  const kind = oneOf(raw.kind, KINDS);
  const scope = oneOf(raw.scope, SCOPES);
  const action = oneOf(raw.action, ACTIONS);
  if (!artifact || !kind || !scope || !action) return null;
  if (typeof raw.runId !== "string" || typeof raw.role !== "string" || typeof raw.at !== "string") return null;
  if (typeof raw.success !== "boolean") return null;
  return {
    artifact,
    kind,
    scope,
    issue: ref(raw.issue),
    runId: raw.runId,
    role: raw.role,
    at: raw.at,
    success: raw.success,
    action,
  };
}

/** Distinct Task numbers that used an artifact successfully. */
export function successfulTaskUsers(usages: readonly ArtifactUsage[], artifact: string): number[] {
  return [
    ...new Set(
      usages
        .filter((usage) => usage.artifact === artifact && usage.success && usage.scope === "task" && usage.issue)
        .map((usage) => usage.issue!.number),
    ),
  ].sort((a, b) => a - b);
}

/** Promotion hint: two distinct Tasks justify Feature/Epic consideration. */
export function isPromotionCandidate(usages: readonly ArtifactUsage[], artifact: string, threshold = 2): boolean {
  return successfulTaskUsers(usages, artifact).length >= Math.max(2, threshold);
}
