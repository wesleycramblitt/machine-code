/**
 * machine_code — correct screen (fork a corrective child run).
 *
 * Pure render of the correction input box plus the parent worktree note.
 */
import { B, C, D, G, GR, R, RED, W, command, fit, joinCommands, wrapText } from "../format.js";
import { clipLines } from "./types.js";

export interface CorrectProps {
  cols: number;
  bodyH: number;
  correctText: string;
  parentId: string | null;
  parentWorktree: boolean;
}

export interface CorrectFrame {
  body: string[];
  actions: string;
  secondary: string;
}

export function renderCorrect(props: CorrectProps): CorrectFrame {
  const { cols, bodyH, correctText, parentId, parentWorktree } = props;
  const width = Math.max(20, cols - 8);
  const lines = [
    "",
    ` ${D}This interrupts the current run and starts a fresh child with the parent's${R}`,
    ` ${D}context, and worktree changes. The new run sees only the correction, not the old transcript.${R}`,
    "",
    ` ${B}${C}Correction${R}`,
    ` ${D}┌${"─".repeat(width)}┐${R}`,
  ];
  const wrapped = wrapText(correctText || "(describe the correction; Enter starts the child run)", width - 2);
  const boxHeight = Math.max(1, Math.min(bodyH - 9, 7));
  for (let i = 0; i < boxHeight; i++) lines.push(` ${D}│${R} ${W}${fit(wrapped[i] ?? "", width - 2)}${R} ${D}│${R}`);
  lines.push(` ${D}└${"─".repeat(width)}┘${R}`);
  if (parentId) lines.push(` ${D}parent ${parentId} · ${parentWorktree ? "inheriting worktree" : "no worktree"}${R}`);
  return {
    body: clipLines(lines, bodyH),
    actions: joinCommands([
      command("Enter", "Start run", undefined, G),
      command("Esc", "Cancel", undefined, GR),
      command("i", "Interrupt", undefined, RED),
    ]),
    secondary: `${D}Esc returns to the run; use i when you only want to stop it${R}`,
  };
}
