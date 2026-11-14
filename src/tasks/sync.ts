/**
 * machine_code — sync a worktree branch with the base branch.
 *
 * Kept separate from the final merge so the agent-facing conflict commands can
 * import it without pulling in the command registry (which imports them).
 */
import { runProc } from "../proc.js";
import { defaultBaseBranch } from "../worktree.js";

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

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return ok(await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]));
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
