/**
 * machine_code — worktree isolation: one worktree per run, one branch per issue.
 *
 * Branches belong to issues (`mc/feature/<n>`, `mc/task/<n>`); worktrees belong
 * to runs (`.machine_code/local/worktrees/<run-id>`). A mutating run never
 * touches the main tree: tools, commands, gates, and LSP all run with
 * `toolRoot` = the run's worktree, while run state, spend, instances, and
 * context sources stay rooted at `repoRoot`.
 *
 * Branch names are numbered for now; slugs are added in Phase 4 when issue
 * titles are available (branch reuse matches by exact name until then). The
 * task→feature base wiring arrives with the issue provider; until then
 * `featureNumber` supplies the parent explicitly and runs without an issue use
 * a run-scoped branch (`mc/run/<run-id>`).
 *
 * All git calls are argument vectors through runProc — no shell, no network,
 * no provider secrets.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { runProc } from "./proc.js";
import type { ProcessSupervisor } from "./processes/supervisor.js";
import type { Layout } from "./paths.js";
import { loadMachineConfig } from "./config.js";
import { readPacket } from "./packet.js";
import { writeJsonAtomic, isActiveStatus, type RunSummary } from "./state/run-schema.js";
import { listRuns } from "./state/runs.js";

export class WorktreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const worktreeSupervisor = new AsyncLocalStorage<ProcessSupervisor>();

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  const supervisor = worktreeSupervisor.getStore();
  if (supervisor) {
    const run = await supervisor.run("git", args, {
      cwd,
      timeoutMs,
      env: GIT_ENV,
      origin: "tool",
      name: "worktree:git",
    });
    return run.result;
  }
  return runProc("git", args, { cwd, timeoutMs, env: GIT_ENV });
}

async function gitOrThrow(cwd: string, args: string[], what: string): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new WorktreeError("git_error", `${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

/* ------------------------------------------------------------- inspection */

interface WorktreeEntry {
  path: string;
  branch?: string;
  detached: boolean;
}

async function worktreeList(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await gitOrThrow(repoRoot, ["worktree", "list", "--porcelain"], "worktree list");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), detached: false };
    } else if (current) {
      if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        current.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "detached") {
        current.detached = true;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** The main worktree root, even when called from inside a linked worktree. */
export async function mainWorktreeRoot(repoRoot: string): Promise<string> {
  const entries = await worktreeList(repoRoot);
  const first = entries[0];
  if (!first) {
    // Bare fallback: rev-parse still answers for the main tree.
    return (await gitOrThrow(repoRoot, ["rev-parse", "--show-toplevel"], "rev-parse")).trim();
  }
  return first.path;
}

/**
 * Runner-owned paths that never block a worktree: planning artifacts, task
 * packets, and the gitignored runtime state directory. Git reports an
 * untracked `.machine_code/` as the bare directory, which is also allowed —
 * tracked files under it (e.g. a modified policy.toml) still appear by their
 * own path and block.
 */
export function allowedDirtyPath(path: string): boolean {
  if (path === ".machine_code" || path === ".machine_code/") return true;
  return (
    path.startsWith(".machine_code/plans/") ||
    path.startsWith(".machine_code/tasks/") ||
    path.startsWith(".machine_code/local/")
  );
}

export async function dirtyPaths(root: string): Promise<string[]> {
  const out = await gitOrThrow(root, ["status", "--porcelain"], "status");
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    // porcelain v1: XY <path> (rename entries are "XY orig -> new")
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    paths.push(arrow >= 0 ? body.slice(arrow + 4) : body);
  }
  return paths;
}

/** Reject uncommitted non-runner-owned changes; artifacts are allowed. */
export async function ensureCleanMainTree(mainRoot: string): Promise<void> {
  const dirty = (await dirtyPaths(mainRoot)).filter((p) => !allowedDirtyPath(p));
  if (dirty.length > 0) {
    throw new WorktreeError(
      "worktree_requires_clean_tree",
      `uncommitted changes must be committed or stashed first: ${dirty.slice(0, 5).join(", ")}` +
        ` (or pass --base <ref> to base on another commit)`,
    );
  }
}

export async function branchExists(mainRoot: string, branch: string): Promise<boolean> {
  const result = await git(mainRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  return result.code === 0;
}

/** Resolve the default base branch: configured, origin HEAD, main, master, current. */
export async function defaultBaseBranch(mainRoot: string): Promise<string> {
  const remote = await git(mainRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (remote.code === 0) {
    const ref = remote.stdout.trim();
    if (ref.startsWith("refs/remotes/origin/")) return ref.slice("refs/remotes/origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    if (await branchExists(mainRoot, candidate)) return candidate;
  }
  const current = await git(mainRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current.stdout.trim() || "main";
}

/** Validate a base reference and return its commit sha. */
export async function resolveBaseRef(mainRoot: string, ref: string): Promise<string> {
  const result = await git(mainRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.code !== 0) {
    throw new WorktreeError("base_not_found", `base ref not found: ${ref}`);
  }
  return result.stdout.trim();
}

/** Path of the worktree holding `branch` checked out, if any. */
export async function branchCheckedOutAt(mainRoot: string, branch: string): Promise<string | null> {
  for (const entry of await worktreeList(mainRoot)) {
    if (entry.branch === branch) return entry.path;
  }
  return null;
}

/**
 * A fork may reuse the parent's worktree when the parent is not actively
 * running. One branch cannot be checked out twice, and the parent's uncommitted
 * work is exactly what a fork usually wants to continue.
 */
export function reusableWorktree(
  parent: Pick<RunSummary, "worktree" | "branch" | "status"> | undefined,
  branch: string | undefined,
): string | undefined {
  if (!parent?.worktree || !branch || parent.branch !== branch) return undefined;
  if (parent.status === "created" || parent.status === "running" || parent.status === "awaiting_input") {
    return undefined;
  }
  return existsSync(parent.worktree) ? parent.worktree : undefined;
}

/* ------------------------------------------------------------- creation */

export type WorktreeKind = "task" | "feature" | "run";

export interface WorktreeRequest {
  layout: Layout;
  runId: string;
  kind: WorktreeKind;
  /** Numeric issue precursor (Phase 4 adds provider-backed validation). */
  issueNumber?: number;
  /** Task runs: explicit parent Feature for the branch base. */
  featureNumber?: number;
  /** Explicit base branch/ref override. */
  base?: string;
  /** Queue packets: materialize the packet snapshot into the worktree. */
  packetId?: string;
  /** Optional run supervisor for worktree git processes. */
  processes?: ProcessSupervisor;
}

export interface WorktreeSpec {
  path: string;
  branch: string;
  baseRef: string;
  baseBranch: string;
  linkedDirs: string[];
  skippedLinks: string[];
  createdBranches: string[];
  materialized: string[];
}

function branchFor(kind: WorktreeKind, runId: string, issueNumber?: number): string {
  if (kind === "task") {
    if (!issueNumber) throw new WorktreeError("issue_required", "a task worktree needs --issue <n>");
    return `mc/task/${issueNumber}`;
  }
  if (kind === "feature") {
    if (!issueNumber) throw new WorktreeError("issue_required", "a feature worktree needs --issue <n>");
    return `mc/feature/${issueNumber}`;
  }
  return `mc/run/${runId}`;
}

/** Profile-declared dependency links ([worktree] links in *.toml profiles). */
async function dependencyLinks(layout: Layout): Promise<string[]> {
  const { loadWorktreeLinks } = await import("./commands/profiles.js");
  return loadWorktreeLinks(layout);
}

function validateLink(link: string): void {
  if (link.length === 0) throw new WorktreeError("invalid_worktree_link", "empty worktree link");
  if (link.startsWith("/")) throw new WorktreeError("invalid_worktree_link", `absolute link path: ${link}`);
  const parts = link.split("/");
  if (parts.includes("..")) throw new WorktreeError("invalid_worktree_link", `link escapes the repo: ${link}`);
}

async function linkDependencies(
  mainRoot: string,
  worktreePath: string,
  links: string[],
): Promise<{ linked: string[]; skipped: string[] }> {
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const link of links) {
    try {
      validateLink(link);
    } catch (error) {
      skipped.push(`${link} (invalid)`);
      continue;
    }
    const src = join(mainRoot, link);
    const dst = join(worktreePath, link);
    let srcIsDir = false;
    try {
      srcIsDir = statSync(src).isDirectory();
    } catch {
      srcIsDir = false;
    }
    if (!srcIsDir) {
      skipped.push(link);
      continue;
    }
    if (existsSync(dst)) {
      skipped.push(`${link} (already present)`);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst, "dir");
    linked.push(link);
  }
  return { linked, skipped };
}

/**
 * Create (or reuse) the run's worktree and its branches.
 * Throws WorktreeError with a stable code on any precondition failure;
 * the caller records events and updates run.json.
 */
export async function createWorktree(req: WorktreeRequest): Promise<WorktreeSpec> {
  return req.processes
    ? worktreeSupervisor.run(req.processes, () => createWorktreeBody(req))
    : createWorktreeBody(req);
}

async function createWorktreeBody(req: WorktreeRequest): Promise<WorktreeSpec> {
  const layout = req.layout;
  const mainRoot = await mainWorktreeRoot(layout.repoRoot);
  const path = join(layout.localDir, "worktrees", req.runId);
  const branch = branchFor(req.kind, req.runId, req.issueNumber);
  const createdBranches: string[] = [];

  // Clean preflight always applies to the MAIN worktree.
  await ensureCleanMainTree(mainRoot);

  // Base resolution: explicit --base wins; a task with a known feature bases
  // on the feature branch; otherwise the default base branch.
  let configuredBase: string | undefined;
  try {
    configuredBase = loadMachineConfig(layout).git?.baseBranch;
  } catch {
    configuredBase = undefined;
  }
  const defaultBase = configuredBase ?? (await defaultBaseBranch(mainRoot));
  let baseBranch: string;
  if (req.base) {
    baseBranch = req.base;
  } else if (req.kind === "task" && req.featureNumber) {
    baseBranch = `mc/feature/${req.featureNumber}`;
  } else {
    baseBranch = defaultBase;
  }

  // Ensure the parent feature branch exists before basing a task on it.
  if (!req.base && req.kind === "task" && req.featureNumber) {
    const featureBranch = `mc/feature/${req.featureNumber}`;
    if (!(await branchExists(mainRoot, featureBranch))) {
      const featureBase = await resolveBaseRef(mainRoot, defaultBase);
      await gitOrThrow(mainRoot, ["branch", featureBranch, featureBase], `branch ${featureBranch}`);
      createdBranches.push(featureBranch);
    }
  }

  const baseRef = await resolveBaseRef(mainRoot, baseBranch);

  // One checkout per branch: git forbids two worktrees on one branch anyway.
  const checkedOut = await branchCheckedOutAt(mainRoot, branch);
  if (checkedOut) {
    throw new WorktreeError(
      "branch_checked_out",
      `branch ${branch} is already checked out at ${checkedOut}; ` +
        "fork the run that owns it or remove that worktree before creating another",
    );
  }

  // Stale leftovers (dir without worktree registration) are removed.
  if (existsSync(path)) {
    const registered = (await worktreeList(mainRoot)).some((e) => e.path === path);
    if (registered) {
      throw new WorktreeError("worktree_exists", `worktree already registered at ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }

  if (await branchExists(mainRoot, branch)) {
    // Reuse the issue branch across runs (fresh worktree, same branch).
    await gitOrThrow(mainRoot, ["worktree", "add", path, branch], `worktree add ${branch}`);
  } else {
    await gitOrThrow(mainRoot, ["worktree", "add", "-b", branch, path, baseRef], `worktree add ${branch}`);
    createdBranches.push(branch);
  }

  const { linked, skipped } = await linkDependencies(mainRoot, path, await dependencyLinks(layout));

  const materialized: string[] = [];
  if (req.packetId) {
    const packet = readPacket(layout, req.packetId);
    if (packet) {
      const file = join(path, ".machine_code", "local", "tasks", `${packet.id}.json`);
      writeJsonAtomic(file, packet);
      materialized.push(file);
    }
  }

  return {
    path,
    branch,
    baseRef,
    baseBranch,
    linkedDirs: linked,
    skippedLinks: skipped,
    createdBranches,
    materialized,
  };
}

/* ------------------------------------------------------------- removal */

export interface RemoveOptions {
  layout: Layout;
  runId: string;
  deleteBranch?: boolean;
  force?: boolean;
  /** Optional run supervisor for worktree git processes. */
  processes?: ProcessSupervisor;
}

function runUsesWorktree(run: RunSummary, path: string, ownerRunId: string | undefined): boolean {
  return run.worktree === path || (ownerRunId !== undefined && run.worktreeOwnerRunId === ownerRunId);
}

/** Remove a run's worktree; refuses while any active run owns or shares it. */
export async function removeWorktree(opts: RemoveOptions): Promise<void> {
  return opts.processes
    ? worktreeSupervisor.run(opts.processes, () => removeWorktreeBody(opts))
    : removeWorktreeBody(opts);
}

async function removeWorktreeBody(opts: RemoveOptions): Promise<void> {
  const layout = opts.layout;
  const path = join(layout.localDir, "worktrees", opts.runId);
  const runs = listRuns(layout);
  const blocking = runs.filter(
    (r) => isActiveStatus(r.status) && (r.worktree === path || r.worktreeOwnerRunId === opts.runId),
  );
  if (blocking.length > 0) {
    throw new WorktreeError(
      "worktree_active",
      `worktree for run ${opts.runId} is still in use by active run(s): ${blocking.map((r) => r.id).join(", ")}`,
    );
  }
  const owner = runs.find((r) => r.worktree === path);
  const branch = owner?.branch;
  const mainRoot = await mainWorktreeRoot(layout.repoRoot);
  if (existsSync(path)) {
    const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), path];
    const result = await git(mainRoot, args);
    if (result.code !== 0) {
      throw new WorktreeError(
        "worktree_remove_failed",
        `git worktree remove failed: ${result.stderr.trim()} (retry with --force to discard uncommitted changes)`,
      );
    }
  }
  await git(mainRoot, ["worktree", "prune"]);
  if (opts.deleteBranch && branch && branch.startsWith("mc/")) {
    await git(mainRoot, ["branch", "-D", branch]);
  }
}

/* ------------------------------------------------------------- commits */

/** Stage everything in the worktree and commit; null when there is nothing to commit. */
export async function commitWorktree(input: {
  path: string;
  message: string;
  processes?: ProcessSupervisor;
}): Promise<{ sha: string | null }> {
  return input.processes
    ? worktreeSupervisor.run(input.processes, () => commitWorktreeBody(input))
    : commitWorktreeBody(input);
}

async function commitWorktreeBody(input: { path: string; message: string }): Promise<{ sha: string | null }> {
  await gitOrThrow(input.path, ["add", "-A"], "git add");
  const status = await git(input.path, ["status", "--porcelain"]);
  if (status.stdout.trim() === "") return { sha: null };
  let commit = await git(input.path, ["commit", "-m", input.message]);
  if (commit.code !== 0) {
    // No configured identity: fall back to a runner identity.
    commit = await git(input.path, [
      "-c",
      "user.name=machine_code",
      "-c",
      "user.email=machine_code@localhost",
      "commit",
      "-m",
      input.message,
    ]);
    if (commit.code !== 0) {
      throw new WorktreeError("commit_failed", `git commit failed: ${commit.stderr.trim()}`);
    }
  }
  const sha = (await gitOrThrow(input.path, ["rev-parse", "HEAD"], "rev-parse")).trim();
  return { sha };
}

/* ------------------------------------------------------------- pruning */

/** Remove orphaned worktree dirs (no run dir anymore) and prune git metadata. */
export async function pruneWorktrees(
  layout: Layout,
  processes?: ProcessSupervisor,
): Promise<{ removed: number }> {
  return processes
    ? worktreeSupervisor.run(processes, () => pruneWorktreesBody(layout))
    : pruneWorktreesBody(layout);
}

async function pruneWorktreesBody(layout: Layout): Promise<{ removed: number }> {
  let mainRoot: string;
  try {
    mainRoot = await mainWorktreeRoot(layout.repoRoot);
  } catch {
    return { removed: 0 };
  }
  const live = new Set(listRuns(layout).map((r) => r.id));
  const dir = join(layout.localDir, "worktrees");
  let removed = 0;
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (live.has(entry.name)) continue;
      rmSync(join(dir, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  if (removed > 0) await git(mainRoot, ["worktree", "prune"]);
  return { removed };
}

/* ------------------------------------------------------------- resume */

/**
 * Recreate a missing worktree from its existing branch (resume path).
 * Committed work is preserved; uncommitted work is gone with the old dir.
 */
export async function recreateWorktreeFromBranch(
  layout: Layout,
  runId: string,
  branch: string,
  processes?: ProcessSupervisor,
): Promise<string> {
  return processes
    ? worktreeSupervisor.run(processes, () => recreateWorktreeFromBranchBody(layout, runId, branch))
    : recreateWorktreeFromBranchBody(layout, runId, branch);
}

async function recreateWorktreeFromBranchBody(layout: Layout, runId: string, branch: string): Promise<string> {
  const mainRoot = await mainWorktreeRoot(layout.repoRoot);
  if (!(await branchExists(mainRoot, branch))) {
    throw new WorktreeError("branch_missing", `branch ${branch} no longer exists`);
  }
  const path = join(layout.localDir, "worktrees", runId);
  if (existsSync(path)) {
    const registered = (await worktreeList(mainRoot)).some((e) => e.path === path);
    if (!registered) rmSync(path, { recursive: true, force: true });
    else return path;
  }
  await gitOrThrow(mainRoot, ["worktree", "add", path, branch], `worktree add ${branch}`);
  return path;
}

/**
 * Fork inheritance: apply the parent worktree's uncommitted diff (vs its base)
 * into a freshly created child worktree. Conflicts fail explicitly — never
 * guessed around.
 */
export async function inheritWorktreePatch(input: {
  parentWorktree: string;
  parentBaseRef?: string;
  childWorktree: string;
}): Promise<{ bytes: number }> {
  const diff = await git(
    input.parentWorktree,
    ["diff", input.parentBaseRef ?? "HEAD"],
    60_000,
  );
  if (diff.code !== 0) {
    throw new WorktreeError("fork_patch_failed", `parent diff failed: ${diff.stderr.trim()}`);
  }
  const patch = diff.stdout;
  if (patch.trim() === "") return { bytes: 0 };
  const tmp = join(input.childWorktree, ".machine_code", "local", `inherit-${Date.now()}.patch`);
  writeJsonAtomic(tmp, {}); // placeholder to create the dir; replaced below
  rmSync(tmp);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tmp, patch, "utf8");
  const apply = await git(input.childWorktree, ["apply", "--whitespace=nowarn", tmp]);
  rmSync(tmp, { force: true });
  if (apply.code !== 0) {
    throw new WorktreeError("fork_patch_conflict", `parent patch does not apply cleanly: ${apply.stderr.trim()}`);
  }
  return { bytes: patch.length };
}
