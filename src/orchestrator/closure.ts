/**
 * machine_code — feature acceptance and closure.
 *
 * A completed Build/Review pair is not enough to close a Feature. The runner
 * must record an acceptance verdict on the run, verify the issue's completion
 * gate, close the Feature, and cascade Epic closure only where the approval
 * policy allows it. The walk stops one level up: feature → epic.
 */
import type { Issue, IssueProvider } from "../issues/provider.js";
import { checkCompletion } from "../issues/completion.js";
import { untrackIssueInPlans } from "../plan/tracking.js";
import type { Layout } from "../paths.js";
import { readRun, RunRecorder } from "../state/runs.js";

export interface CloseFeatureInput {
  provider: IssueProvider;
  layout: Layout;
  issue: Issue;
  runId: string;
  by: "agent" | "human";
}

export interface CloseFeatureResult {
  status: "closed" | "blocked" | "failed";
  error?: string;
  closedParents: number[];
  /** plans/*.md files the closed issues were untracked from. */
  untrackedPlans: string[];
}

export async function closeCompletedFeature(input: CloseFeatureInput): Promise<CloseFeatureResult> {
  const detail = readRun(input.layout, input.runId);
  if (!detail) return { status: "failed", error: `run ${input.runId} is unreadable`, closedParents: [], untrackedPlans: [] };
  const recorder = RunRecorder.reopen(input.layout, detail.summary);
  recorder.event("acceptance_verified", {
    issue: input.issue.ref.number,
    by: input.by,
    criteria: input.issue.acceptance,
    evidence: `${input.by} result approval for run ${input.runId}`,
  });

  const completion = await checkCompletion(input.provider, input.layout, input.issue);
  if (!completion.ok) {
    return { status: "blocked", error: completion.reason ?? "completion check failed", closedParents: [], untrackedPlans: [] };
  }

  await input.provider.close(input.issue.ref, "completed");
  recorder.event("issue_closed", {
    issue: input.issue.ref.number,
    by: input.runId,
    approval: input.by,
    cascaded: [],
  });

  const closedParents: number[] = [];
  // One level only: a feature's parent is its epic; the walk stops there.
  const parent = input.issue.parent ? await input.provider.get(input.issue.parent) : undefined;
  if (parent) {
    const siblings = await input.provider.children(parent.ref);
    if (!siblings.some((child) => child.state !== "closed")) {
      const parentCompletion = await checkCompletion(input.provider, input.layout, parent);
      if (parentCompletion.ok && (parent.approval ?? "human") === "agent") {
        await input.provider.close(parent.ref, "completed");
        recorder.event("approval_granted", { issue: parent.ref.number, by: "agent", policy: "agent" });
        recorder.event("issue_closed", {
          issue: parent.ref.number,
          by: input.runId,
          approval: "agent",
          cascaded: [],
        });
        closedParents.push(parent.ref.number);
      }
    }
  }
  // Plan tracking lines are removed as their issues close (committed on
  // main by the tracking helper). Best-effort: never fail the closure.
  const untracked: string[] = [];
  for (const n of [input.issue.ref.number, ...closedParents]) {
    const removed = await untrackIssueInPlans(input.layout.repoRoot, n);
    for (const file of removed.files) {
      if (!untracked.includes(file)) untracked.push(file);
    }
  }
  recorder.event("plan_tracking", {
    action: "remove",
    issue: input.issue.ref.number,
    planFiles: untracked,
    parents: closedParents,
  });
  return { status: "closed", closedParents, untrackedPlans: untracked };
}

