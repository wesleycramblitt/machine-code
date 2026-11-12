/**
 * machine_code — context source planning.
 *
 * One place owns section order, composer section mapping, and the drop
 * priority used when the model budget is tight. Assemble, preview, and future
 * context views read the same policy instead of re-deriving it.
 */
import type { ContextKind } from "./types.js";

/** Fixed render order: issue first, files next, aggregates, parents last. */
export const CONTEXT_RENDER_ORDER: Record<string, number> = {
  issue: 1,
  file: 2,
  docs: 3,
  reference: 4,
  skill: 5,
  script: 6,
  tool: 7,
  "parent-run": 8,
};

/** Composer exclusion section → context kinds. */
export const SECTION_KINDS: Record<string, readonly ContextKind[]> = {
  files: ["file"],
  docs: ["docs"],
  references: ["reference"],
  skills: ["skill"],
  tools: ["tool"],
  scripts: ["script"],
  issues: ["issue"],
};

/**
 * Higher is dropped first when the prompt exceeds the model budget.
 * Tool/skill aggregates go first; the issue goes last on every role.
 */
export function dropRank(kind: ContextKind, origin: string, role?: string): number {
  if (kind === "tool") return 60;
  if (kind === "skill") return 40;
  if (kind === "script") return 40;
  if (kind === "parent-run") return 50;
  if (kind === "issue") return origin === "explicit" ? 8 : 22;
  if (kind === "docs") return role === "research" ? 20 : 30;
  if (kind === "reference") return role === "research" ? 22 : 32;
  if (kind === "file") return role === "engineer" || role === "review" ? 25 : 30;
  return 30;
}

/** `^\d+ skills$` is an aggregate block, not a single skill body. */
export function isSkillIndex(ref: string): boolean {
  return /^\d+ skills$/.test(ref);
}
