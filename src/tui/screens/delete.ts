/**
 * machine_code — delete confirmation screen.
 *
 * Pure render of the two deletions the runs page gates: a run record, or an
 * issue file with its branch. The caller resolves the target (and the live-run
 * counts that block an issue delete) so this stays display-only. Returns null
 * when there is no target so the router can fall back to the previous screen.
 */
import { B, D, GR, R, RED, Y, command, joinCommands, trunc } from "../format.js";
import { isActiveStatus, type RunSummary } from "../../state/runs.js";
import { ISSUE_KIND_LABELS, ISSUE_STATUS_LABELS, type Issue } from "../../plan/issues.js";
import { clipLines } from "./types.js";

export interface DeleteFrame {
  body: string[];
  actions: string;
  secondary: string;
}

/** A run about to be deleted: record, events, worktree, branch. */
export interface RunDeleteTarget {
  kind: "run";
  run: RunSummary;
}

/** An issue about to be deleted, plus the run counts that gate it. */
export interface IssueDeleteTarget {
  kind: "issue";
  issue: Issue;
  /** Repo whose work tree holds the issue file. */
  repoRoot: string;
  /** Runs attached to the issue. */
  runs: number;
  /** Attached runs still live; the delete is refused while any remain. */
  activeRuns: number;
}

export type DeleteTarget = RunDeleteTarget | IssueDeleteTarget;

export function renderDeleteConfirm(target: DeleteTarget | undefined, bodyH: number): DeleteFrame | null {
  if (!target) return null;
  const lines = target.kind === "run" ? runDeleteLines(target.run) : issueDeleteLines(target);
  return {
    body: clipLines(lines, bodyH),
    actions: joinCommands([
      command("D", "Confirm delete", undefined, RED),
      command("Esc", "Cancel", undefined, GR),
    ]),
    secondary: target.kind === "run" ? `${D}run ${target.run.id}${R}` : `${D}${target.issue.rel}${R}`,
  };
}

function runDeleteLines(run: RunSummary): string[] {
  return [
    "",
    ` ${RED}${B}Delete run ${run.id}${R}`,
    "",
    ` ${D}Status:${R} ${run.status}   ${D}Agent:${R} ${run.agent}${run.mode ? `/${run.mode}` : ""}`,
    ` ${D}Request:${R} ${run.request.replace(/\s+/g, " ").slice(0, 100)}`,
    "",
    ...(isActiveStatus(run.status)
      ? [` ${Y}This run is active. It will be cancelled and stopped first.${R}`, ""]
      : []),
    ` ${D}This permanently deletes:${R}`,
    `   ${Y}•${R} the run record, events, transcript, and reports`,
    `   ${Y}•${R} its worktree when no other run shares it`,
    `   ${Y}•${R} its branch when no other run shares it`,
    "",
    ` ${RED}This cannot be undone.${R}`,
  ];
}

function issueDeleteLines(target: IssueDeleteTarget): string[] {
  const { issue, runs, activeRuns } = target;
  const blocked = activeRuns > 0;
  return [
    "",
    ` ${RED}${B}Delete issue ${issue.slug}${R}`,
    "",
    ` ${D}Kind:${R} ${ISSUE_KIND_LABELS[issue.kind]}   ${D}Status:${R} ${ISSUE_STATUS_LABELS[issue.status]}   ${D}Priority:${R} ${issue.priority}`,
    ` ${D}Review:${R} ${issue.review}   ${D}Verification:${R} ${issue.verification}   ${D}Runs:${R} ${runs}`,
    ` ${D}File:${R} ${issue.rel}`,
    ` ${D}Prompt:${R} ${trunc(issue.prompt.replace(/\s+/g, " "), 100)}`,
    "",
    ...(blocked
      ? [` ${RED}${activeRuns} run(s) are still active on this issue.${R}`, ` ${Y}Confirming is refused until they stop.${R}`, ""]
      : []),
    ` ${D}This permanently deletes:${R}`,
    `   ${Y}•${R} the issue file ${issue.rel}`,
    `   ${Y}•${R} branch mc/${issue.slug} and the branches its engineer/build runs created`,
    `   ${Y}•${R} both, in a planning commit that removes them from the tree`,
    "",
    blocked
      ? ` ${Y}Run records stay in the list; delete them separately.${R}`
      : ` ${RED}This cannot be undone.${R}`,
  ];
}
