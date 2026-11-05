/**
 * machine_code — destructive Task/Feature cleanup.
 *
 * Deleting an issue also closes its open PRs, removes its worktrees, and
 * deletes the associated local and remote branches. Parent issues require an
 * explicit cascade so a typo cannot delete a whole Feature or Epic.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { MachineConfig } from "../config.js";
import type { Issue, IssueProvider } from "../issues/provider.js";
import { listRuns, readRun, RunRecorder } from "../state/runs.js";
import { isActiveStatus } from "../state/run-schema.js";
import { removeWorktree } from "../worktree.js";
import { createPrProviderFor } from "../pr/factory.js";
import type { PullRequestProvider } from "../pr/provider.js";
import { runProc } from "../proc.js";
import { addTombstones, removeTombstones } from "../issues/cache.js";

export interface DeleteIssueInput {
  layout: Layout;
  machine: MachineConfig;
  provider: IssueProvider;
  issue: Issue;
  cascade?: boolean;
  keepRuns?: boolean;
  prs?: PullRequestProvider;
}

export interface DeleteIssueResult {
  deleted: number[];
  deletedRuns: string[];
  closedPrs: number[];
  removedWorktrees: string[];
  deletedBranches: string[];
  warnings: string[];
}

function assignedTo(run: { issue?: { repo: string; number: number }; taskIssue?: { repo: string; number: number } }, issue: Issue): boolean {
  const ref = run.taskIssue ?? run.issue;
  return Boolean(ref && ref.repo === issue.ref.repo && ref.number === issue.ref.number);
}

async function descendants(provider: IssueProvider, issue: Issue): Promise<Issue[]> {
  const children = await provider.children(issue.ref);
  const out: Issue[] = [];
  for (const child of children) {
    out.push(...(await descendants(provider, child)));
    out.push(child);
  }
  return out;
}

function ownerRunId(layout: Layout, run: { id: string; worktree?: string; worktreeOwnerRunId?: string }): string | undefined {
  if (!run.worktree) return run.worktreeOwnerRunId;
  const owner = listRuns(layout).find(
    (candidate) => candidate.worktree === run.worktree && join(layout.localDir, "worktrees", candidate.id) === run.worktree,
  );
  return owner?.id ?? run.worktreeOwnerRunId ?? (join(layout.localDir, "worktrees", run.id) === run.worktree ? run.id : undefined);
}

async function deleteBranch(layout: Layout, branch: string, result: DeleteIssueResult): Promise<void> {
  if (!branch.startsWith("mc/")) return;
  const local = await runProc("git", ["branch", "-D", branch], {
    cwd: layout.repoRoot,
    timeoutMs: 30_000,
  });
  if (local.code === 0) result.deletedBranches.push(branch);
  const remote = await runProc("git", ["push", "origin", "--delete", branch], {
    cwd: layout.repoRoot,
    timeoutMs: 120_000,
  });
  if (remote.code !== 0 && !/remote ref does not exist|not found/i.test(remote.stderr)) {
    result.warnings.push(`remote branch ${branch}: ${remote.stderr.trim() || `exit ${remote.code}`}`);
  }
}

async function cleanupIssue(
  input: DeleteIssueInput,
  issue: Issue,
  prs: PullRequestProvider,
  result: DeleteIssueResult,
): Promise<void> {
  const runs = listRuns(input.layout).filter((run) => assignedTo(run, issue));
  const prNumbers = [...new Set(runs.map((run) => run.prNumber).filter((n): n is number => typeof n === "number"))];
  for (const number of prNumbers) {
    try {
      const pr = await prs.status(number);
      if (!pr || pr.state !== "open") continue;
      if (!prs.close) {
        result.warnings.push(`PR #${number} is open; provider cannot close it`);
        continue;
      }
      await prs.close(number);
      result.closedPrs.push(number);
      for (const run of runs.filter((candidate) => candidate.prNumber === number)) {
        const detail = readRun(input.layout, run.id);
        if (!detail) continue;
        const recorder = RunRecorder.reopen(input.layout, detail.summary);
        recorder.event("pr_closed", { pr: number, issue: issue.ref.number, by: "delete" });
        recorder.patchSummary({ prState: "closed" });
      }
    } catch (error) {
      result.warnings.push(`PR #${number}: ${(error as Error).message}`);
    }
  }

  const worktrees = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (run.worktree && existsSync(run.worktree) && !worktrees.has(run.worktree)) worktrees.set(run.worktree, run);
  }
  for (const [path, run] of worktrees) {
    const owner = ownerRunId(input.layout, run);
    if (!owner) {
      result.warnings.push(`worktree ${path}: owner run not found`);
      continue;
    }
    try {
      await removeWorktree({ layout: input.layout, runId: owner, force: true, deleteBranch: true });
      result.removedWorktrees.push(path);
    } catch (error) {
      result.warnings.push(`worktree ${path}: ${(error as Error).message}`);
    }
  }

  const branches = new Set<string>();
  if (issue.kind === "task") branches.add(`mc/task/${issue.ref.number}`);
  if (issue.kind === "feature") branches.add(`mc/feature/${issue.ref.number}`);
  for (const run of runs) {
    if (run.branch && (run.branch.startsWith("mc/task/") || run.branch.startsWith("mc/feature/"))) {
      branches.add(run.branch);
    }
  }
  for (const branch of branches) await deleteBranch(input.layout, branch, result);
}

function removeIssueRuns(input: DeleteIssueInput, issue: Issue, result: DeleteIssueResult): void {
  if (input.keepRuns) return;
  for (const run of listRuns(input.layout).filter((candidate) => assignedTo(candidate, issue))) {
    if (isActiveStatus(run.status)) {
      result.warnings.push(`run ${run.id} is ${run.status}; kept it`);
      continue;
    }
    try {
      rmSync(join(input.layout.runsDir, run.id), { recursive: true, force: true });
      result.deletedRuns.push(run.id);
    } catch (error) {
      result.warnings.push(`run ${run.id}: ${(error as Error).message}`);
    }
  }
}

export async function deleteIssue(input: DeleteIssueInput): Promise<DeleteIssueResult> {
  if (input.issue.reserved) throw new Error(`reserved issue #${input.issue.ref.number} cannot be deleted`);
  const children = await input.provider.children(input.issue.ref);
  if (children.length > 0 && !input.cascade) {
    throw new Error(
      `#${input.issue.ref.number} has ${children.length} child issue(s); pass --cascade to delete the whole subtree`,
    );
  }
  if (!input.provider.delete) throw new Error("issue provider does not support deletion");
  const prs = input.prs ?? (await createPrProviderFor(input.layout)).provider;
  const targets = input.cascade ? [...(await descendants(input.provider, input.issue)), input.issue] : [input.issue];
  const targetRefs = targets.map((target) => target.ref);
  addTombstones(input.layout, targetRefs);
  const result: DeleteIssueResult = {
    deleted: [],
    deletedRuns: [],
    closedPrs: [],
    removedWorktrees: [],
    deletedBranches: [],
    warnings: [],
  };
  try {
    for (const issue of targets) {
      await cleanupIssue(input, issue, prs, result);
      await input.provider.delete(issue.ref);
      removeIssueRuns(input, issue, result);
      result.deleted.push(issue.ref.number);
    }
  } catch (error) {
    removeTombstones(input.layout, targetRefs);
    throw error;
  }
  return result;
}
