/**
 * machine_code — plan-file tracking lines.
 *
 * When the planner works from a plan file in `plans/`, created Epics and
 * Features are appended as `- [ ] Epic #123: title` lines, and lines are
 * removed as their issues close. The issue tools call these best-effort
 * helpers; tracking failures must never fail the tool.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type PlanTrackingKind = "epic" | "feature";

export function planTrackingLine(kind: PlanTrackingKind, number: number, title: string): string {
  const label = kind === "epic" ? "Epic" : "Feature";
  return `- [ ] ${label} #${number}: ${title}`;
}

function withinRepo(root: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const base = resolve(root);
  const abs = resolve(base, rel);
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

function issuePattern(number: number): RegExp {
  return new RegExp(`#${number}(?!\\d)`);
}

/** All `plans/*.md` files that exist, as repo-relative paths. */
export function findPlanFiles(repoRoot: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, "plans")).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return out;
  }
  for (const name of names) out.push(join("plans", name));
  return out;
}

/**
 * Append `line` to the plan file unless a line for that issue is present.
 * Creates parent directories. No-op when the line is already tracked.
 */
export function appendPlanTracking(repoRoot: string, planFile: string, line: string): void {
  const abs = withinRepo(repoRoot, planFile);
  if (!abs) return;
  const match = line.match(/#(\d+)/);
  const number = match ? Number(match[1]) : NaN;
  let current = "";
  try {
    current = readFileSync(abs, "utf8");
  } catch {
    // Missing file: create it below.
  }
  if (Number.isInteger(number) && issuePattern(number).test(current)) return;
  if (current.length > 0 && !current.endsWith("\n")) current += "\n";
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${current}${line}\n`, "utf8");
  } catch {
    // Best-effort: tracking must never fail the caller.
  }
}

/** Drop lines mentioning `#<number>` from the plan file. */
export function removePlanTracking(repoRoot: string, planFile: string, number: number): void {
  const abs = withinRepo(repoRoot, planFile);
  if (!abs || !existsSync(abs)) return;
  try {
    const pattern = issuePattern(number);
    const next = readFileSync(abs, "utf8")
      .split("\n")
      .filter((entry) => !pattern.test(entry))
      .join("\n");
    writeFileSync(abs, next, "utf8");
  } catch {
    // Best-effort: tracking must never fail the caller.
  }
}
