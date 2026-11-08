/**
 * machine_code — issue lifecycle tasks: move statuses, plan batch waves,
 * approve (merge + done), delete.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { runProc } from "../proc.js";
import { branchExists, defaultBaseBranch, mainWorktreeRoot, removeWorktree } from "../worktree.js";
import { listRuns, RunRecorder, type RunSummary } from "../state/runs.js";
import { findIssue, listIssues, moveIssue, writeIssue, type Issue, type IssueKind, type IssueStatus, parseKind, legalStatus, ISSUE_KINDS, statusesForKind } from "../plan/issues.js";
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

export function planIssueWaves(layout: Layout, maxParallel: number): string[][] {
  const issues = listIssues(layout).filter((issue) => issue.kind !== "ideas" && issue.status === "todo");
  const done = new Set(
    listIssues(layout)
      .filter((issue) => issue.status === "done")
      .map((issue) => issue.slug),
  );
  const pending = new Map(issues.map((issue) => [issue.slug, issue] as const));
  const waves: string[][] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((issue) => issue.depends.every((dep) => done.has(dep)))
      .sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
          a.slug.localeCompare(b.slug),
      )
      .slice(0, maxParallel);
    if (ready.length === 0) break;
    waves.push(ready.map((issue) => issue.slug));
    for (const issue of ready) {
      done.add(issue.slug);
      pending.delete(issue.slug);
    }
  }
  return waves;
}

/** Approve: merge the issue's branch and move it to done/. */
export async function approveIssue(layout: Layout, slug: string): Promise<void> {
  const issue = findIssue(layout, slug);
  if (!issue) throw new Error(`no issue ${slug}`);
  const root = await mainRoot(layout);
  const baseBranch = await defaultBaseBranch(root);
  // New builds use mc/<slug>; older runs used mc/run/<id>. Fall back to the
  // newest engineer worktree branch so those runs remain approvable.
  let branch = `mc/${slug}`;
  if (!(await branchExists(root, branch))) {
    const legacy = issueRuns(layout, slug).find(
      (run) => (run.agent === "engineer" || run.agent === "build") && run.worktree && typeof run.branch === "string",
    );
    if (!legacy?.branch) throw new Error(`no branch ${branch} to approve`);
    branch = legacy.branch;
  }
  const isAncestor = (await git(root, ["merge-base", "--is-ancestor", branch, baseBranch])).code === 0;
  if (!isAncestor) {
    const merge = await git(root, ["merge", "--no-ff", branch, "-m", `Merge ${branch} (${slug})`]);
    if (merge.code !== 0) {
      throw new Error(`merge of ${branch} into ${baseBranch} failed: ${merge.stderr.trim()}; resolve it manually`);
    }
  }
  moveIssue(layout, slug, "done");
  await commitIssues(layout, `issues: complete ${slug}`);
}

/** Delete an issue file, branch, and worktree. */
export async function deleteIssue(layout: Layout, slug: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = await mainRoot(layout);
  const issue = findIssue(layout, slug);
  if (issue) rmSync(issue.path, { force: true });
  const branches = new Set<string>([`mc/${slug}`]);
  for (const run of issueRuns(layout, slug)) {
    if ((run.agent === "engineer" || run.agent === "build") && typeof run.branch === "string") branches.add(run.branch);
  }
  const flag = opts.force ? "-D" : "-d";
  for (const branch of branches) {
    if (await branchExists(root, branch)) {
      await git(root, ["branch", flag, branch]).catch(() => undefined);
    }
  }
  await commitIssues(layout, `issues: delete ${slug}`);
}

export { parseKind, legalStatus };
