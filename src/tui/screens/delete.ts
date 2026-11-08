/**
 * machine_code — run delete confirmation screen.
 *
 * Pure render of the delete-run confirmation. Returns null when there is no
 * deletion target so the router can fall back to the previous screen.
 */
import { B, D, GR, R, RED, Y, command, joinCommands } from "../format.js";
import { isActiveStatus, type RunSummary } from "../../state/runs.js";
import { clipLines } from "./types.js";

export interface DeleteFrame {
  body: string[];
  actions: string;
  secondary: string;
}

export function renderDeleteConfirm(run: RunSummary | undefined, bodyH: number): DeleteFrame | null {
  if (!run) return null;
  const lines = [
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
  return {
    body: clipLines(lines, bodyH),
    actions: joinCommands([
      command("D", "Confirm delete", undefined, RED),
      command("Esc", "Cancel", undefined, GR),
    ]),
    secondary: `${D}run ${run.id}${R}`,
  };
}
