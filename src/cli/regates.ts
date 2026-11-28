/**
 * machine_code — re-run a blocked run's gates, then commit and merge.
 *
 * A run blocks when its gates fail or the merge cannot land (conflicts).
 * Often the reason is fixed outside the run — a human resolved the conflict
 * in the worktree, or the environment changed. Re-dispatching the model for
 * that would burn a full run to re-verify work that is already written.
 *
 * This path does the runner's half only: resolve the gates from the issue,
 * run them in the run's own worktree (sync + build/test/...), then commit,
 * push, and merge exactly as a completed run would. No model call.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../paths.js";
import { findRunAnywhere, fail, printRunOutcome, EXIT } from "./common.js";
import { allCommands } from "../commands/registry.js";
import { RunRecorder } from "../state/runs.js";
import { reconcileRun } from "../state/runs.js";
import { appendIssueGateFailure, findIssue, gateFailureAttempts, moveIssue, updateIssueMeta } from "../plan/issues.js";
import { issueToTaskPacket } from "../tasks/issue.js";
import { gateFailureText, resolveGates, runGates, withSyncGate } from "../verify.js";
import { ensureCommitted, mergeBranchIntoMain } from "../tasks/merge.js";
import { pushFeatureBranch } from "../tasks/sync.js";
import { recreateWorktreeFromBranch, branchExists } from "../worktree.js";
import { parseFlags } from "./common.js";

/** Statuses a re-gate may repair. Completed work has nothing to prove. */
const REGATE_STATUSES = new Set(["blocked", "failed", "interrupted"]);

export async function cmdRegates(id: string | undefined, argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  if (!id) fail("regates needs a run id");
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const summary = reconcileRun(found.run.summary);
  const l = layout(summary.repoRoot || found.layout.repoRoot);

  if (!REGATE_STATUSES.has(summary.status)) {
    process.stdout.write(`run ${id} is ${summary.status}; only a blocked, failed, or interrupted run re-gates\n`);
    return 0;
  }

  // Resolve the gates first: a run with nothing to prove should fail before
  // any worktree or repository state is touched.
  const issue = summary.itemId ? findIssue(l, summary.itemId) : null;
  const gateCommands = allCommands(l, { scriptsRoot: summary.worktree || l.repoRoot });
  const issueGates = issue ? resolveGates(issueToTaskPacket(issue), gateCommands) : [];
  if (issueGates.length === 0) {
    fail(`run ${id} has no acceptance gates${issue ? "" : " (no issue attached)"}; nothing to verify`);
  }
  const gates = withSyncGate(issueGates, summary.baseBranch);

  if (flags.has("dry-run")) {
    const target = summary.worktree && existsSync(summary.worktree)
      ? summary.worktree
      : summary.branch
        ? `worktree missing; would rebuild from branch ${summary.branch}`
        : "worktree missing and no branch to rebuild it from";
    process.stdout.write(
      `run ${id} (${summary.status}) in ${target}\n` +
        gates.map((gate) => `  ${gate.command}${gate.args && Object.keys(gate.args).length > 0 ? ` ${JSON.stringify(gate.args)}` : ""}\n`).join(""),
    );
    return 0;
  }

  // The worktree holds the work being verified. Recreate it from the branch
  // when it was pruned — the branch is the source of truth.
  let toolRoot = summary.worktree ?? "";
  if (!toolRoot || !existsSync(toolRoot)) {
    if (summary.branch && (await branchExists(l.repoRoot, summary.branch))) {
      toolRoot = await recreateWorktreeFromBranch(l, id, summary.branch);
      process.stderr.write(`recreated worktree from branch ${summary.branch}\n`);
    } else {
      fail(`run ${id} has no worktree and no branch to rebuild it from`);
    }
  }
  const runGateCommands = allCommands(l, { scriptsRoot: toolRoot });

  const recorder = RunRecorder.reopen(l, summary);
  recorder.setStatus("running", "regates");
  recorder.patchSummary({ pid: process.pid });
  recorder.event("regates_started", { fromStatus: summary.status, gates: gates.map((gate) => gate.command) });

  const result = await runGates(gates, {
    root: toolRoot,
    repoRoot: l.repoRoot,
    runDir: recorder.dir,
    commands: runGateCommands,
  });
  recorder.event("gates", {
    attempt: 1,
    passed: result.passed,
    results: result.results.map((r) => ({ command: r.command, passed: r.passed, durationMs: r.durationMs })),
  });

  if (!result.passed) {
    const failure = gateFailureText(result.results);
    if (issue && (issue.kind === "features" || issue.kind === "bugs")) {
      appendIssueGateFailure(issue.path, failure, gateFailureAttempts(issue.body) + 1);
      moveIssue(l, issue.slug, "failed-gates");
    }
    recorder.finalize("blocked", "gates failed on re-gate");
    printRunOutcome({ status: "blocked", finalText: failure }, recorder);
    return EXIT.blocked;
  }

  // Gates pass: land the work exactly as a completed run would.
  let commit: string | null = null;
  try {
    commit = await ensureCommitted(
      toolRoot,
      summary.baseRef,
      `mc(${issue?.slug ?? id}): ${issue?.prompt ?? summary.request ?? id}\n\nrun: ${id}\nregates: ${id}`,
    );
  } catch (error) {
    const msg = `commit failed: ${error instanceof Error ? error.message : String(error)}`;
    recorder.finalize("blocked", msg);
    printRunOutcome({ status: "blocked", finalText: msg }, recorder);
    return EXIT.blocked;
  }
  if (commit) {
    recorder.patchSummary({ commit });
    recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, issue: issue?.slug });
    if (recorder.current.branch) {
      await pushFeatureBranch(toolRoot, recorder.current.branch);
    }
  }

  const branch = recorder.current.branch;
  if (!branch) fail(`run ${id} has no branch to merge`);
  const merged = await mergeBranchIntoMain(l.repoRoot, toolRoot, branch, {
    event: (type, data) => recorder.event(type, data),
  });
  if (!merged.ok) {
    const msg = `merge failed: ${branch} into main${merged.detail ? ` (${merged.detail})` : ""}`;
    if (issue && (issue.kind === "features" || issue.kind === "bugs")) {
      appendIssueGateFailure(issue.path, msg, gateFailureAttempts(issue.body) + 1);
      moveIssue(l, issue.slug, "failed-gates");
    }
    recorder.event("regates_merge_failed", { branch, detail: merged.detail });
    recorder.finalize("blocked", msg);
    printRunOutcome({ status: "blocked", finalText: msg }, recorder);
    return EXIT.blocked;
  }

  recorder.event("branch_merged", { branch, mergeCommit: merged.mergeCommit, regates: true });
  if (issue) {
    if (merged.mergeCommit) updateIssueMeta(l, issue.slug, { commit: merged.mergeCommit });
    if (issue.kind === "features" || issue.kind === "bugs") moveIssue(l, issue.slug, "done");
    else if (issue.kind === "ideas") moveIssue(l, issue.slug, "researched");
  }
  const text = `gates passed; ${commit ? `committed ${commit.slice(0, 12)}; ` : ""}merged ${branch} into main`;
  recorder.finalize("completed", undefined, text);
  printRunOutcome({ status: "completed", finalText: text }, recorder);
  return EXIT.completed;
}
