/**
 * machine_code — issue composer render.
 *
 * Layout:
 *   Tags[t]:          (always visible)
 *   Keywords[w]:      (always visible)
 *   Depends[d]:       (always visible)
 *   Acceptance Gates[a]: (always visible, features/bugs only)
 *   ┌─ bordered prompt box ─┐
 *   └───────────────────────┘
 *   k Kind  p Priority  v Verify          Create[:!]
 *
 * Back[Esc] is in the chrome header (red background).
 */
import {
  B, C, D, G, GR, M, R, RED, W, Y, START_BG, WHITE,
  command, commandBadge, dim, fit, joinCommands, trunc, visible, wrapText,
} from "../../format.js";
import { clipLines } from "../types.js";
import type { IssueComposerFrame, IssueComposerProps } from "./types.js";

/** Render an inline editable field line: `Label[key]: value` */
function fieldLine(key: string, label: string, value: string, isEditing: boolean, cols: number): string {
  const cursor = isEditing ? `${GR}▌${R}` : "";
  const prefix = ` ${B}${label}${R}[${C}${key}${R}]:${cursor}`;
  const display = value.trim() || `${D}(none)${R}`;
  const maxVal = Math.max(10, cols - visible(prefix) - 3);
  return `${prefix}${trunc(display, maxVal)}`;
}

export function renderIssueComposer(props: IssueComposerProps): IssueComposerFrame {
  const { cols, bodyH, theme, toast, settings, insert, confirm, fieldEdit } = props;
  const body: string[] = [];
  const boxWidth = Math.max(20, cols - 2);
  const inner = Math.max(12, boxWidth - 2);

  // ── Editable text fields — always visible ──
  body.push(fieldLine("t", "Tags", settings.tags, fieldEdit === "tags", cols));
  body.push(fieldLine("w", "Keywords", settings.keywords, fieldEdit === "keywords", cols));
  body.push(fieldLine("d", "Depends", settings.depends, fieldEdit === "depends", cols));
  if (settings.kind !== "ideas") {
    body.push(fieldLine("a", "Acceptance Gates", settings.acceptance, fieldEdit === "acceptance", cols));
  }
  body.push("");

  // ── Prompt box ──
  const promptText = settings.prompt;
  const emptyPrompt = !promptText.trim() && !insert;

  let displayLines: string[];
  if (insert) {
    displayLines = wrapText(`${promptText}${GR}▌${R}`, Math.max(8, inner - 3));
  } else if (emptyPrompt) {
    displayLines = [` ${D}Edit body${R}[${C}e${R}]`];
  } else {
    displayLines = wrapText(promptText, Math.max(8, inner - 3));
  }

  const promptHeight = Math.max(3, Math.min(14, Math.floor(bodyH * 0.5)));
  const shownPrompt = displayLines.slice(-promptHeight);

  body.push(
    ` ${D}┌${"─".repeat(inner)}┐${R}`,
    ...shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`),
    ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
    ` ${D}└${"─".repeat(inner)}┘${R}`,
  );

  // ── Bottom bar: Kind + Priority + Verify + Review (left) · Create[:!] (right) ──
  const kindColor = settings.kind === "ideas" ? C : settings.kind === "features" ? G : RED;
  const kindLabel = settings.kind.charAt(0).toUpperCase() + settings.kind.slice(1);
  const kindToken = command("k", "Kind", kindLabel, kindColor);

  const priorityColor = settings.priority === "low" ? D : settings.priority === "medium" ? G : RED;
  const priorityLabel = settings.priority.charAt(0).toUpperCase() + settings.priority.slice(1);
  const priorityToken = command("p", "Priority", priorityLabel, priorityColor);

  const leftTokens = [kindToken, priorityToken];

  if (settings.kind !== "ideas") {
    const verLabel = settings.verification.charAt(0).toUpperCase() + settings.verification.slice(1);
    const verColor = settings.verification === "verified" ? G : D;
    leftTokens.push(command("v", "Verify", verLabel, verColor));
  }

  const reviewColor = settings.review === "human" ? RED : D;
  leftTokens.push(command("r", "Review", settings.review === "human" ? "Human" : "None", reviewColor));

  const leftSide = joinCommands(leftTokens);
  const createBadge = commandBadge("Create", ":!", START_BG, WHITE);
  const padWidth = Math.max(1, boxWidth - visible(leftSide) - visible(createBadge) - 2);
  body.push(` ${leftSide}${" ".repeat(padWidth)}${createBadge}`);

  while (body.length < bodyH) body.push("");

  return {
    body: clipLines(body, bodyH),
    actions: " ",
    secondary: toast ? `${Y}${toast}${R}` : confirm
      ? `${Y}discard unsaved issue? press y to discard and exit, esc to stay${R}`
      : "",
  };
}