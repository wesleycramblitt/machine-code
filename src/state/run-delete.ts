/**
 * machine_code — delete one run and its owned resources.
 *
 * The run directory is the durable evidence. Deleting it is explicit. The
 * worktree and branch are removed only when no other run shares them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Layout } from "../paths.js";
import type { RunSummary } from "./runs.js";
import { listRuns } from "./runs.js";
import { isActiveStatus } from "./run-schema.js";
import { removeWorktree } from "../worktree.js";
import { runProc } from "../proc.js";

export interface DeleteRunInput {
  layout: Layout;
  run: RunSummary;
  deleteWorktree?: boolean;
  deleteBranch?: boolean;
  force?: boolean;
}

export interface DeleteRunResult {
  runId: string;
  removedWorktree: boolean;
  deletedBranch: boolean;
  warnings: string[];
}

function ownerRunId(layout: Layout, run: RunSummary): string | undefined {
  if (!run.worktree) return run.worktreeOwnerRunId;
  const owner = listRuns(layout).find(
    (candidate) => candidate.worktree === run.worktree && join(layout.localDir, "worktrees", candidate.id) === run.worktree,
  );
  return owner?.id ?? run.worktreeOwnerRunId ?? (join(layout.localDir, "worktrees", run.id) === run.worktree ? run.id : undefined);
}

async function deleteBranch(layout: Layout, branch: string, result: DeleteRunResult): Promise<void> {
  if (!branch.startsWith("mc/")) return;
  await runProc("git", ["branch", "-D", branch], { cwd: layout.repoRoot, timeoutMs: 30_000 });
  const remote = await runProc("git", ["push", "origin", "--delete", branch], {
    cwd: layout.repoRoot,
    timeoutMs: 120_000,
  });
  if (remote.code !== 0 && !/remote ref does not exist|not found/i.test(remote.stderr)) {
    result.warnings.push(`remote branch ${branch}: ${remote.stderr.trim() || `exit ${remote.code}`}`);
  } else {
    result.deletedBranch = true;
  }
}

export async function deleteRun(input: DeleteRunInput): Promise<DeleteRunResult> {
  const { layout, run } = input;
  if (isActiveStatus(run.status)) {
    throw new Error(`run ${run.id} is ${run.status}; cancel or finish it before deleting`);
  }
  const others = listRuns(layout).filter((candidate) => candidate.id !== run.id);
  const result: DeleteRunResult = {
    runId: run.id,
    removedWorktree: false,
    deletedBranch: false,
    warnings: [],
  };

  const branchShared = Boolean(run.branch && others.some((candidate) => candidate.branch === run.branch));
  const branchBlocked = branchShared || (run.prState === "open" && !input.force);
  if (input.deleteWorktree !== false && run.worktree && existsSync(run.worktree)) {
    const shared = others.some((candidate) => candidate.worktree === run.worktree);
    if (shared) {
      result.warnings.push(`worktree ${run.worktree} is shared with another run; kept it`);
    } else {
      const owner = ownerRunId(layout, run);
      if (!owner) {
        result.warnings.push(`worktree ${run.worktree}: owner run not found`);
      } else {
        try {
          const removeBranch = input.deleteBranch !== false && !branchBlocked;
          await removeWorktree({
            layout,
            runId: owner,
            force: true,
            deleteBranch: removeBranch,
          });
          result.removedWorktree = true;
          result.deletedBranch = removeBranch && Boolean(run.branch);
        } catch (error) {
          result.warnings.push(`worktree ${run.worktree}: ${(error as Error).message}`);
        }
      }
    }
  }

  if (input.deleteBranch !== false && run.branch && !result.deletedBranch) {
    if (branchShared) {
      result.warnings.push(`branch ${run.branch} is used by another run; kept it`);
    } else if (run.prState === "open" && !input.force) {
      result.warnings.push(`branch ${run.branch} has an open PR; kept it (use --force to delete)`);
    } else {
      await deleteBranch(layout, run.branch, result);
    }
  }

  rmSync(join(layout.runsDir, run.id), { recursive: true, force: true });
  return result;
}
