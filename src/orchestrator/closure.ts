/**
 * machine_code — task acceptance and closure.
 *
 * A completed Build/Review pair is not enough to close a Task. The runner must
 * record an acceptance verdict on the run, verify the issue's completion gate,
 * close the Task, and cascade parent closure only where the approval policy
 * allows it.
 */
import type { Issue, IssueProvider } from "../issues/provider.js";
import { checkCompletion, cascadeReserved } from "../issues/completion.js";
import { isReserved } from "../issues/reserved.js";
import type { Layout } from "../paths.js";
import { readRun, RunRecorder } from "../state/runs.js";

export interface CloseTaskInput {
  provider: IssueProvider;
  layout: Layout;
  issue: Issue;
  runId: string;
  by: "agent" | "human";
}

export interface CloseTaskResult {
  status: "closed" | "blocked" | "failed";
  error?: string;
  closedParents: number[];
}

export async function closeCompletedTask(input: CloseTaskInput): Promise<CloseTaskResult> {
  const detail = readRun(input.layout, input.runId);
  if (!detail) return { status: "failed", error: `run ${input.runId} is unreadable`, closedParents: [] };
  const recorder = RunRecorder.reopen(input.layout, detail.summary);
  recorder.event("acceptance_verified", {
    issue: input.issue.ref.number,
    by: input.by,
    criteria: input.issue.acceptance,
    evidence: `${input.by} result approval for run ${input.runId}`,
  });

  const completion = await checkCompletion(input.provider, input.layout, input.issue);
  if (!completion.ok) {
    return { status: "blocked", error: completion.reason ?? "completion check failed", closedParents: [] };
  }

  await input.provider.close(input.issue.ref, "completed");
  recorder.event("issue_closed", {
    issue: input.issue.ref.number,
    by: input.runId,
    approval: input.by,
    cascaded: [],
  });

  const closedParents: number[] = [];
  let parent = input.issue.parent ? await input.provider.get(input.issue.parent) : undefined;
  for (let depth = 0; parent && depth < 2; depth += 1) {
    const siblings = (await input.provider.children(parent.ref)).filter((child) => !isReserved(child));
    if (siblings.some((child) => child.state !== "closed")) break;
    const parentCompletion = await checkCompletion(input.provider, input.layout, parent);
    if (!parentCompletion.ok) break;
    if ((parent.approval ?? "human") !== "agent") break;
    await input.provider.close(parent.ref, "completed");
    const cascaded = await cascadeReserved(input.provider, parent, "close");
    recorder.event("approval_granted", { issue: parent.ref.number, by: "agent", policy: "agent" });
    recorder.event("issue_closed", {
      issue: parent.ref.number,
      by: input.runId,
      approval: "agent",
      cascaded,
    });
    closedParents.push(parent.ref.number);
    parent = parent.parent ? await input.provider.get(parent.parent) : undefined;
  }
  return { status: "closed", closedParents };
}
