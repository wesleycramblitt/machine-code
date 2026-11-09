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
import { mainWorktreeRoot } from "../worktree.js";

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

export async function commitPlanningFiles(layout: Layout, message: string): Promise<boolean> {
  try {
    const root = await mainRoot(layout);
    const dirs = ["issues", "knowledge"].filter((dir) => existsSync(join(root, dir)));
    if (dirs.length === 0) return false;
    await git(root, ["add", "-A", "--", ...dirs]);
    const status = await git(root, ["status", "--porcelain", "--", ...dirs]);
    if (status.stdout.trim() === "") return false;
    let commit = await git(root, ["commit", "-m", message], 60_000);
    if (commit.code !== 0) {
      commit = await git(
        root,
        ["-c", "user.name=machine_code", "-c", "user.email=machine_code@localhost", "commit", "-m", message],
        60_000,
      );
    }
    return commit.code === 0;
  } catch {
    return false;
  }
}
