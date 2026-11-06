/**
 * machine_code — plan-file tracking lines.
 *
 * When the planner works from a plan file in `plans/`, each created Epic or
 * Feature replaces the plan line(s) it came from with a `- [ ] Epic/Feature
 * #n: title` line (via `plan_ref`, e.g. `plans/tui.md:12-14`). Items without
 * a source ref are appended, and lines are removed as their issues close.
 * Every change is committed on main right away so the plan file stays the
 * source of truth through planning. The issue tools call these best-effort
 * helpers; tracking failures must never fail the tool.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { runProc } from "../proc.js";
import { mainWorktreeRoot } from "../worktree.js";

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
export function findPlanFiles(repoRoot: string): string[] {  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, "plans")).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return out;
  }
  for (const name of names) out.push(join("plans", name));
  return out;
}

/** Plan file lines, or null when the file is missing or unreadable. */
export function readPlanLines(repoRoot: string, planFile: string): string[] | null {
  const abs = withinRepo(repoRoot, planFile);
  if (!abs || !existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8").split("\n");
  } catch {
    return null;
  }
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

export interface PlanSourceRef {
  /** Repo-relative plan file, always under plans/. */
  file: string;
  /** 1-based inclusive line range the issue came from. */
  start: number;
  end: number;
}

/**
 * Parse `plans/<name>.md:<start>[-<end>]` (1-based inclusive lines).
 * Returns `{ ref }` or `{ error }` with an actionable message.
 */
export function parsePlanRef(value: string): { ref?: PlanSourceRef; error?: string } {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) {
    return { error: `plan_ref "${value}" must look like plans/<name>.md:<start>[-<end>] with 1-based line numbers` };
  }
  const file = match[1]!;
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!file.startsWith("plans/") || !file.endsWith(".md")) {
    return { error: `plan_ref "${value}" must point under plans/ (got "${file}")` };
  }
  if (file.includes("..") || start < 1 || end < start) {
    return { error: `plan_ref "${value}" has an invalid range; use plans/<name>.md:<start>[-<end>] with start >= 1` };
  }
  return { ref: { file, start, end } };
}

/** A markdown ATX heading (`#`, `##`, …) starts a general section: it is never part of a plan item. */
function isHeadingLine(line: string): boolean {
  return /^\s*#{1,6}(\s|$)/.test(line);
}

/**
 * Replace plan file lines [start, end] (1-based inclusive) with `line`.
 * Heading lines in the range belong to the section, not the plan item, so
 * they stay in place and only the remaining lines collapse into `line`.
 * Returns `{ replaced: false, error }` when the file is missing, the range
 * is out of bounds, or the range holds only headings (nothing to replace).
 */
export function replacePlanLines(
  repoRoot: string,
  planFile: string,
  start: number,
  end: number,
  line: string,
): { replaced: boolean; error?: string } {
  const abs = withinRepo(repoRoot, planFile);
  if (!abs || !existsSync(abs)) return { replaced: false, error: `plan file not found: ${planFile}` };
  let lines: string[];
  try {
    lines = readFileSync(abs, "utf8").split("\n");
  } catch (error) {
    return { replaced: false, error: `cannot read ${planFile}: ${(error as Error).message}` };
  }
  if (start < 1 || end > lines.length || end < start) {
    return { replaced: false, error: `plan_ref ${planFile}:${start}-${end} is out of bounds (${lines.length} lines)` };
  }
  const segment = lines.slice(start - 1, end);
  const kept: string[] = [];
  let inserted = false;
  for (const entry of segment) {
    if (isHeadingLine(entry)) kept.push(entry);
    else if (!inserted) {
      kept.push(line);
      inserted = true;
    }
  }
  if (!inserted) {
    return { replaced: false, error: `plan_ref ${planFile}:${start}-${end} names only headings; nothing to replace` };
  }
  lines.splice(start - 1, segment.length, ...kept);
  try {
    writeFileSync(abs, `${lines.join("\n").replace(/\n$/, "")}\n`, "utf8");
  } catch (error) {
    return { replaced: false, error: `cannot write ${planFile}: ${(error as Error).message}` };
  }
  return { replaced: true };
}

async function git(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runProc("git", args, { cwd, timeoutMs: 60_000 });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Commit one plan file on main. Resolves the main checkout first so a run
 * inside a linked worktree still lands the change on main. Never throws;
 * reports `{ committed: false }` when there is nothing to do (git missing,
 * not a repo, or nothing changed).
 */
export async function commitPlanFile(
  repoRoot: string,
  planFile: string,
  message: string,
): Promise<{ committed: boolean; error?: string }> {
  try {
    let main: string;
    try {
      main = await mainWorktreeRoot(repoRoot);
    } catch {
      main = repoRoot;
    }
    if (withinRepo(main, planFile) === null) return { committed: false, error: `plan file outside repo: ${planFile}` };
    const add = await git(main, ["add", "--", planFile]);
    if (add.code !== 0) return { committed: false, error: add.stderr.trim() || `git add exited ${add.code}` };
    const status = await git(main, ["status", "--porcelain", "--", planFile]);
    if (status.code === 0 && status.stdout.trim() === "") return { committed: false };
    let commit = await git(main, ["commit", "-m", message, "--", planFile]);
    if (commit.code !== 0) {
      commit = await git(main, [
        "-c",
        "user.name=machine_code",
        "-c",
        "user.email=machine_code@localhost",
        "commit",
        "-m",
        message,
        "--",
        planFile,
      ]);
    }
    if (commit.code !== 0) return { committed: false, error: commit.stderr.trim() || `git commit exited ${commit.code}` };
    return { committed: true };
  } catch (error) {
    return { committed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TrackIssueInput {
  kind: PlanTrackingKind;
  number: number;
  title: string;
  /** Fallback file when no plan_ref names one (append mode). */
  planFile?: string;
  /** Source lines, e.g. `plans/tui.md:12-14` (replace mode). */
  planRef?: string;
}

export interface TrackIssueResult {
  /** Human-readable note for the tool result, or "" when untracked. */
  note: string;
  committed: boolean;
}

/**
 * Record a created issue in its plan file: replace the `plan_ref` source
 * lines with the tracking line, or append when there is no source ref.
 * Commits the file on main. Never throws.
 */
export async function trackIssueInPlan(repoRoot: string, input: TrackIssueInput): Promise<TrackIssueResult> {
  try {
    const line = planTrackingLine(input.kind, input.number, input.title);
    let file = input.planFile;
    let note = "";
    if (input.planRef !== undefined) {
      const parsed = parsePlanRef(input.planRef);
      if (parsed.error || !parsed.ref) {
        return { note: ` Plan tracking skipped: ${parsed.error ?? "invalid plan_ref"}.`, committed: false };
      }
      file = parsed.ref.file;
      const replaced = replacePlanLines(repoRoot, file, parsed.ref.start, parsed.ref.end, line);
      if (!replaced.replaced) {
        appendPlanTracking(repoRoot, file, line);
        note = ` Tracked in ${file} (appended; ${replaced.error ?? "replace failed"}).`;
      } else {
        note = ` Replaced ${file}:${parsed.ref.start}-${parsed.ref.end} with ${line.split(":")[0]}.`;
      }
    } else {
      if (!file) return { note: "", committed: false };
      appendPlanTracking(repoRoot, file, line);
      note = ` Tracked in ${file}.`;
    }
    const message = `plans: track ${input.kind} #${input.number} in ${file}`;
    const { committed } = await commitPlanFile(repoRoot, file!, message);
    return { note: committed ? `${note} Committed on main.` : note, committed };
  } catch (error) {
    return {
      note: ` Plan tracking skipped: ${error instanceof Error ? error.message : String(error)}.`,
      committed: false,
    };
  }
}

export interface UntrackIssueResult {
  files: string[];
  committed: boolean;
}

/**
 * Remove an issue's tracking lines from every plans/*.md file that mentions
 * it, committing each touched file on main. Never throws.
 */
export async function untrackIssueInPlans(repoRoot: string, number: number): Promise<UntrackIssueResult> {
  const touched: string[] = [];
  try {
    for (const planFile of findPlanFiles(repoRoot)) {
      const abs = withinRepo(repoRoot, planFile);
      if (!abs || !existsSync(abs)) continue;
      let current: string;
      try {
        current = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!issuePattern(number).test(current)) continue;
      removePlanTracking(repoRoot, planFile, number);
      touched.push(planFile);
    }
    let committed = false;
    for (const planFile of touched) {
      const done = await commitPlanFile(repoRoot, planFile, `plans: untrack closed #${number} in ${planFile}`);
      committed = committed || done.committed;
    }
    return { files: touched, committed };
  } catch {
    return { files: touched, committed: false };
  }
}
