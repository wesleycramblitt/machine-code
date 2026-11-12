/**
 * machine_code — issue composer render.
 *
 * A simple form: bordered prompt box at top, settings panel below, actions
 * footer. Mirrors the new-run composer's visual style.
 */
import {
  B, C, D, G, GR, M, R, RED, W, Y,
  command, dim, fit, joinCommands, trunc, visible, wrapText,
} from "../../format.js";
import { clipLines } from "../types.js";
import type { IssueComposerFrame, IssueComposerProps } from "./types.js";

export function renderIssueComposer(props: IssueComposerProps): IssueComposerFrame {
  const { cols, bodyH, theme, toast, settings, insert, confirm, fieldEdit } = props;
  const body: string[] = [];
  const panelWidth = Math.max(20, cols - 2);
  const inner = Math.max(12, panelWidth - 2);

  // ── Prompt box ──
  const promptText = settings.prompt;
  // Cursor shows at the end when editing
  const displayPrompt = wrapText(insert ? `${promptText}${GR}▌${R}` : promptText, Math.max(8, inner - 3));
  const emptyPrompt = !promptText.trim() && !insert;
  const promptLines = emptyPrompt ? [""] : displayPrompt;
  const promptHeight = Math.max(3, Math.min(12, Math.floor(bodyH * 0.45)));

  const shownPrompt = promptLines.slice(-promptHeight);
  const promptBox = [
    ` ${D}┌${"─".repeat(inner)}┐${R}`,
    ...(emptyPrompt
      ? [` ${D}│${R} ${D}${fit("Describe the problem or change in one paragraph...", inner - 2)}${R} ${D}│${R}`]
      : shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`)),
    ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
    ` ${D}└${"─".repeat(inner)}┘${R}`,
  ];
  body.push(...promptBox);

  // Prompt actions — matches new-run pattern
  const promptActions = insert
    ? joinCommands([
        command("Esc", "Done", undefined, Y),
        command("Enter", "Newline", undefined, G),
        command("Backspace", "Delete", undefined, M),
      ])
    : joinCommands([
        command("e", "Edit body", undefined, C),
      ]);
  // Actions sit right below the prompt box, above the settings
  body.push(` ${promptActions}`);

  // ── Settings panel ──
  const col1 = 12;
  body.push(` ${B}${W}Issue settings${R}`);
  const kindColor = settings.kind === "ideas" ? C : settings.kind === "features" ? G : RED;
  const kindLabel = settings.kind.charAt(0).toUpperCase() + settings.kind.slice(1);
  body.push(`  ${pad("Kind", col1)} ${kindColor}${kindLabel}${R} ${D}· ${C}k${D} cycle${R}`);
  const priorityColor = settings.priority === "low" ? D : settings.priority === "medium" ? G : RED;
  const priorityLabel = settings.priority.charAt(0).toUpperCase() + settings.priority.slice(1);
  body.push(`  ${pad("Priority", col1)} ${priorityColor}${priorityLabel}${R} ${D}· ${C}p${D} cycle${R}`);
  if (settings.kind !== "ideas") {
    const accDisplay = settings.acceptance ? dim(trunc(settings.acceptance, Math.max(20, cols - 34))) : `${D}(none)${R}`;
    const accHint = fieldEdit === "acceptance" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}a${D} edit${R}`;
    body.push(`  ${pad("Acceptance", col1)} ${accDisplay} ${accHint}`);
    const verLabel = settings.verification.charAt(0).toUpperCase() + settings.verification.slice(1);
    const verColor = settings.verification === "verified" ? G : D;
    body.push(`  ${pad("Verification", col1)} ${verColor}${verLabel}${R} ${D}· ${C}v${D} cycle${R}`);
  }
  const tagsDisplay = settings.tags ? dim(trunc(settings.tags, Math.max(20, cols - 34))) : `${D}(none)${R}`;
  const tagsHint = fieldEdit === "tags" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}t${D} edit${R}`;
  body.push(`  ${pad("Tags", col1)} ${tagsDisplay} ${tagsHint}`);
  const dependsDisplay = settings.depends ? dim(trunc(settings.depends, Math.max(20, cols - 34))) : `${D}(none)${R}`;
  const dependsHint = fieldEdit === "depends" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}d${D} edit${R}`;
  body.push(`  ${pad("Depends", col1)} ${dependsDisplay} ${dependsHint}`);
  const keywordsDisplay = settings.keywords ? dim(trunc(settings.keywords, Math.max(20, cols - 34))) : `${D}(none)${R}`;
  const kwHint = fieldEdit === "keywords" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}w${D} edit${R}`;
  body.push(`  ${pad("Keywords", col1)} ${keywordsDisplay} ${kwHint}`);

  // Fill to bodyH
  while (body.length < bodyH) body.push("");

  // ── Actions footer ──
  const actions = joinCommands([
    command(":!", "Create issue", undefined, RED),
    command("e", "Edit body", undefined, C),
    command("k", "Kind", undefined, M),
    command("p", "Priority", undefined, M),
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

function pad(text: string, width: number): string {
  const vis = text.length;
  return vis < width ? text + " ".repeat(width - vis) : text;
}