/**
 * machine_code — issue lifecycle tasks: move statuses, plan batch waves,
 * approve (merge + done), delete.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { runProc } from "../proc.js";
import { branchCheckedOutAt, branchExists, branchState, defaultBaseBranch, mainWorktreeRoot, removeWorktree, withMergeLock, type BranchState } from "../worktree.js";
import { listRuns, reconcileRun, RunRecorder, type RunSummary } from "../state/runs.js";
import { findIssue, listIssues, moveIssue, writeIssue, type Issue, type IssueKind, type IssueStatus, parseKind, legalStatus, ISSUE_KINDS, statusesForKind } from "../plan/issues.js";
import { overlapFootprints } from "../plan/overlap.js";
import { runItemId } from "../plan/lifecycle.js";
import { runMainBuild } from "../commands/build.js";
import { syncWorktreeWithMain } from "./sync.js";
import { slugify } from "../plan/slug.js";
import type { TaskPacket } from "../packet.js";

function mainRoot(layout: Layout): Promise<string> {
  return mainWorktreeRoot(layout.repoRoot);
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runProc("git", args, { cwd, timeoutMs: 120000 });
  return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Latest engine run for a slug. */
export function issueRuns(layout: Layout, slug: string): RunSummary[] {
  return listRuns(layout).filter((run) => run.itemId === slug || run.packetId === slug);
}

/** The runner's task view of one issue: goal + declared gates. */
export function issueToTaskPacket(issue: Issue): TaskPacket {
  return {
    id: issue.slug,
    goal: issue.prompt.trim() || issue.title || issue.slug,
    context: [],
    constraints: issue.tags.map((tag) => `tag: ${tag}`),
    acceptance: issue.verify.map((command) => ({ command })),
    verification: issue.verification,
    ...(issue.keywords.length > 0 ? { keywords: [...issue.keywords] } : {}),
  };
}

async function commitIssues(layout: Layout, message: string): Promise<void> {
  const root = await mainRoot(layout);
  await git(root, ["add", "issues"]);
  await git(root, ["commit", "-qm", message]).catch(() => undefined);
}

/**
 * Bulild waves: issues in ready/ with all deps satisfied.
 */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Depends slugs that are not done. Empty = clear to build. Enforced at
 * build/run start so same-file sequences actually serialize: the dependent
 * issue always builds on the dependency's merged result instead of racing it
 * and conflicting at merge time. Unknown slugs are ignored here (a renamed or
 * deleted dependency must not block work forever); callers surface them as a
 * warning via `unknownDepends`. */
export function unmetDepends(layout: Layout, issue: Issue): string[] {
  const issues = listIssues(layout);
  // A dependency is satisfied when its work has landed (`done`). A researched
  // idea is also satisfied: it is a completed research artifact, not code, so
  // it must never block a build forever.
  const satisfied = new Set(
    issues
      .filter((candidate) => candidate.status === "done" || (candidate.kind === "ideas" && candidate.status === "researched"))
      .map((candidate) => candidate.slug),
  );
  const known = new Set(issues.map((candidate) => candidate.slug));
  return issue.depends.filter((dep) => dep !== issue.slug && known.has(dep) && !satisfied.has(dep));
}

/** Depends slugs that do not name any issue (typo, rename, deletion). */
export function unknownDepends(layout: Layout, issue: Issue): string[] {
  const known = new Set(listIssues(layout).map((candidate) => candidate.slug));
  return issue.depends.filter((dep) => dep !== issue.slug && !known.has(dep));
}

export interface ActiveFileConflict {
  /** The other issue whose footprint overlaps. */
  slug: string;
  /** The active run working that issue. */
  runId: string;
  /** Overlapping footprints (human-readable). */
  files: string[];
}

/**
 * Issues currently being worked by another live run that declare an
 * overlapping file footprint. `depends:` sequences issues that are queued
 * together; this catches the case where they were queued without the edge
 * and would otherwise edit the same files concurrently.
 */
export function activeFileConflicts(layout: Layout, issue: Issue): ActiveFileConflict[] {
  if (issue.files.length === 0) return [];
  const active = listRuns(layout).filter(
    (run) =>
      runItemId(run) !== undefined &&
      runItemId(run) !== issue.slug &&
      ["created", "running", "awaiting_input"].includes(run.status) &&
      ["created", "running", "awaiting_input"].includes(reconcileRun(run).status),
  );
  const conflicts: ActiveFileConflict[] = [];
  for (const run of active) {
    const other = findIssue(layout, runItemId(run)!);
    if (!other || other.files.length === 0) continue;
    const files = overlapFootprints(issue.files, other.files);
    if (files.length > 0) conflicts.push({ slug: other.slug, runId: run.id, files });
  }
  return conflicts;
}

export function planIssueWaves(layout: Layout, maxParallel: number): string[][] {
  const issues = listIssues(layout).filter((issue) => issue.kind !== "ideas" && issue.status === "todo");
  const all = listIssues(layout);
  const satisfied = new Set(
    all
      .filter((issue) => issue.status === "done" || (issue.kind === "ideas" && issue.status === "researched"))
      .map((issue) => issue.slug),
  );
  const known = new Set(all.map((issue) => issue.slug));
  const pending = new Map(issues.map((issue) => [issue.slug, issue] as const));
  const waves: string[][] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()]
      // Unknown dependencies are ignored, matching unmetDepends: a stale slug
      // must not stall the whole wave forever.
      .filter((issue) => issue.depends.every((dep) => dep === issue.slug || !known.has(dep) || satisfied.has(dep)))
      .sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
          a.slug.localeCompare(b.slug),
      )
      .slice(0, maxParallel);
    if (ready.length === 0) break;
    waves.push(ready.map((issue) => issue.slug));
    for (const issue of ready) {
      satisfied.add(issue.slug);
      pending.delete(issue.slug);
    }
  }
  return waves;
}

/** The issue's durable feature branch, or a legacy run branch.
 * Null when neither exists. */
export async function issueBranch(root: string, layout: Layout, slug: string): Promise<string | null> {
  const issue = findIssue(layout, slug);
  if (issue && (await branchExists(root, issue.branch))) return issue.branch;
  // Legacy `mc/<slug>` branch from before per-issue ids.
  if (await branchExists(root, `mc/${slug}`)) return `mc/${slug}`;
  const legacy = issueRuns(layout, slug).find(
    (run) => (run.agent === "engineer" || run.agent === "build") && run.worktree && typeof run.branch === "string",
  );
  return legacy?.branch ?? null;
}

/** Branch state of an issue: which branch its work lives on and whether that
 * branch carries changes relative to the base branch. Powers approve gating
 * in the CLI and the branch status line on the issue screen. */
export interface IssueBranchState {
  /** Feature branch holding the issue's work. */
  branch: string;
  /** Commit state of the branch relative to the base branch. */
  state: BranchState;
}

export async function issueBranchState(layout: Layout, slug: string): Promise<IssueBranchState> {
  const root = await mainRoot(layout);
  const issue = findIssue(layout, slug);
  const branch = (await issueBranch(root, layout, slug)) ?? issue?.branch ?? `mc/${slug}`;
  const baseBranch = await defaultBaseBranch(root);
  return { branch, state: await branchState(root, branch, baseBranch) };
}

/** True when approve has something to act on: unmerged commits, or commits
 * already merged (approve then only finalizes the issue). */
export function isApprovable(issue: IssueBranchState): boolean {
  return issue.state.code === "ahead" || issue.state.code === "merged";
}

/** Approve: merge the issue's branch and move it to done/. */
export async function approveIssue(layout: Layout, slug: string): Promise<void> {
  const issue = findIssue(layout, slug);
  if (!issue) throw new Error(`no issue ${slug}`);
  if (issue.status !== "needs-human-review" && issue.status !== "done") {
    throw new Error(`issue ${slug} is ${issue.status}; approve requires needs-human-review`);
  }
  const root = await mainRoot(layout);
  const baseBranch = await defaultBaseBranch(root);
  const branch = await issueBranch(root, layout, slug);
  if (!branch) throw new Error(`no branch for ${slug} to approve`);
  // Only approve built work: a branch identical to base has nothing to merge,
  // and an already-merged branch only needs the status move below.
  const state = await branchState(root, branch, baseBranch);
  if (state.code === "unchanged") {
    throw new Error(`branch ${branch} has no changes to approve`);
  }
  if (state.code === "ahead") {
    await withMergeLock(root, async () => {
      // Sync the feature branch with main first, exactly like the run's
      // acceptance gate. If main moved after the run, this is where the
      // conflict surfaces; approval has no agent to resolve it, so abort and
      // send the issue back for a run instead of poisoning the worktree.
      const worktree = await branchCheckedOutAt(root, branch);
      if (worktree) {
        const sync = await syncWorktreeWithMain(worktree, { abortOnConflict: true });
        if (!sync.ok) {
          throw new Error(
            `sync of ${branch} with main failed: ${sync.detail}; re-run the issue so the agent can resolve it`,
          );
        }
      }
      const merge = await git(root, ["merge", "--no-ff", branch, "-m", `Merge ${branch} (${slug})`]);
      if (merge.code !== 0) {
        throw new Error(`merge of ${branch} into ${baseBranch} failed: ${merge.stderr.trim()}; resolve it manually`);
      }
    });
  }
  const build = await runMainBuild(root);
  if (!build.ok) {
    throw new Error(`merge succeeded but main build failed: ${build.text}`);
  }
  moveIssue(layout, slug, "done");
  await commitIssues(layout, `[COMPLETE] ${slug}`);
}

/** Delete an issue file, branch, and worktree. */
export async function deleteIssue(layout: Layout, slug: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = await mainRoot(layout);
  const issue = findIssue(layout, slug);
  if (issue) rmSync(issue.path, { force: true });
  const branches = new Set<string>([issue?.branch ?? `mc/${slug}`]);
  for (const run of issueRuns(layout, slug)) {
    if ((run.agent === "engineer" || run.agent === "build") && typeof run.branch === "string") branches.add(run.branch);
  }
  const flag = opts.force ? "-D" : "-d";
  for (const branch of branches) {
    if (await branchExists(root, branch)) {
      await git(root, ["branch", flag, branch]).catch(() => undefined);
    }
  }
  await commitIssues(layout, `[DELETE] ${slug}`);
}

export { parseKind, legalStatus };
