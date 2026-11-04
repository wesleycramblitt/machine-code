/**
 * machine_code — manual task lifecycle.
 *
 * The Orchestrator runs many tasks. This module runs the same task contract
 * for one issue at a time while keeping the human in control: status, review
 * checks, approval, closure, and worktree cleanup.
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
import { commitWorktree, recreateWorktreeFromBranch, removeWorktree } from "../worktree.js";
import { maybePublish } from "../pr/publish.js";
import { createPrProviderFor } from "../pr/factory.js";
import type { PullRequest, PullRequestProvider } from "../pr/provider.js";
import { parseVerificationCommands } from "../packet.js";
import { allCommands } from "../commands/profiles.js";
import { runCommand } from "../commands/registry.js";
import { runProc } from "../proc.js";

export type TaskStage =
  | "planning"
  | "ready"
  | "building"
  | "reviewing"
  | "awaiting-review"
  | "awaiting-acceptance"
  | "blocked"
  | "closed";

export interface TaskReviewCheck {
  command: string;
  passed: boolean;
  durationMs: number;
  output: string;
  at?: string;
}

export interface TaskStatus {
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
  checks: TaskReviewCheck[];
  stage: TaskStage;
  next: string[];
}

export interface TaskStatusOptions {
  prs?: PullRequestProvider;
}

function assignedIssue(run: RunSummary): IssueRef | undefined {
  return run.taskIssue ?? run.issue;
}

function sameRef(a: IssueRef | undefined, b: IssueRef): boolean {
  return Boolean(a && a.repo === b.repo && a.number === b.number);
}

export function taskRuns(layout: Layout, ref: IssueRef): RunSummary[] {
  return listRuns(layout)
    .filter((run) => sameRef(assignedIssue(run), ref))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function latestTaskRun(layout: Layout, ref: IssueRef): RunSummary | undefined {
  return taskRuns(layout, ref)[0];
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

function latestChecks(layout: Layout, runs: readonly RunSummary[]): TaskReviewCheck[] {
  const byCommand = new Map<string, TaskReviewCheck>();
  for (const summary of [...runs].reverse()) {
    for (const event of readRunSummaryEvents(layout, summary)) {
      if (event.type !== "task_review_check") continue;
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

export async function taskStatus(
  layout: Layout,
  issue: Issue,
  options: TaskStatusOptions = {},
): Promise<TaskStatus> {
  const parsed = parsePlanMarker(issue.body);
  const plan = parsed.plan;
  const runs = taskRuns(layout, issue.ref);
  const latest = runs[0];
  const build = latestBuildRun(runs);
  const review = latestReviewRun(runs);
  const branch = build?.branch ?? latest?.branch ?? `mc/task/${issue.ref.number}`;
  const baseBranch = build?.baseBranch ?? latest?.baseBranch;
  const worktree = build?.worktree ?? latest?.worktree;
  const state = await worktreeState(worktree);
  const pr = await resolvePr(build ?? latest, branch, baseBranch, options.prs);
  const acceptance = acceptanceEvidence(layout, issue.ref).verified;
  const checks = latestChecks(layout, runs);

  let stage: TaskStage;
  if (issue.state === "closed") stage = "closed";
  else if (!plan || !isReadyPlan(plan)) stage = "planning";
  else if (!latest) stage = "ready";
  else if (latest.status === "created" || latest.status === "running" || latest.status === "awaiting_input") {
    stage = latest.phase === "review" ? "reviewing" : "building";
  } else if (latest.status === "blocked" || latest.status === "failed" || latest.status === "interrupted") {
    stage = "blocked";
  } else if (pr?.state === "open") stage = "awaiting-review";
  else if (pr?.state === "merged") stage = "awaiting-acceptance";
  else if (pr?.state === "closed") stage = "blocked";
  else if (state.dirty || build?.commit) stage = "awaiting-review";
  else stage = "awaiting-acceptance";

  const n = issue.ref.number;
  const next: string[] = [];
  if (stage === "planning") next.push(`machine_code run --agent planner --issue ${n}`);
  if (stage === "ready") next.push(`machine_code task start ${n}`);
  if (stage === "building" || stage === "reviewing") next.push(`machine_code show ${latest?.id ?? "<run-id>"}`);
  if (stage === "blocked" && latest?.status === "interrupted") next.push(`machine_code resume ${latest.id}`);
  if (stage === "awaiting-review") {
    const checksPassed = checks.length > 0 && checks.every((check) => check.passed);
    if (!checksPassed) next.push(`machine_code task review ${n}`);
    next.push(
      pr?.state === "open"
        ? `machine_code task approve ${n}`
        : `machine_code task approve ${n}  # commits and opens the Task PR`,
    );
  }
  if (stage === "awaiting-acceptance") next.push(`machine_code task approve ${n}`);
  if (stage === "blocked") {
    next.push(`machine_code show ${latest?.id ?? "<run-id>"}`);
    if (state.exists) next.push(`machine_code task cleanup ${n} --force`);
  }
  if (stage === "closed" && state.exists) next.push(`machine_code task cleanup ${n}`);

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

export interface TaskCheckResult extends TaskReviewCheck {}

/** Run review checks in the Task worktree and record them on the latest run. */
export async function runTaskChecks(
  layout: Layout,
  issue: Issue,
  checks: readonly string[],
): Promise<TaskCheckResult[]> {
  const status = await taskStatus(layout, issue);
  let worktree = status.worktree;
  if ((!worktree || !status.worktreeExists) && status.latest && status.branch) {
    try {
      worktree = await recreateWorktreeFromBranch(layout, status.latest.id, status.branch);
    } catch (error) {
      throw new Error(`task #${issue.ref.number} has no worktree to review: ${(error as Error).message}`);
    }
  }
  if (!worktree) throw new Error(`task #${issue.ref.number} has no worktree to review`);
  const commands = allCommands(layout);
  const results: TaskCheckResult[] = [];
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

function failedChecks(status: TaskStatus): TaskReviewCheck[] {
  return status.checks.filter((check) => !check.passed);
}

export interface ApproveTaskInput {
  layout: Layout;
  machine: import("../config.js").MachineConfig;
  provider: IssueProvider;
  issue: Issue;
  runId?: string;
  prs?: PullRequestProvider;
  /** Commit dirty worktree changes before publishing. Defaults to true. */
  commit?: boolean;
  /** Merge an open Task PR. Defaults to true. */
  merge?: boolean;
  /** Remove the worktree after a successful closure. Defaults to true. */
  clean?: boolean;
  /** Delete the local Task branch with the worktree. Defaults to true. */
  deleteBranch?: boolean;
  /** Approve even when the latest review checks failed. */
  force?: boolean;
}

export interface ApproveTaskResult {
  run: RunSummary;
  pr?: PullRequest;
  closedParents: number[];
  worktreeRemoved: boolean;
}

export async function approveTask(input: ApproveTaskInput): Promise<ApproveTaskResult> {
  const { layout, machine, provider, issue } = input;
  const run = input.runId
    ? readRun(layout, input.runId)?.summary
    : latestBuildRun(taskRuns(layout, issue.ref));
  if (!run) throw new Error(`task #${issue.ref.number} has no build run`);
  if (run.status !== "completed") {
    throw new Error(`latest build run ${run.id} is ${run.status}; fix or rerun it before approval`);
  }

  const status = await taskStatus(layout, issue, input.prs ? { prs: input.prs } : {});
  const failed = failedChecks(status);
  if (failed.length > 0 && !input.force) {
    throw new Error(
      `review checks failed: ${failed.map((check) => check.command).join(", ")}; rerun task review or pass --force`,
    );
  }

  let current = run;
  if (status.worktree && status.worktreeExists && status.worktreeDirty) {
    if (input.commit === false) {
      throw new Error(`worktree has uncommitted changes: ${status.worktree}`);
    }
    const committed = await commitWorktree({
      path: status.worktree,
      message: `Task #${issue.ref.number}: ${issue.title}`,
    });
    if (committed.sha) {
      const recorder = RunRecorder.reopen(layout, current);
      recorder.patchSummary({ commit: committed.sha });
      recorder.event("task_committed", { issue: issue.ref.number, sha: committed.sha });
      current = recorder.current;
    }
  }

  const bundle = input.prs
    ? { provider: input.prs, repo: undefined, reason: undefined }
    : await createPrProviderFor(layout);
  const prs = bundle.provider;

  let pr = status.pr;
  if (!pr && current.branch && current.baseBranch && current.branch.startsWith("mc/task/")) {
    const recorder = RunRecorder.reopen(layout, current);
    const published = await maybePublish({
      layout,
      machine,
      recorder,
      prs,
      issues: provider,
      defaultApproval: issue.approval ?? "human",
      title: `Task #${issue.ref.number}: ${issue.title}`,
    });
    if (published.status === "failed") throw new Error(published.error ?? "Task PR publish failed");
    pr = published.pr ? { ...published.pr, ...(published.status === "merged" ? { state: "merged" as const } : {}) } : status.pr;
    current = recorder.current;
  }

  if (pr && pr.state === "open" && input.merge !== false) {
    if (pr.mergeable === false) throw new Error(`PR #${pr.number} has merge conflicts`);
    await prs.merge(pr.number, "squash");
    const recorder = RunRecorder.reopen(layout, current);
    recorder.event("approval_granted", { issue: issue.ref.number, pr: pr.number, by: "human" });
    recorder.event("pr_merged", { pr: pr.number, by: recorder.id, approval: "human" });
    recorder.patchSummary({ prNumber: pr.number, prState: "merged", ...(pr.url ? { prUrl: pr.url } : {}) });
    current = recorder.current;
    pr = { ...pr, state: "merged" };
  } else if (pr && pr.state === "closed" && input.merge !== false) {
    throw new Error(`PR #${pr.number} is closed without merging`);
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

  return { run: current, ...(pr ? { pr } : {}), closedParents: closed.closedParents, worktreeRemoved };
}

export interface CleanupTaskInput {
  layout: Layout;
  issue: Issue;
  run?: RunSummary;
  force?: boolean;
  deleteBranch?: boolean;
}

export async function cleanupTask(input: CleanupTaskInput): Promise<{ removed: boolean; reason?: string }> {
  const run = input.run ?? latestTaskRun(input.layout, input.issue.ref);
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



