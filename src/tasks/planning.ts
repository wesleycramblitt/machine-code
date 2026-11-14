/**
 * machine_code — shared planning-tree git helpers.
 *
 * `commitPlanningFiles` stages and commits the durable trees (issues,
 * knowledge) on the main checkout. Best-effort: returns false when there is
 * nothing to commit or git is unavailable, and never throws.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { runProc } from "../proc.js";
import { defaultBaseBranch, mainWorktreeRoot } from "../worktree.js";

async function mainRoot(layout: Layout): Promise<string> {
  try {
    return await mainWorktreeRoot(layout.repoRoot);
  } catch {
    return layout.repoRoot;
  }
}

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runProc("git", args, { cwd, timeoutMs });
}

export async function commitPlanningFiles(
  layout: Layout,
  message: string,
  push = false,
): Promise<boolean> {
  try {
    const root = await mainRoot(layout);
    const base = await defaultBaseBranch(root).catch(() => "main");
    const dirs = ["issues", "knowledge"].filter((dir) => existsSync(join(root, dir)));
    if (dirs.length === 0) return false;
    await git(root, ["add", "-A", "--", ...dirs]);
    const status = await git(root, ["status", "--porcelain", "--", ...dirs]);
    if (status.stdout.trim() === "") {
      // Nothing new to commit; still catch main up with the remote for a push.
      if (push) await git(root, ["push", "origin", base], 30_000);
      return false;
    }
    let commit = await git(root, ["commit", "-m", message], 60_000);
    if (commit.code !== 0) {
      commit = await git(
        root,
        ["-c", "user.name=machine_code", "-c", "user.email=machine_code@localhost", "commit", "-m", message],
        60_000,
      );
    }
    // Only push when asked (a planned manual-prompt run). Best-effort: a push
    // failure leaves the commit locally, which the post-run merge still needs
    // (it fetches first, so the stranded commit rides along). Loud, so a
    // reader of origin doesn't wonder where it went.
    if (push && commit.code === 0) {
      const pushed = await git(root, ["push", "origin", base], 60_000);
      if (pushed.code !== 0) {
        process.stderr.write(`planning push failed (commit is local): ${pushed.stderr.trim().split("\n")[0] ?? ""}\n`);
      }
    }
    return commit.code === 0;
  } catch {
    return false;
  }
}
