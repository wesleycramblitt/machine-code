/**
 * machine_code — final branch merge.
 *
 * The feature branch is synced with the base branch *before* the build gate
 * (see `tasks/sync.ts` and the runner-owned `vcs:sync` gate) and merged into
 * the base branch only after every gate passes. Conflicts surface in the
 * worktree, where the same run can resolve them, instead of on main at the end.
 */
import { runProc } from "../proc.js";
import { runMainBuild } from "../commands/build.js";
import { commitWorktree, defaultBaseBranch, withMergeLock } from "../worktree.js";
import { abortMerge, conflictedFiles, syncWorktreeWithMain } from "./sync.js";

export { abortMergeIfInProgress } from "./sync.js";

type GitResult = Awaited<ReturnType<typeof runProc>>;

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return runProc("git", args, { cwd, timeoutMs });
}

function ok(result: GitResult): boolean {
  return result.outcome === "exit" && result.code === 0;
}

function firstLine(text: string): string {
  return text.trim().split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** Commits dirty work, or accepts an existing commit on the branch. */
export async function ensureCommitted(
  path: string,
  baseRef: string | undefined,
  message: string,
): Promise<string | null> {
  const committed = await commitWorktree({ path, message });
  if (committed.sha) return committed.sha;
  // Compare against the *current* base branch, not the run's start ref:
  // the sync gate fast-forwards main into the branch, and those commits are
  // not the agent's work. `origin/main..HEAD` is empty for a no-op run.
  const baseBranch = await defaultBaseBranch(path);
  const refExists = async (ref: string): Promise<boolean> => {
    const result = await runProc("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: path, timeoutMs: 15_000 });
    return result.outcome === "exit" && result.code === 0;
  };
  let base = `origin/${baseBranch}`;
  if (!(await refExists(base))) base = baseBranch;
  if (!(await refExists(base))) base = baseRef ?? baseBranch;
  const ahead = await runProc("git", ["rev-list", "--count", `${base}..HEAD`], {
    cwd: path,
    timeoutMs: 30_000,
  });
  if (ahead.outcome !== "exit" || ahead.code !== 0) return null;
  if ((Number(ahead.stdout.trim()) || 0) === 0) return null;
  const head = await runProc("git", ["rev-parse", "HEAD"], { cwd: path, timeoutMs: 30_000 });
  return head.stdout.trim() || null;
}

/**
 * Merge a feature branch into the base branch and push. The branch is synced
 * with upstream first (normally a no-op because the sync gate already did it),
 * then merged, rebuilt, and pushed under a per-repo merge lock so parallel
 * runs finish one after another instead of racing each other's push.
 */
export async function mergeBranchIntoMain(
  topRoot: string,
  worktreeRoot: string,
  branch: string,
): Promise<{ ok: boolean; detail?: string; mergeCommit?: string }> {
  return withMergeLock(topRoot, async () => {
    let failure: string | undefined;
    const step = async (args: string[], cwd: string, what: string): Promise<boolean> => {
      const result = await git(cwd, args);
      if (ok(result)) return true;
      // Git reports merge conflicts on stdout ("CONFLICT ..."), not stderr,
      // so a stderr-only message renders as an opaque "exit 1".
      const lines = [...result.stdout.split("\n"), ...result.stderr.split("\n")].map((line) => line.trim()).filter(Boolean);
      const conflicts = lines.filter((line) => /conflict/i.test(line)).slice(0, 5);
      const first = conflicts.length > 0 ? conflicts.join("; ") : firstLine(result.stderr);
      const desc = `${what} failed (${result.outcome}${result.code === null ? "" : ` exit ${result.code}`})${first ? `: ${first}` : ""}`;
      process.stderr.write(`merge ${branch}: ${desc}\n`);
      if (!failure) failure = desc;
      return false;
    };
    const fail = (detail?: string): { ok: boolean; detail?: string } => ({ ok: false, detail: detail ?? failure });
    const pushRace = (out: GitResult): boolean =>
      /non-fast-forward|fetch first|stale info|rejected/i.test(`${out.stdout}\n${out.stderr}`);
    try {
      // Retry loop for push races: another merger may land between our merge
      // and our push. Content conflicts fail immediately (retrying cannot
      // help); only a rejected push loops back to fetch and merge again.
      for (let attempt = 1; ; attempt += 1) {
        await step(["fetch", "origin"], topRoot, "fetch");
        const sync = await syncWorktreeWithMain(worktreeRoot, { fetch: false, abortOnConflict: true });
        if (!sync.ok) {
          return fail(
            `sync conflicts in: ${sync.conflicts.length > 0 ? sync.conflicts.join(", ") : sync.detail} — ` +
              `re-run the issue so the agent can resolve them; the branch keeps all committed work`,
          );
        }
        if (!(await step(["merge", branch, "--no-ff", "-m", `merge ${branch}`], topRoot, "merge"))) {
          const files = await conflictedFiles(topRoot);
          if (files.length > 0) failure = `conflicts in: ${files.join(", ")}`;
          await abortMerge(topRoot);
          return fail();
        }
        // A source merge is not a working binary for a compiled project.
        const build = await runMainBuild(topRoot);
        if (!build.ok) {
          process.stderr.write(`main build failed after merge: ${build.text}\n`);
          return fail(`main build failed after merge: ${build.text}`);
        }
        const push = await git(topRoot, ["push", "origin", "main"]);
        if (ok(push)) break;
        const pushErr = `${firstLine(push.stderr)} (${push.outcome}${push.code === null ? "" : ` exit ${push.code}`})`;
        if (attempt >= 3 || !pushRace(push)) return fail(`push failed: ${pushErr}`);
        process.stderr.write(`merge ${branch}: push lost a race with another merger, retrying (${attempt}/3)\n`);
      }
      // Local main is the merge commit and the push just landed it, but
      // verify origin agrees: a concurrent push landing between our push
      // and this check means we are behind again. Loud, never fatal here —
      // the next run's pre-run sync fast-forwards.
      await git(topRoot, ["fetch", "origin"], 60_000);
      const headCheck = await git(topRoot, ["rev-parse", "HEAD"], 15_000);
      const originCheck = await git(topRoot, ["rev-parse", "--verify", "origin/main"], 15_000);
      if (
        ok(headCheck) && ok(originCheck) &&
        headCheck.stdout.trim() !== originCheck.stdout.trim()
      ) {
        process.stderr.write(
          `merge ${branch}: pushed ${headCheck.stdout.trim().slice(0, 12)} but origin/main is ${originCheck.stdout.trim().slice(0, 12)} (another merger landed after); next run syncs\n`,
        );
      }
      // Delete the remote branch (may fail if it was never pushed — fine).
      await git(topRoot, ["push", "origin", "--delete", branch], 15_000);
      // The worktree checks the branch out, so remove it before deleting.
      if (!(await step(["worktree", "remove", worktreeRoot], topRoot, "worktree remove"))) return fail();
      if (!(await step(["branch", "-D", branch], topRoot, "branch -D"))) return fail();
      const head = await git(topRoot, ["rev-parse", "HEAD"], 15_000);
      const mergeCommit = ok(head) ? head.stdout.trim() || undefined : undefined;
      return { ok: true, mergeCommit };
    } catch (error) {
      const detail = `merge ${branch} failed: ${(error as Error).message}`;
      process.stderr.write(`${detail}\n`);
      return fail(detail);
    }
  });
}
