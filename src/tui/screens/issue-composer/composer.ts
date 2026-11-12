/**
 * machine_code — issue composer render.
 *
 * A simple form: prompt box at top, settings panel below, actions footer.
 * No context tabs, model picker, or preview.
 */
import {
  B, C, D, G, GR, M, R, RED, W, Y,
  command, dim, joinCommands, trunc,
} from "../../format.js";
import { clipLines } from "../types.js";
import type { IssueComposerFrame, IssueComposerProps } from "./types.js";

export function renderIssueComposer(props: IssueComposerProps): IssueComposerFrame {
  const { cols, bodyH, theme, toast, settings, insert, confirm, fieldEdit } = props;
  const lines: string[] = [];
  const maxBody = Math.max(3, Math.floor(bodyH * 0.55));

  // ── Prompt box ──
  const editHint = insert
    ? `${GR}(edit mode)${R}`
    : fieldEdit
      ? `${GR}(editing ${fieldEdit})${R}`
      : `${D}· edit with ${C}e${D}/${C}Esc${R}`;
  lines.push(` ${B}${W}Issue body${R} ${editHint}`);
  lines.push("");
  const promptLines = settings.prompt ? settings.prompt.split("\n") : [""];
  const emptyPrompt = !settings.prompt.trim();
  if (emptyPrompt) {
    lines.push(` ${D}Describe the problem or change in one paragraph...${R}`);
  } else {
    const shown = promptLines.slice(0, maxBody - 4).map((line) => ` ${line}`);
    lines.push(...shown);
  }
  lines.push("");
  // Fill remaining prompt area
  while (lines.length < Math.min(maxBody, bodyH - 10)) lines.push("");

  // ── Settings panel ──
  const col1 = 12;
  const kindColor = settings.kind === "ideas" ? C : settings.kind === "features" ? G : RED;
  const kindLabel = settings.kind.charAt(0).toUpperCase() + settings.kind.slice(1);
  lines.push(` ${B}${W}Issue settings${R}`);
  lines.push(`  ${pad("Kind", col1)} ${kindColor}${kindLabel}${R} ${D}· ${C}k${D} cycle${R}`);
  const priorityColor = settings.priority === "low" ? D : settings.priority === "medium" ? G : RED;
  const priorityLabel = settings.priority.charAt(0).toUpperCase() + settings.priority.slice(1);
  lines.push(`  ${pad("Priority", col1)} ${priorityColor}${priorityLabel}${R} ${D}· ${C}p${D} cycle${R}`);
  if (settings.kind !== "ideas") {
    const accDisplay = settings.acceptance ? dim(trunc(settings.acceptance, Math.max(20, cols - 34))) : `${D}(none)${R}`;
    const accEdit = fieldEdit === "acceptance" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}a${D} edit${R}`;
    lines.push(`  ${pad("Acceptance", col1)} ${accDisplay} ${accEdit}`);
    const verLabel = settings.verification.charAt(0).toUpperCase() + settings.verification.slice(1);
    const verColor = settings.verification === "verified" ? G : D;
    lines.push(`  ${pad("Verification", col1)} ${verColor}${verLabel}${R} ${D}· ${C}v${D} cycle${R}`);
  }
  const tagsDisplay = settings.tags ? dim(trunc(settings.tags, Math.max(20, cols - 34))) : `${D}(none)${R}`;
  const tagsEdit = fieldEdit === "tags" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}t${D} edit${R}`;
  lines.push(`  ${pad("Tags", col1)} ${tagsDisplay} ${tagsEdit}`);
  const dependsDisplay = settings.depends ? dim(trunc(settings.depends, Math.max(20, cols - 34))) : `${D}(none)${R}`;
  const dependsEdit = fieldEdit === "depends" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}d${D} edit${R}`;
  lines.push(`  ${pad("Depends", col1)} ${dependsDisplay} ${dependsEdit}`);
  const keywordsDisplay = settings.keywords ? dim(trunc(settings.keywords, Math.max(20, cols - 34))) : `${D}(none)${R}`;
  const kwEdit = fieldEdit === "keywords" ? `${GR}· edit, Enter done${R}` : `${D}· ${C}w${D} edit${R}`;
  lines.push(`  ${pad("Keywords", col1)} ${keywordsDisplay} ${kwEdit}`);

  // Fill to bodyH
  while (lines.length < bodyH) lines.push("");

  // ── Actions ──
  const actions = joinCommands([
    command(":!", "Create issue", undefined, RED),
    command("e", "Edit body", undefined, C),
    command("k", "Kind", undefined, M),
    command("p", "Priority", undefined, M),
    command("Esc", "Back", undefined, GR),
  ]);

  return {
    body: clipLines(lines, bodyH),
    actions,
    secondary: toast ? `${Y}${toast}${R}` : confirm
      ? `${Y}discard unsaved issue? press y to discard and exit, esc to stay${R}`
      : "",
  };
}

function pad(text: string, width: number): string {
  const visible = text.length;
  return visible < width ? text + " ".repeat(width - visible) : text;
}