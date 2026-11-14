/**
 * machine_code — sync a worktree branch with the base branch.
 *
 * Kept separate from the final merge so the agent-facing conflict commands can
 * import it without pulling in the command registry (which imports them).
 */
import { runProc } from "../proc.js";
import { defaultBaseBranch } from "../worktree.js";

export type GitResult = Awaited<ReturnType<typeof runProc>>;

export async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  // Never prompt for credentials: fail fast instead of hanging until timeout.
  return runProc("git", args, { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
}

export function ok(result: GitResult): boolean {
  return result.outcome === "exit" && result.code === 0;
}

export function firstLine(text: string): string {
  return text.trim().split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return ok(await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]));
}

/** Line-start conflict markers (`<<<<<<<`, `>>>>>>>`) in tracked files.
 * After `git add`, a still-marked file is staged and no longer shows as
 * unmerged (`-U`), so the merge would otherwise commit markers as resolved.
 * `=======` alone is too common in legit content to scan for. */
export async function stagedConflictMarkers(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["grep", "-l", "-e", "^<<<<<<< ", "-e", "^>>>>>>> ", "--", "."], 30_000);
  if (!ok(result)) return [];
  return result.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function mergeInProgress(cwd: string): Promise<boolean> {
  return ok(await git(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]));
}

/** Files with unresolved merge conflicts in `cwd` (empty when clean). */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["diff", "--name-only", "--diff-filter=U"], 15_000);
  if (!ok(result)) return [];
  return result.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function abortMerge(cwd: string): Promise<void> {
  await git(cwd, ["merge", "--abort"], 15_000);
}

/** Abort a merge left in progress by a failed run. A conflicted worktree
 * poisons every later reuse, so terminal failures always clean it up. */
export async function abortMergeIfInProgress(cwd: string): Promise<boolean> {
  if (!(await mergeInProgress(cwd))) return false;
  await abortMerge(cwd);
  return true;
}

/** Bring local main up to origin/main (fast-forward only, never throws).
 * Plain `git fetch origin main:main` is refused when main is checked out
 * (which it always is in the main worktree), so fetch the remote ref and
 * fast-forward explicitly. Refuses when HEAD is not on the base branch or
 * the tree is dirty; a real divergence is reported, never forced. */
export async function fastForwardMain(
  mainRoot: string,
  baseBranch?: string,
): Promise<{ ok: boolean; detail: string }> {
  const base = baseBranch?.trim() || "main";
  const head = await git(mainRoot, ["rev-parse", "--abbrev-ref", "HEAD"], 15_000);
  if (!ok(head) || head.stdout.trim() !== base) {
    return { ok: false, detail: `main worktree is on ${ok(head) ? head.stdout.trim() : "(unknown)"}, not ${base}; leaving it alone` };
  }
  const fetch = await git(mainRoot, ["fetch", "origin"], 60_000);
  if (!ok(fetch)) {
    return { ok: true, detail: "offline: keeping local main" };
  }
  if (!(await refExists(mainRoot, `origin/${base}`))) {
    return { ok: true, detail: `no origin/${base} to sync` };
  }
  const ff = await git(mainRoot, ["merge", "--ff-only", `origin/${base}`], 60_000);
  if (ok(ff)) {
    const msg = ff.stdout.trim() || ff.stderr.trim();
    return {
      ok: true,
      detail: /already up to date/i.test(`${ff.stdout}\n${ff.stderr}`) ? "already up to date" : `fast-forwarded (${msg.slice(0, 120)})`,
    };
  }
  const dirty = await git(mainRoot, ["status", "--porcelain"], 15_000);
  if (ok(dirty) && dirty.stdout.trim() !== "") {
    return { ok: false, detail: `cannot fast-forward ${base}: worktree is dirty (commit or clean it first)` };
  }
  return {
    ok: false,
    detail: `local ${base} has diverged from origin/${base}; not forcing: ${firstLine(ff.stderr) || firstLine(ff.stdout)}`,
  };
}

export interface SyncResult {
  ok: boolean;
  detail: string;
  /** Unresolved paths when `ok` is false because of content conflicts. */
  conflicts: string[];
}

/**
 * Merge the base branch (`origin/main`) into the worktree's current branch.
 *
 * - No-op when the branch already contains the base.
 * - Commits uncommitted work as a checkpoint before merging, so a dirty
 *   worktree never blocks the sync.
 * - On conflict, leaves the merge in progress and returns the conflicted
 *   paths. The run's gate loop hands those to the agent, which resolves them
 *   and calls `finish` again; the next sync commits the merge.
 * - `abortOnConflict` restores the pre-merge state instead (approval path,
 *   where no agent is available to resolve).
 */
export async function syncWorktreeWithMain(
  cwd: string,
  options: { fetch?: boolean; abortOnConflict?: boolean; baseBranch?: string } = {},
): Promise<SyncResult> {
  const baseBranch = options.baseBranch?.trim() || (await defaultBaseBranch(cwd));
  if (options.fetch !== false) {
    // Best effort: offline work must still be able to sync against the last
    // known remote-tracking ref, or the local base branch.
    await git(cwd, ["fetch", "origin"], 60_000);
  }
  let baseRef = `origin/${baseBranch}`;
  if (!(await refExists(cwd, baseRef))) baseRef = baseBranch;
  if (!(await refExists(cwd, baseRef))) {
    return { ok: true, detail: `no ${baseBranch} ref to sync`, conflicts: [] };
  }

  // A previous gate attempt left a merge in progress: finish it if the agent
  // resolved every path, otherwise keep handing the same conflict back.
  if (await mergeInProgress(cwd)) {
    const files = await conflictedFiles(cwd);
    if (files.length > 0) {
      if (options.abortOnConflict) await abortMerge(cwd);
      return { ok: false, detail: `unresolved conflicts in: ${files.join(", ")}`, conflicts: files };
    }
    // No unmerged paths does NOT mean resolved: staged files may still
    // carry markers the agent forgot to edit out. Committing those would
    // bake conflicts into the branch, so hand them back instead.
    const marked = await stagedConflictMarkers(cwd);
    if (marked.length > 0) {
      if (options.abortOnConflict) await abortMerge(cwd);
      return {
        ok: false,
        detail: `staged files still contain conflict markers: ${marked.join(", ")} — finish editing every side, then vcs:resolve each path again`,
        conflicts: marked,
      };
    }
    const add = await git(cwd, ["add", "-A"]);
    if (!ok(add)) {
      return { ok: false, detail: `failed to stage resolved files: ${firstLine(add.stderr)}`, conflicts: [] };
    }
    const commit = await git(cwd, ["commit", "--no-edit"], 60_000);
    if (!ok(commit)) {
      // Nothing to commit means the merge was already concluded elsewhere.
      if (!(await mergeInProgress(cwd))) {
        return { ok: true, detail: "merge already completed", conflicts: [] };
      }
      return { ok: false, detail: `failed to complete merge: ${firstLine(commit.stderr)}`, conflicts: [] };
    }
    return { ok: true, detail: "resolved merge committed", conflicts: [] };
  }

  const contains = await git(cwd, ["merge-base", "--is-ancestor", baseRef, "HEAD"]);
  if (ok(contains)) {
    return { ok: true, detail: `already up to date with ${baseRef}`, conflicts: [] };
  }

  // A dirty worktree makes `git merge` refuse when main touches the same
  // files. Checkpoint it first so the sync (and the following build gate)
  // runs on a committed tree. `ensureCommitted` later accepts that commit.
  const status = await git(cwd, ["status", "--porcelain"]);
  if (ok(status) && status.stdout.trim() !== "") {
    await git(cwd, ["add", "-A"]);
    const commit = await git(cwd, ["commit", "-m", `checkpoint before syncing ${baseBranch}`], 60_000);
    if (!ok(commit)) {
      return { ok: false, detail: `could not checkpoint uncommitted work: ${firstLine(commit.stderr)}`, conflicts: [] };
    }
  }

  const branchResult = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.stdout.trim() || "work";
  const message = `sync ${branch} with ${baseBranch}`;

  let merge = await git(cwd, ["merge", baseRef, "-m", message], 120_000);
  if (ok(merge)) return { ok: true, detail: `merged ${baseRef}`, conflicts: [] };

  let files = await conflictedFiles(cwd);
  if (files.length > 0) {
    // Whitespace-only / moved-code conflicts are routine. Retry with a
    // tolerant diff before asking the model to resolve anything.
    await abortMerge(cwd);
    merge = await git(
      cwd,
      ["merge", "-X", "patience", "-X", "ignore-all-space", baseRef, "-m", message],
      120_000,
    );
    if (ok(merge)) return { ok: true, detail: `merged ${baseRef} (patience)`, conflicts: [] };
    files = [...new Set([...files, ...(await conflictedFiles(cwd))])];
    if (options.abortOnConflict) await abortMerge(cwd);
    return { ok: false, detail: `conflicts in: ${files.join(", ")}`, conflicts: files };
  }

  return {
    ok: false,
    detail: `merge of ${baseRef} failed: ${firstLine(merge.stderr) || firstLine(merge.stdout)}`,
    conflicts: [],
  };
}

/** Best-effort push of the worktree's current branch to origin.
 * Never throws: offline or unconfigured remotes must not fail a run. */
export async function pushFeatureBranch(cwd: string, branch: string): Promise<boolean> {
  try {
    const result = await git(cwd, ["push", "-u", "origin", `${branch}:${branch}`], 60_000);
    return ok(result);
  } catch {
    return false;
  }
}
