/**
 * machine_code — issue lifecycle.
 *
 * Status is the directory: an issue's status field here is derived from where
 * it lives (`issues/<kind>/<status>/<slug>.md`), and runs attached to it move
 * it between directories when they change state. `blocked` is a front-matter
 * flag, not a status.
 */
import type { RunSummary } from "../state/runs.js";
import { ISSUE_STATUS_LABELS, type DisplayStatus, type Issue, type IssueStatus } from "./issues.js";

export { ISSUE_STATUS_LABELS };

/** The run type an issue kind dispatches. */
export function agentForIssue(issue: Issue): string {
  if (issue.kind === "ideas") return "research";
  return "engineer";
}

/** The run type an issue kind dispatches. */
export function itemStatusOf(issue: Issue): IssueStatus {
  return issue.status;
}

const ACTIVE_RUN = new Set<RunSummary["status"]>(["created", "running", "awaiting_input"]);

/**
 * Effective status while work is live: a `todo` feature/bug with an active
 * run reads `in-progress` without moving the file (the directory stays todo
 * until the run finishes and moves it to done/ or blocked/).
 */
export function effectiveStatus(issue: Issue, runs: readonly RunSummary[]): DisplayStatus {
  if (
    issue.kind !== "ideas" &&
    issue.status === "todo" &&
    runs.some((run) => runItemId(run) === issue.slug && ACTIVE_RUN.has(run.status))
  ) {
    return "in-progress";
  }
  return issue.status;
}

/** The work item a run belongs to: explicit item, else its packet. */
export function runItemId(run: Pick<RunSummary, "itemId" | "packetId">): string | undefined {
  return run.itemId ?? run.packetId;
}
