/**
 * machine_code — PR provider factory + runner-owned publish pipeline.
 *
 * Publishing is runner-owned: agents never run git push or gh pr themselves.
 * A Task branch is pushed to origin and a Task PR is opened against its Feature
 * branch. Approval policy decides whether the runner merges (approval=agent,
 * verified/redundant, non-visual) or queues a human approval request.
 *
 * Non-fatal by design: if there is no remote or gh is unavailable, the run
 * still completes locally and the publish failure is recorded.
 */
import { runProc } from "../proc.js";
import type { Layout } from "../paths.js";
import type { MachineConfig } from "../config.js";
import type { RunRecorder } from "../state/runs.js";
import { createIssueProvider } from "../issues/index.js";
import { createPrProviderFor } from "./factory.js";
import type { IssueProvider } from "../issues/provider.js";
import type { PullRequest, PullRequestProvider } from "./provider.js";

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

export interface PublishInput {
  layout: Layout;
  machine: MachineConfig;
  recorder: RunRecorder;
  /** Human by default; per-issue mc:approval overrides when an issue is set. */
  defaultApproval?: "human" | "agent";
  title?: string;
  body?: string;
  /** Test/coordination injection; defaults to the GitHub/null factory. */
  prs?: PullRequestProvider;
  issues?: IssueProvider;
}

export interface PublishResult {
  status: "skipped" | "failed" | "opened" | "awaiting_approval" | "merged";
  pr?: PullRequest;
  error?: string;
}

function firstLine(text: string, max = 72): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/**
 * Publish the run's branch as a Task PR into its Feature branch.
 * Skips when the run has no Task/Feature branch pair (untracked or run-scoped).
 */
export async function maybePublish(input: PublishInput): Promise<PublishResult> {
  const { layout, recorder } = input;
  const summary = recorder.current;
  const branch = summary.branch;
  const baseBranch = summary.baseBranch;
  if (!branch || !baseBranch) return { status: "skipped" };
  if (!branch.startsWith("mc/task/") || !baseBranch.startsWith("mc/feature/")) {
    return { status: "skipped" };
  }

  const prs = input.prs
    ? { provider: input.prs, reason: undefined as string | undefined }
    : await createPrProviderFor(layout);
  if (prs.provider.kind === "none") {
    recorder.event("publish_skipped", { reason: prs.reason ?? "PR provider unavailable" });
    return { status: "skipped", error: prs.reason };
  }

  // Push the Feature branch (so the PR base exists) and the Task branch.
  for (const ref of [baseBranch, branch]) {
    const push = await runProc("git", ["push", "--porcelain", "-u", "origin", ref], {
      cwd: layout.repoRoot,
      timeoutMs: 120_000,
      env: GIT_ENV,
    });
    if (push.code !== 0) {
      const error = `git push ${ref} failed: ${push.stderr.trim() || `exit ${push.code}`}`;
      recorder.event("publish_failed", { branch: ref, error });
      return { status: "failed", error };
    }
  }

  // Reuse an existing open PR for this head/base rather than failing on rerun.
  let pr: PullRequest | null = null;
  try {
    const existing = await prs.provider.list({ head: branch, base: baseBranch, state: "open" });
    pr = existing[0] ?? null;
  } catch {
    pr = null;
  }
  const title = input.title ?? `Task: ${firstLine(summary.request)}`;
  const body =
    input.body ??
    [
      `Run: \`${summary.id}\``,
      summary.issue ? `Issue: #${summary.issue.number}` : undefined,
      summary.packetId ? `Packet: \`${summary.packetId}\`` : undefined,
      summary.commit ? `Commit: \`${summary.commit}\`` : undefined,
      "",
      summary.request,
    ]
      .filter((l): l is string => l !== undefined)
      .join("\n");

  if (!pr) {
    pr = await prs.provider.create({ head: branch, base: baseBranch, title, body, draft: false });
    recorder.patchSummary({ prNumber: pr.number, prUrl: pr.url, prState: "open" });
    recorder.event("pr_opened", { pr: pr.number, url: pr.url, head: branch, base: baseBranch });
  } else {
    recorder.patchSummary({ prNumber: pr.number, prUrl: pr.url, prState: "open" });
    recorder.event("pr_reused", { pr: pr.number, url: pr.url });
  }

  // Approval: per-issue marker wins, then the run's configured default.
  let approval = input.defaultApproval ?? "human";
  if (summary.issue) {
    try {
      if (input.issues) {
        const issue = await input.issues.get(summary.issue);
        if (issue?.approval) approval = issue.approval;
      } else {
        const issues = await createIssueProvider(layout, input.machine);
        const issue = await issues.provider.get(summary.issue);
        if (issue?.approval) approval = issue.approval;
      }
    } catch {
      // keep the run default
    }
  }

  if (approval === "human") {
    recorder.event("approval_requested", { action: "merge", pr: pr.number, issue: summary.issue?.number });
    return { status: "awaiting_approval", pr };
  }

  try {
    const latest = await prs.provider.status(pr.number);
    if (latest?.mergeable === false) {
      const error = `PR #${pr.number} has merge conflicts; rebase the Task branch before merging`;
      recorder.event("merge_conflict", { pr: pr.number, branch, base: baseBranch });
      return { status: "failed", pr: latest, error };
    }
    await prs.provider.merge(pr.number, "squash");
    recorder.patchSummary({ prState: "merged" });
    recorder.event("pr_merged", { pr: pr.number, method: "squash" });
    return { status: "merged", pr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.event("publish_failed", { pr: pr.number, error: message });
    return { status: "failed", pr, error: message };
  }
}
