/**
 * machine_code — manual feature lifecycle.
 *
 * The Orchestrator runs many features. This module runs the same feature
 * contract for one issue at a time while keeping the human in control:
 * status, review checks, approval, closure, and worktree cleanup.
 *
 * Approval merges the feature branch directly into its base branch (no PR).
 * Legacy `Task*` names remain as aliases for compatibility.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { Issue, IssueProvider, IssueRef } from "../issues/provider.js";
import { acceptanceEvidence } from "../issues/completion.js";
import { closeCompletedTask } from "../orchestrator/closure.js";
import { readOrchestration, updateOrchestration } from "../orchestrator/state.js";
import { parsePlanMarker, isReadyPlan, type PlanMarker } from "../plan/schema.js";
import { listRuns, readRun, RunRecorder, type RunSummary } from "../state/runs.js";
import {
  commitWorktree,
  defaultBaseBranch,
  mainWorktreeRoot,
  recreateWorktreeFromBranch,
  removeWorktree,
} from "../worktree.js";
import type { PullRequest, PullRequestProvider } from "../pr/provider.js";
import { parseVerificationCommands } from "../packet.js";
import { allCommands } from "../commands/profiles.js";
import { runCommand } from "../commands/registry.js";
import { runProc } from "../proc.js";

export type FeatureStage =
  | "planning"
  | "ready"
  | "building"
  | "reviewing"
  | "needs-human-review"
  | "blocked"
  | "closed";

export interface FeatureReviewCheck {
  command: string;
  passed: boolean;
  durationMs: number;
  output: string;
  at?: string;
}

export interface FeatureStatus {
  issue: Issue;
  plan?: PlanMarker;
  runs: RunSummary[];
  latest?: RunSummary;
  build?: RunSummary;
  review?: RunSummary;
  branch?: string;
  baseBranch?: string;
  worktree?: string;
  worktreeExists: boolean;
  worktreeDirty: boolean;
  changedFiles: string[];
  commit?: string;
  pr?: PullRequest;
  acceptance: boolean;
  checks: FeatureReviewCheck[];
  stage: FeatureStage;
  next: string[];
}

export interface FeatureStatusOptions {
  prs?: PullRequestProvider;
}

function assignedIssue(run: RunSummary): IssueRef | undefined {
  // New runs write run.issue; legacy runs wrote run.taskIssue.
  return run.issue ?? run.taskIssue;
}

function sameRef(a: IssueRef | undefined, b: IssueRef): boolean {
  return Boolean(a && a.repo === b.repo && a.number === b.number);
}

export function featureRuns(layout: Layout, ref: IssueRef): RunSummary[] {
  return listRuns(layout)
    .filter((run) => sameRef(assignedIssue(run), ref))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function latestFeatureRun(layout: Layout, ref: IssueRef): RunSummary | undefined {
  return featureRuns(layout, ref)[0];
}

function latestBuildRun(runs: readonly RunSummary[]): RunSummary | undefined {
  return runs.find((run) => run.agent === "build" || run.phase === "build");
}

function latestReviewRun(runs: readonly RunSummary[]): RunSummary | undefined {
  return runs.find((run) => run.agent === "review" || run.phase === "review");
}

async function worktreeState(path: string | undefined): Promise<{ exists: boolean; dirty: boolean; changed: string[] }> {
  if (!path || !existsSync(path)) return { exists: false, dirty: false, changed: [] };
  const status = await runProc("git", ["status", "--porcelain"], { cwd: path, timeoutMs: 30_000 });
  const changed = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^..\s+/, ""));
  return { exists: true, dirty: changed.length > 0, changed };
}

function summaryPr(run: RunSummary | undefined): PullRequest | undefined {
  if (!run?.prNumber) return undefined;
  return {
    number: run.prNumber,
    url: run.prUrl ?? "",
    state: run.prState === "merged" ? "merged" : run.prState === "closed" ? "closed" : "open",
    isDraft: false,
    head: run.branch ?? "",
    base: run.baseBranch ?? "",
    title: run.request,
  };
}

function latestChecks(layout: Layout, runs: readonly RunSummary[]): FeatureReviewCheck[] {
  const byCommand = new Map<string, FeatureReviewCheck>();
  for (const summary of [...runs].reverse()) {
    for (const event of readRunSummaryEvents(layout, summary)) {
      if (event.type !== "task_review_check" && event.type !== "feature_review_check") continue;
      const command = typeof event.command === "string" ? event.command : "";
      if (!command) continue;
      byCommand.set(command, {
        command,
        passed: event.passed === true,
        durationMs: typeof event.durationMs === "number" ? event.durationMs : 0,
        output: typeof event.output === "string" ? event.output : "",
        ...(typeof event.t === "string" ? { at: event.t } : {}),
      });
    }
  }
  return [...byCommand.values()];
}

function readRunSummaryEvents(
  layout: Layout,
  summary: RunSummary,
): Array<Record<string, unknown> & { type: string; t?: string }> {
  const file = join(layout.runsDir, summary.id, "events.jsonl");
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string; t?: string });
  } catch {
    return [];
  }
}

async function resolvePr(
  run: RunSummary | undefined,
  branch: string | undefined,
  baseBranch: string | undefined,
  prs: PullRequestProvider | undefined,
): Promise<PullRequest | undefined> {
  const fromRun = summaryPr(run);
  if (prs && fromRun) {
    try {
      return (await prs.status(fromRun.number)) ?? fromRun;
    } catch {
      return fromRun;
    }
  }
  if (prs && branch) {
    try {
      const found = await prs.list({
        head: branch,
        ...(baseBranch ? { base: baseBranch } : {}),
        state: "all",
      });
      return found.sort((a, b) => b.number - a.number)[0];
    } catch {
      // fall through to the run record
    }
  }
  return fromRun;
}

export async function featureStatus(
  layout: Layout,
  issue: Issue,
  options: FeatureStatusOptions = {},
): Promise<FeatureStatus> {
  const parsed = parsePlanMarker(issue.body);
  const plan = parsed.plan;
  const runs = featureRuns(layout, issue.ref);
  const latest = runs[0];
  const build = latestBuildRun(runs);
  const review = latestReviewRun(runs);
  const branch = build?.branch ?? latest?.branch ?? `mc/feature/${issue.ref.number}`;
  const baseBranch = build?.baseBranch ?? latest?.baseBranch;
  const worktree = build?.worktree ?? latest?.worktree;
  const state = await worktreeState(worktree);
  const pr = await resolvePr(build ?? latest, branch, baseBranch, options.prs);
  const acceptance = acceptanceEvidence(layout, issue.ref).verified;
  const checks = latestChecks(layout, runs);

  let stage: FeatureStage;
  if (issue.state === "closed") stage = "closed";
  else if (!plan || !isReadyPlan(plan) || issue.acceptance.length === 0) stage = "planning";
  else if (!latest) stage = "ready";
  else if (latest.status === "created" || latest.status === "running" || latest.status === "awaiting_input") {
    stage = latest.phase === "review" ? "reviewing" : "building";
  } else if (latest.status === "blocked" || latest.status === "failed" || latest.status === "interrupted") {
    stage = "blocked";
  } else if (pr?.state === "open") {
    // Legacy PR path: an open PR still needs a human decision.
    stage = "needs-human-review";
  } else if (pr?.state === "closed") {
    stage = "blocked";
  } else if (latest.status === "completed" && (state.dirty || build?.commit || latest.commit)) {
    // Completed work with a commit: humans approve explicitly, agent-approved
    // features are ready for the orchestrator to auto-close.
    stage = (issue.approval ?? "human") === "human" ? "needs-human-review" : "ready";
  } else if (latest.status === "completed") {
    stage = "blocked";
  } else {
    stage = "blocked";
  }

  const n = issue.ref.number;
  const next: string[] = [];
  if (stage === "planning") next.push(`machine_code feature status ${n}`);
  if (stage === "ready") next.push(`machine_code feature status ${n}`);
  if (stage === "building" || stage === "reviewing") next.push(`machine_code show ${latest?.id ?? "<run-id>"}`);
  if (stage === "blocked" && latest?.status === "interrupted") next.push(`machine_code resume ${latest.id}`);
  if (stage === "needs-human-review") {
    const checksPassed = checks.length > 0 && checks.every((check) => check.passed);
    if (!checksPassed) next.push(`machine_code feature review ${n}`);
    next.push(`machine_code feature approve ${n}`);
  }
  if (stage === "blocked") {
    next.push(`machine_code show ${latest?.id ?? "<run-id>"}`);
    if (state.exists) {
      next.push(`machine_code feature cleanup ${n} --force`);
    }
  }
  if (stage === "closed" && state.exists) next.push(`machine_code feature cleanup ${n}`);

  return {
    issue,
    ...(plan ? { plan } : {}),
    runs,
    ...(latest ? { latest } : {}),
    ...(build ? { build } : {}),
    ...(review ? { review } : {}),
    branch,
    ...(baseBranch ? { baseBranch } : {}),
    ...(worktree ? { worktree } : {}),
    worktreeExists: state.exists,
    worktreeDirty: state.dirty,
    changedFiles: state.changed,
    ...(build?.commit ?? latest?.commit ? { commit: build?.commit ?? latest?.commit } : {}),
    ...(pr ? { pr } : {}),
    acceptance,
    checks,
    stage,
    next: [...new Set(next)],
  };
}

export interface FeatureCheckResult extends FeatureReviewCheck {}

/** Run review checks in the Feature worktree and record them on the latest run. */
export async function runFeatureChecks(
  layout: Layout,
  issue: Issue,
  checks: readonly string[],
): Promise<FeatureCheckResult[]> {
  const status = await featureStatus(layout, issue);
  let worktree = status.worktree;
  if ((!worktree || !status.worktreeExists) && status.latest && status.branch) {
    try {
      worktree = await recreateWorktreeFromBranch(layout, status.latest.id, status.branch);
    } catch (error) {
      throw new Error(`feature #${issue.ref.number} has no worktree to review: ${(error as Error).message}`);
    }
  }
  if (!worktree) throw new Error(`feature #${issue.ref.number} has no worktree to review`);
  const commands = allCommands(layout);
  const results: FeatureCheckResult[] = [];
  for (const check of checks) {
    const start = Date.now();
    const named = commands.has(check);
    let passed = false;
    let output = "";
    if (named) {
      try {
        const result = await runCommand(check, {}, { root: worktree, commands });
        passed = !result.isError;
        output = result.text;
      } catch (error) {
        output = (error as Error).message;
      }
    } else {
      const result = await runProc("/bin/sh", ["-c", check], {
        cwd: worktree,
        timeoutMs: 10 * 60_000,
      });
      passed = result.code === 0 && result.outcome === "exit";
      output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    }
    results.push({
      command: check,
      passed,
      durationMs: Date.now() - start,
      output: output.slice(-4_000),
    });
  }
  if (status.latest) {
    const detail = readRun(layout, status.latest.id);
    if (detail) {
      const recorder = RunRecorder.reopen(layout, detail.summary);
      for (const result of results) {
        // task_review_check kept for compatibility with older readers.
        recorder.event("task_review_check", {
          issue: issue.ref.number,
          command: result.command,
          passed: result.passed,
          durationMs: result.durationMs,
          output: result.output,
        });
      }
    }
  }
  return results;
}

export function suggestedReviewChecks(issue: Issue): string[] {
  return parseVerificationCommands(issue.body);
}

function ownerRunId(layout: Layout, run: RunSummary): string | undefined {
  if (!run.worktree) return run.worktreeOwnerRunId;
  const owner = listRuns(layout).find(
    (candidate) => candidate.worktree === run.worktree && join(layout.localDir, "worktrees", candidate.id) === run.worktree,
  );
  return owner?.id ?? run.worktreeOwnerRunId ?? run.id;
}

function failedChecks(status: FeatureStatus): FeatureReviewCheck[] {
  return status.checks.filter((check) => !check.passed);
}

/**
 * Resolve the main repository checkout for a merge. layout.repoRoot may
 * itself be inside a linked worktree; the first `git worktree list` entry is
 * the main tree. Falls back to layout.repoRoot when the list fails.
 */
async function mainRepoRoot(layout: Layout): Promise<string> {
  try {
    return await mainWorktreeRoot(layout.repoRoot);
  } catch {
    return layout.repoRoot;
  }
}

export interface ApproveFeatureInput {
  layout: Layout;
  machine: import("../config.js").MachineConfig;
  provider: IssueProvider;
  issue: Issue;
  runId?: string;
  prs?: PullRequestProvider;
  /** Commit dirty worktree changes before merging. Defaults to true. */
  commit?: boolean;
  /** Kept for compatibility; merges always happen directly (no PR). */
  merge?: boolean;
  /** Remove the worktree after a successful closure. Defaults to true. */
  clean?: boolean;
  /** Delete the local Feature branch with the worktree. Defaults to true. */
  deleteBranch?: boolean;
  /** Approve even when the latest review checks failed. */
  force?: boolean;
}

export interface ApproveFeatureResult {
  run: RunSummary;
  pr?: PullRequest;
  closedParents: number[];
  worktreeRemoved: boolean;
}

export async function approveFeature(input: ApproveFeatureInput): Promise<ApproveFeatureResult> {
  const { layout, provider, issue } = input;
  const run = input.runId
    ? readRun(layout, input.runId)?.summary
    : latestBuildRun(featureRuns(layout, issue.ref));
  if (!run) throw new Error(`feature #${issue.ref.number} has no build run`);
  if (run.status !== "completed") {
    throw new Error(`latest build run ${run.id} is ${run.status}; fix or rerun it before approval`);
  }

  const status = await featureStatus(layout, issue, input.prs ? { prs: input.prs } : {});
  const failed = failedChecks(status);
  if (failed.length > 0 && !input.force) {
    throw new Error(
      `review checks failed: ${failed.map((check) => check.command).join(", ")}; rerun feature review or pass --force`,
    );
  }

  let current = run;
  if (status.worktree && status.worktreeExists && status.worktreeDirty) {
    if (input.commit === false) {
      throw new Error(`worktree has uncommitted changes: ${status.worktree}`);
    }
    const committed = await commitWorktree({
      path: status.worktree,
      message: `Feature #${issue.ref.number}: ${issue.title}`,
    });
    if (committed.sha) {
      const recorder = RunRecorder.reopen(layout, current);
      recorder.patchSummary({ commit: committed.sha });
      recorder.event("feature_committed", { issue: issue.ref.number, sha: committed.sha });
      current = recorder.current;
    }
  }

  const branch = current.branch ?? `mc/feature/${issue.ref.number}`;
  const mainRoot = await mainRepoRoot(layout);
  const baseBranch = current.baseBranch ?? (await defaultBaseBranch(mainRoot));

  const branchCheck = await runProc("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: mainRoot,
    timeoutMs: 30_000,
  });
  if (branchCheck.code !== 0) {
    throw new Error(`feature branch ${branch} no longer exists; nothing to merge`);
  }

  // Merge in the main checkout, never inside the feature worktree.
  const head = await runProc("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: mainRoot,
    timeoutMs: 30_000,
  });
  if ((head.stdout.trim() || baseBranch) !== baseBranch) {
    const checkout = await runProc("git", ["checkout", baseBranch], {
      cwd: mainRoot,
      timeoutMs: 60_000,
    });
    if (checkout.code !== 0) {
      throw new Error(`could not check out ${baseBranch}: ${checkout.stderr.trim() || `exit ${checkout.code}`}`);
    }
  }
  const merge = await runProc(
    "git",
    ["merge", "--no-ff", branch, "-m", `Merge feature #${issue.ref.number}`],
    { cwd: mainRoot, timeoutMs: 120_000 },
  );
  if (merge.code !== 0) {
    throw new Error(
      `merge of ${branch} into ${baseBranch} failed: ${merge.stderr.trim() || `exit ${merge.code}`}; resolve it manually`,
    );
  }
  const mergeSha = await runProc("git", ["rev-parse", "HEAD"], { cwd: mainRoot, timeoutMs: 30_000 });

  {
    const recorder = RunRecorder.reopen(layout, current);
    recorder.event("approval_granted", { issue: issue.ref.number, by: "human" });
    recorder.event("feature_merged", {
      issue: issue.ref.number,
      branch,
      baseBranch,
      ...(mergeSha.stdout.trim() ? { sha: mergeSha.stdout.trim() } : {}),
      by: "human",
    });
    if (mergeSha.stdout.trim()) recorder.patchSummary({ commit: mergeSha.stdout.trim() });
    current = recorder.current;
  }

  const closed = await closeCompletedTask({
    provider,
    layout,
    issue,
    runId: current.id,
    by: "human",
  });
  if (closed.status !== "closed") {
    throw new Error(closed.error ?? `could not close #${issue.ref.number}`);
  }

  if (current.orchestrationId) {
    const orchestration = readOrchestration(layout, current.orchestrationId);
    if (orchestration) {
      const approved = [...new Set([...(orchestration.approvedResults ?? []), issue.ref.number])].sort((a, b) => a - b);
      updateOrchestration(layout, orchestration.id, {
        approvedResults: approved,
        approvedFeatures: approved,
        checkpoint: "result_approved",
      });
    }
  }

  let worktreeRemoved = false;
  const shouldClean = input.clean !== false && input.merge !== false;
  if (shouldClean && current.worktree && existsSync(current.worktree)) {
    const owner = ownerRunId(layout, current);
    if (owner) {
      try {
        await removeWorktree({
          layout,
          runId: owner,
          deleteBranch: input.deleteBranch !== false,
          ...(input.force ? { force: true } : {}),
        });
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
    }
  }

  return { run: current, closedParents: closed.closedParents, worktreeRemoved };
}

export interface CleanupFeatureInput {
  layout: Layout;
  issue: Issue;
  run?: RunSummary;
  force?: boolean;
  deleteBranch?: boolean;
}

export async function cleanupFeature(input: CleanupFeatureInput): Promise<{ removed: boolean; reason?: string }> {
  const run = input.run ?? latestFeatureRun(input.layout, input.issue.ref);
  if (!run?.worktree) return { removed: false, reason: "no worktree" };
  if (input.issue.state !== "closed" && !input.force) {
    return { removed: false, reason: `#${input.issue.ref.number} is still open; use --force to discard it` };
  }
  const owner = ownerRunId(input.layout, run);
  if (!owner) return { removed: false, reason: "worktree owner not found" };
  try {
    await removeWorktree({
      layout: input.layout,
      runId: owner,
      deleteBranch: input.deleteBranch !== false,
      ...(input.force ? { force: true } : {}),
    });
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Legacy Task* aliases. New code uses the Feature* names above.
// ---------------------------------------------------------------------------

export type TaskStage = FeatureStage;
export type TaskStatus = FeatureStatus;
export type TaskReviewCheck = FeatureReviewCheck;
export type TaskCheckResult = FeatureCheckResult;
export type TaskStatusOptions = FeatureStatusOptions;
export type ApproveTaskInput = ApproveFeatureInput;
export type ApproveTaskResult = ApproveFeatureResult;
export type CleanupTaskInput = CleanupFeatureInput;

export const taskRuns = featureRuns;
export const latestTaskRun = latestFeatureRun;
export const taskStatus = featureStatus;
export const runTaskChecks = runFeatureChecks;
export const approveTask = approveFeature;
export const cleanupTask = cleanupFeature;
