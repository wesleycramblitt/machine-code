/**
 * machine_code — issue composer render.
 *
 * Settings bar at top (Kind where Agent sits on the new-run page), bordered
 * prompt box below, action footer with red START_BG on Create.
 */
import {
  B, C, D, G, GR, M, R, RED, W, Y, START_BG, WHITE,
  command, commandBadge, dim, fit, joinCommands, trunc, visible, wrapText,
} from "../../format.js";
import { clipLines } from "../types.js";
import type { IssueComposerFrame, IssueComposerProps } from "./types.js";

export function renderIssueComposer(props: IssueComposerProps): IssueComposerFrame {
  const { cols, bodyH, theme, toast, settings, insert, confirm, fieldEdit } = props;
  const body: string[] = [];
  const panelWidth = Math.max(20, cols - 2);
  const inner = Math.max(12, panelWidth - 2);

  // ── Settings bar (top) ──
  // Kind in the same position as Agent on the new-run page
  const kindColor = settings.kind === "ideas" ? C : settings.kind === "features" ? G : RED;
  const kindLabel = settings.kind.charAt(0).toUpperCase() + settings.kind.slice(1);
  const kindToken = command("k", "Kind", kindLabel, kindColor);
  const priorityColor = settings.priority === "low" ? D : settings.priority === "medium" ? G : RED;
  const priorityLabel = settings.priority.charAt(0).toUpperCase() + settings.priority.slice(1);
  const priorityToken = command("p", "Priority", priorityLabel, priorityColor);

  // Conditional tokens — only for features/bugs
  const acceptanceToken = settings.kind !== "ideas" && settings.acceptance
    ? command("a", "Accept", trunc(settings.acceptance, 24), M)
    : settings.kind !== "ideas"
      ? command("a", "Accept", "", D)
      : "";
  const verificationLabel = settings.verification.charAt(0).toUpperCase() + settings.verification.slice(1);
  const verificationColor = settings.verification === "verified" ? G : D;
  const verificationToken = settings.kind !== "ideas"
    ? command("v", "Verify", verificationLabel, verificationColor)
    : "";

  // Tags / Depends / Keywords as compact tokens
  const tagsToken = settings.tags
    ? command("t", "Tags", trunc(settings.tags, 20), M)
    : "";
  const dependsToken = settings.depends
    ? command("d", "Depends", trunc(settings.depends, 16), M)
    : "";
  const keywordsToken = settings.keywords
    ? command("w", "Keywords", trunc(settings.keywords, 20), M)
    : "";

  // Build the settings line — wrap if it overflows
  const settingsTokens = [
    kindToken,
    priorityToken,
    acceptanceToken,
    verificationToken,
    tagsToken,
    dependsToken,
    keywordsToken,
  ].filter((t) => t !== "");

  const settingsLine = settingsTokens.length > 0
    ? ` ${joinCommands(settingsTokens)}`
    : ` ${D}press ${C}k${D} to choose issue kind${R}`;

  // When in field-edit mode, show the field hint above the box
  if (fieldEdit) {
    body.push(` ${GR}editing ${fieldEdit} · Enter to confirm, Esc to cancel${R}`);
  }
  body.push(settingsLine);
  body.push("");

  // ── Prompt box ──
  const promptText = settings.prompt;
  const displayPrompt = wrapText(insert ? `${promptText}${GR}▌${R}` : promptText, Math.max(8, inner - 3));
  const emptyPrompt = !promptText.trim() && !insert;
  let promptLines = emptyPrompt ? [""] : displayPrompt;
  const promptHeight = Math.max(3, Math.min(12, Math.floor(bodyH * 0.5)));

  const shownPrompt = promptLines.slice(-promptHeight);

  let promptBox: string[] = [];

  // Header badge
  if (insert) {
    promptBox.push(` ${D}┌${"─".repeat(inner)}┐${R}`);
    const left = ` ${D}│${R} ${W}${fit(shownPrompt[0] ?? "", inner - 2)}${R} ${D}│${R}`;
    if (shownPrompt.length > 1) {
      promptBox.push(left);
      for (let i = 1; i < shownPrompt.length; i++) {
        promptBox.push(` ${D}│${R} ${W}${fit(shownPrompt[i]!, inner - 2)}${R} ${D}│${R}`);
      }
    } else {
      promptBox.push(left);
    }
    const remaining = promptHeight - shownPrompt.length;
    for (let i = 0; i < remaining; i++) {
      promptBox.push(` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`);
    }
    promptBox.push(` ${D}└${"─".repeat(inner)}┘${R}`);
  } else {
    // Not editing — show placeholder or bordered prompt
    promptBox.push(` ${D}┌${"─".repeat(inner)}┐${R}`);
    if (emptyPrompt) {
      promptBox.push(` ${D}│${R} ${D}${fit("Describe the problem or change in one paragraph...", inner - 2)}${R} ${D}│${R}`);
      const remaining = promptHeight - 1;
      for (let i = 0; i < remaining; i++) {
        promptBox.push(` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`);
      }
    } else {
      for (let i = 0; i < shownPrompt.length; i++) {
        promptBox.push(` ${D}│${R} ${W}${fit(shownPrompt[i]!, inner - 2)}${R} ${D}│${R}`);
      }
      const remaining = promptHeight - shownPrompt.length;
      for (let i = 0; i < remaining; i++) {
        promptBox.push(` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`);
      }
    }
    promptBox.push(` ${D}└${"─".repeat(inner)}┘${R}`);
  }
  body.push(...promptBox);

  // Inline edit actions below the box — matches new-run page Agent/Ambiguity pattern
  if (insert) {
    body.push(` ${joinCommands([
      command("Esc", "Done", undefined, Y),
      command("Enter", "Newline", undefined, G),
      command("Backspace", "Delete", undefined, M),
    ])}`);
  } else {
    body.push(` ${joinCommands([
      command("e", "Edit body", undefined, C),
    ])}`);
  }

  // Fill to bodyH
  while (body.length < bodyH) body.push("");

  // ── Actions footer ──
  const actions = joinCommands([
    commandBadge("Create", ":!", START_BG, WHITE),
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