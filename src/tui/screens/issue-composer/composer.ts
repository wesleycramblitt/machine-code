/**
 * machine_code — issue composer render.
 *
 * Layout (top to bottom):
 *   editable text fields (tags, depends, keywords) — per-line above prompt
 *   bordered prompt box — first line is the edit-body hint
 *   Create badge right-aligned below the box
 *   kind + priority + acceptance + verification bar
 */
import {
  B, C, D, G, GR, M, R, RED, W, Y, START_BG, WHITE,
  command, commandBadge, dim, fit, joinCommands, trunc, visible, wrapText,
} from "../../format.js";
import { clipLines } from "../types.js";
import type { IssueComposerFrame, IssueComposerProps } from "./types.js";

/** Render an inline editable field line: `Label[key]: value▌` */
function fieldLine(key: string, label: string, value: string, isEditing: boolean, cols: number): string {
  const prefix = ` ${B}${label}${R}[${C}${key}${R}]:${isEditing ? `${GR}▌${R}` : " "}`;
  const display = value.trim() || (isEditing ? "" : `${D}(none)${R}`);
  // Cap the value to avoid overflow
  const maxVal = Math.max(10, cols - visible(prefix) - 3);
  const val = trunc(display, maxVal);
  return `${prefix}${val}`;
}

export function renderIssueComposer(props: IssueComposerProps): IssueComposerFrame {
  const { cols, bodyH, theme, toast, settings, insert, confirm, fieldEdit } = props;
  const body: string[] = [];
  const boxWidth = Math.max(20, cols - 2);
  const inner = Math.max(12, boxWidth - 2);

  // ── Editable text fields above the prompt ──
  // Shown when they have content or are being edited.
  const showTags = settings.tags.trim() || fieldEdit === "tags";
  const showDepends = settings.depends.trim() || fieldEdit === "depends";
  const showKeywords = settings.keywords.trim() || fieldEdit === "keywords";

  if (showTags) body.push(fieldLine("t", "Tags", settings.tags, fieldEdit === "tags", cols));
  if (showDepends) body.push(fieldLine("d", "Depends", settings.depends, fieldEdit === "depends", cols));
  if (showKeywords) body.push(fieldLine("w", "Keywords", settings.keywords, fieldEdit === "keywords", cols));
  if (showTags || showDepends || showKeywords) body.push("");

  // ── Prompt box ──
  const promptText = settings.prompt;
  const emptyPrompt = !promptText.trim() && !insert;

  // Build prompt lines for display (with cursor in insert mode)
  let displayLines: string[];
  if (insert) {
    displayLines = wrapText(`${promptText}${GR}▌${R}`, Math.max(8, inner - 3));
  } else if (emptyPrompt) {
    displayLines = [` ${D}e Edit body${R}`];
  } else {
    displayLines = wrapText(promptText, Math.max(8, inner - 3));
  }

  const promptHeight = Math.max(3, Math.min(12, Math.floor(bodyH * 0.45)));
  const shownPrompt = displayLines.slice(-promptHeight);

  const promptBox = [
    ` ${D}┌${"─".repeat(inner)}┐${R}`,
    ...shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`),
    ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
    ` ${D}└${"─".repeat(inner)}┘${R}`,
  ];
  body.push(...promptBox);

  // ── Create[:!] right-aligned below the box ──
  const createBadge = commandBadge("Create", ":!", START_BG, WHITE);
  // When in insert mode, show edit keys on the left, Create on the right
  if (insert) {
    const editKeys = joinCommands([
      command("Esc", "Done", undefined, Y),
      command("Enter", "Newline", undefined, G),
      command("Backspace", "Delete", undefined, M),
    ]);
    const padWidth = Math.max(1, boxWidth - visible(editKeys) - visible(createBadge) - 2);
    body.push(` ${editKeys}${" ".repeat(padWidth)}${createBadge}`);
  } else {
    const padWidth = Math.max(1, boxWidth - visible(createBadge));
    body.push(` ${" ".repeat(padWidth)}${createBadge}`);
  }
  body.push("");

  // ── Kind + Priority + Acceptance + Verification token bar ──
  const kindColor = settings.kind === "ideas" ? C : settings.kind === "features" ? G : RED;
  const kindLabel = settings.kind.charAt(0).toUpperCase() + settings.kind.slice(1);
  const kindToken = command("k", "Kind", kindLabel, kindColor);

  const priorityColor = settings.priority === "low" ? D : settings.priority === "medium" ? G : RED;
  const priorityLabel = settings.priority.charAt(0).toUpperCase() + settings.priority.slice(1);
  const priorityToken = command("p", "Priority", priorityLabel, priorityColor);

  const tokens = [kindToken, priorityToken];

  if (settings.kind !== "ideas") {
    const accLabel = settings.acceptance.trim() ? trunc(settings.acceptance, 28) : "none";
    const accToken = command("a", "Accept", accLabel, M);
    tokens.push(accToken);

    const verLabel = settings.verification.charAt(0).toUpperCase() + settings.verification.slice(1);
    const verColor = settings.verification === "verified" ? G : D;
    tokens.push(command("v", "Verify", verLabel, verColor));
  }

  body.push(` ${joinCommands(tokens)}`);

  // ── Fill ──
  while (body.length < bodyH) body.push("");

  // ── Footer actions ──
  const actions = joinCommands([
    commandBadge("Create", ":!", START_BG, WHITE),
    command("e", "Edit body", undefined, C),
    command("k", "Kind", undefined, M),
    command("p", "Priority", undefined, M),
    command("a", "Acceptance", undefined, M),
    command("v", "Verification", undefined, M),
    command("t", "Tags", undefined, M),
    command("d", "Depends", undefined, M),
    command("w", "Keywords", undefined, M),
    command("Esc", "Back", undefined, GR),
  ]);

  return {
    body: clipLines(body, bodyH),
    actions,
    secondary: toast ? `${Y}${toast}${R}` : confirm
      ? `${Y}discard unsaved issue? press y to discard and exit, esc to stay${R}`
      : "",
  };
}