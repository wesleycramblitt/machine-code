/**
 * machine_code — packet lifecycle: approve (merge → done → delete) and delete.
 *
 * No model here: this module merges a packet's `mc/<slug>` branch into main,
 * completes the packet file (marks the index Done and removes the packet), and
 * cleans up the worktree/branch. It is the slug analogue of
 * `tasks/lifecycle.ts` approveFeature, without any GitHub issue step.
 */
import { existsSync, rmSync } from "node:fs";
import type { Layout } from "../paths.js";
import { listRuns, RunRecorder, type RunSummary } from "../state/runs.js";
import { runProc } from "../proc.js";
import { branchExists, defaultBaseBranch, mainWorktreeRoot, removeWorktree } from "../worktree.js";
import {
  isBuildable,
  listPacketFiles,
  markIndexDone,
  packetBranch,
  packetFilePath,
  readPacketFile,
  removeIndexEntry,
} from "../plan/packets.js";

/** Latest build-phase run for a packet slug (newest first). */
export function packetRuns(layout: Layout, slug: string): RunSummary[] {
  return listRuns(layout)
    .filter((run) => run.packetId === slug)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/**
 * Plan the dispatch order for buildable packets as maximally-parallel waves.
 * A packet is ready when it is `todo`, buildable, and every dependency is
 * already resolved (its packet file is gone — `approve` deletes it — or it is
 * marked `done`). Each wave holds up to `maxParallel` ready leaves; full waves
 * are simulated so later waves build on their dependencies' completion.
 */
export function planBatchWaves(layout: Layout, maxParallel: number): string[][] {
  const cap = Math.max(1, Math.floor(maxParallel));
  const waves: string[][] = [];
  const done = new Set<string>();
  const resolved = (dep: string): boolean => {
    if (done.has(dep)) return true;
    const packet = readPacketFile(layout, dep);
    return packet === null || packet.status === "done";
  };
  let guard = 0;
  while (guard++ < 1000) {
    const ready = listPacketFiles(layout)
      .filter(
        (packet) =>
          packet.status === "todo" &&
          !done.has(packet.slug) &&
          isBuildable(packet) &&
          packet.deps.every(resolved),
      )
      .slice(0, cap);
    if (ready.length === 0) break;
    const wave = ready.map((packet) => packet.slug);
    waves.push(wave);
    for (const slug of wave) done.add(slug);
  }
  return waves;
}

function latestBuildRun(layout: Layout, slug: string): RunSummary | undefined {
  return packetRuns(layout, slug).find((run) => run.agent === "build" || run.phase === "build");
}

/** Resolve the main checkout even when invoked from inside a linked worktree. */
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

/** Stage and commit both `plans/` (map) and `packets/` (contracts). */
async function commitPlans(root: string, message: string): Promise<void> {
  await git(root, ["add", "-A", "--", "plans", "packets"]);
  const status = await git(root, ["status", "--porcelain", "--", "plans", "packets"]);
  if (status.stdout.trim() === "") return;
  let commit = await git(root, ["commit", "-m", message], 60_000);
  if (commit.code !== 0) {
    commit = await git(
      root,
      ["-c", "user.name=machine_code", "-c", "user.email=machine_code@localhost", "commit", "-m", message],
      60_000,
    );
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
}

export interface ApprovePacketOptions {
  /** Remove the worktree/branch after merge. Defaults true. */
  clean?: boolean;
  deleteBranch?: boolean;
  force?: boolean;
}

/**
 * Merge a packet's branch into its base, mark it Done (deleting the packet
 * file), and remove the worktree. Runs only when a completed build run exists.
 */
export async function approvePacket(layout: Layout, slug: string, opts: ApprovePacketOptions = {}): Promise<RunSummary> {
  const packet = readPacketFile(layout, slug);
  if (!packet) throw new Error(`no packet ${slug}`);
  const run = latestBuildRun(layout, slug);
  if (!run) throw new Error(`packet ${slug} has no build run — run \`machine_code build ${slug}\` first`);
  if (run.status !== "completed") {
    throw new Error(`latest build run ${run.id} is ${run.status}; fix or rerun before approval`);
  }

  const root = await mainRoot(layout);
  const branch = run.branch ?? packetBranch(slug);
  const baseBranch = run.baseBranch ?? (await defaultBaseBranch(root));

  const branchCheck = await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (branchCheck.code !== 0) {
    throw new Error(`branch ${branch} no longer exists; nothing to merge`);
  }

  // Merge in the main checkout, never inside the packet worktree.
  const head = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if ((head.stdout.trim() || baseBranch) !== baseBranch) {
    const checkout = await git(root, ["checkout", baseBranch], 60_000);
    if (checkout.code !== 0) {
      throw new Error(`could not check out ${baseBranch}: ${checkout.stderr.trim() || `exit ${checkout.code}`}`);
    }
  }
  const merge = await git(root, ["merge", "--no-ff", branch, "-m", `Merge ${slug}`], 120_000);
  if (merge.code !== 0) {
    throw new Error(
      `merge of ${branch} into ${baseBranch} failed: ${merge.stderr.trim() || `exit ${merge.code}`}; resolve it manually`,
    );
  }

  const recorder = RunRecorder.reopen(layout, run);
  recorder.event("approval_granted", { slug, by: "human" });
  recorder.event("packet_merged", { slug, branch, baseBranch, by: "human" });

  // Complete the packet: drop the file, move the index line to Done, commit.
  const file = packetFilePath(layout, slug);
  if (existsSync(file)) rmSync(file, { force: true });
  markIndexDone(layout, slug, packet.deliverable || slug);
  await commitPlans(root, `plans: complete ${slug}`);

  if (opts.clean !== false && run.worktree && existsSync(run.worktree)) {
    const owner = run.worktreeOwnerRunId ?? run.id;
    try {
      await removeWorktree({ layout, runId: owner, deleteBranch: opts.deleteBranch !== false, ...(opts.force ? { force: true } : {}) });
    } catch {
      // Best-effort: the merge already succeeded; a stray worktree is pruned later.
    }
  }

  return run;
}

export interface DeletePacketOptions {
  deleteBranch?: boolean;
  force?: boolean;
}

/** Remove a packet and everything derived from it: file, index line, branch, worktree. */
export async function deletePacket(layout: Layout, slug: string, opts: DeletePacketOptions = {}): Promise<void> {
  const root = await mainRoot(layout);

  const file = packetFilePath(layout, slug);
  if (existsSync(file)) rmSync(file, { force: true });
  removeIndexEntry(layout, slug);

  for (const run of packetRuns(layout, slug)) {
    const owner = run.worktreeOwnerRunId ?? run.id;
    if (run.worktree && existsSync(run.worktree)) {
      try {
        await removeWorktree({ layout, runId: owner, deleteBranch: opts.deleteBranch !== false, ...(opts.force ? { force: true } : {}) });
      } catch {
        // Best-effort.
      }
    }
  }

  const branch = packetBranch(slug);
  if (await branchExists(root, branch)) {
    await git(root, ["branch", "-D", branch]);
  }

  await commitPlans(root, `plans: delete ${slug}`);
}
