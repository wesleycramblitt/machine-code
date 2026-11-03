/**
 * machine_code — Feature PR pipeline (Feature branch → main).
 *
 * Only after every deliverable Task under the Feature is closed. The runner
 * creates a temporary Feature worktree, runs the configured integration gates,
 * removes the worktree, pushes the Feature branch, and opens the Feature PR.
 * Approval policy: human by default; a Feature may opt into agent merge.
 */
import { runProc } from "../proc.js";
import type { Layout } from "../paths.js";
import type { MachineConfig } from "../config.js";
import type { IssueProvider, IssueRef } from "../issues/provider.js";
import { createIssueProvider } from "../issues/index.js";
import { isReserved } from "../issues/reserved.js";
import { createPrProviderFor } from "./factory.js";
import { PrError, type PullRequest, type PullRequestProvider } from "./provider.js";
import { allCommands } from "../commands/profiles.js";
import { runCommand } from "../commands/registry.js";
import { recreateWorktreeFromBranch, removeWorktree, mainWorktreeRoot } from "../worktree.js";
import type { RunRecorder } from "../state/runs.js";
import { ProcessSupervisor } from "../processes/supervisor.js";

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

export interface FeatureGate {
  command: string;
  args?: Record<string, unknown>;
}

export interface PublishFeatureInput {
  layout: Layout;
  machine: MachineConfig;
  recorder: RunRecorder;
  feature: IssueRef;
  defaultApproval?: "human" | "agent";
  gates?: FeatureGate[];
  /** Test injection. */
  prs?: PullRequestProvider;
  issues?: IssueProvider;
  /** Optional run supervisor for integration git processes. */
  processes?: ProcessSupervisor;
}

export interface PublishFeatureResult {
  status: "blocked" | "failed" | "awaiting_approval" | "merged";
  pr?: PullRequest;
  error?: string;
}

export async function publishFeature(input: PublishFeatureInput): Promise<PublishFeatureResult> {
  const { layout, machine, recorder } = input;
  const issues = input.issues ?? (await createIssueProvider(layout, machine)).provider;
  const feature = await issues.get(input.feature);
  if (!feature) throw new PrError("issue_not_found", `feature ${input.feature.repo}#${input.feature.number} not found`);
  if (feature.kind !== "feature") throw new PrError("not_feature", `#${feature.ref.number} is a ${feature.kind}, not a Feature`);

  const children = await issues.children(feature.ref);
  const open = children.filter((c) => c.kind === "task" && !isReserved(c) && c.state !== "closed");
  if (open.length > 0) {
    return {
      status: "blocked",
      error: `feature #${feature.ref.number} has open tasks: ${open.map((c) => `#${c.ref.number}`).join(", ")}`,
    };
  }

  const prs = input.prs ?? (await createPrProviderFor(layout)).provider;
  if (prs.kind === "none") {
    recorder.event("publish_skipped", { reason: "PR provider unavailable" });
    return { status: "failed", error: "PR provider unavailable" };
  }

  const branch = `mc/feature/${feature.ref.number}`;
  const runId = `feature-${feature.ref.number}`;
  const processes =
    input.processes ??
    new ProcessSupervisor({
      runId: recorder.id,
      runDir: recorder.dir,
      onEvent: (type, data) => recorder.event(type, data),
    });

  // Temporary integration worktree on the Feature branch.
  let worktree: string;
  try {
    worktree = await recreateWorktreeFromBranch(layout, runId, branch, processes);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  const commands = allCommands(layout);
  try {
    for (const gate of input.gates ?? []) {
      const result = await runCommand(gate.command, gate.args ?? {}, { root: worktree, commands });
      if (result.isError) {
        return { status: "blocked", error: `integration gate ${gate.command} failed: ${result.text.slice(0, 400)}` };
      }
      recorder.event("integration_gate", { command: gate.command, passed: true });
    }
  } finally {
    try {
      await removeWorktree({ layout, runId, force: true, processes });
    } catch {
      // leave the worktree for inspection
    }
  }

  // Push the Feature branch so main can be targeted.
  const push = await runProc("git", ["push", "--porcelain", "-u", "origin", branch], {
    cwd: layout.repoRoot,
    timeoutMs: 120_000,
    env: GIT_ENV,
  });
  if (push.code !== 0) {
    const error = `git push ${branch} failed: ${push.stderr.trim() || `exit ${push.code}`}`;
    recorder.event("publish_failed", { branch, error });
    return { status: "failed", error };
  }

  const pr = await prs.create({
    head: branch,
    base: "main",
    title: `Feature #${feature.ref.number}: ${feature.title}`,
    body: [
      `Feature: #${feature.ref.number}`,
      `Tasks: ${children.filter((c) => c.kind === "task" && !isReserved(c)).map((c) => `#${c.ref.number}`).join(", ") || "(none)"}`,
      `Run: \`${recorder.id}\``,
      "",
      feature.body.slice(0, 2000),
    ].join("\n"),
    draft: false,
  });
  recorder.patchSummary({ prNumber: pr.number, prUrl: pr.url, prState: "open" });
  recorder.event("pr_opened", { pr: pr.number, head: branch, base: "main", feature: feature.ref.number });

  const approval = feature.approval ?? input.defaultApproval ?? "human";
  if (approval === "human") {
    recorder.event("approval_requested", { action: "merge", pr: pr.number, issue: feature.ref.number });
    return { status: "awaiting_approval", pr };
  }
  await prs.merge(pr.number, "squash");
  recorder.patchSummary({ prState: "merged" });
  recorder.event("pr_merged", { pr: pr.number, method: "squash" });
  return { status: "merged", pr };
}

export { mainWorktreeRoot };
