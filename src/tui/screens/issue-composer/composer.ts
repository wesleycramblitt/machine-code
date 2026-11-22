/**
 * machine_code — issue composer render.
 *
 * Layout:
 *   Tags[t]:          (always visible)
 *   Keywords[w]:      (always visible)
 *   Depends[d]:       (always visible)
 *   Acceptance Gates[a]: (always visible, features/bugs only)
 *   Verification[v]:  (always visible, features/bugs only)
 *   Review[r]:        (always visible)
 *   ┌─ bordered prompt box ─┐
 *   └───────────────────────┘
 *   k Kind  p Priority                     Create[:!]
 *
 * The prompt and bottom bar are pinned to the bottom of the body area.
 * Back[Esc] is in the chrome header (red background).
 */
import {
  B, C, D, G, GR, M, R, RED, W, Y, START_BG, UPDATE_BG, WHITE,
  PURPLE_FG, YELLOW_FG, RED_FG, SKY_FG,
  command, commandBadge, fit, joinCommands, trunc, visible, wrapText,
} from "../../format.js";
import { withCursor } from "../../edit.js";
import type { IssueComposerFrame, IssueComposerProps } from "./types.js";

/**
 * Render an inline editable field line: `Label[key]: value`.
 *
 * `caret` is the cursor column inside `value` while the field is edited
 * inline, or null for a static line. While editing, the block is spliced at
 * the caret and long values are windowed so the block always stays visible.
 */
function fieldLine(key: string, label: string, value: string, caret: number | null, cols: number): string {
  const block = `${GR}▌${R}`;
  const prefix = ` ${B}${label}${R}[${C}${key}${R}]:`;
  const maxVal = Math.max(10, cols - visible(prefix) - 3);
  if (caret === null) {
    const display = value.trim() || `${D}(none)${R}`;
    return `${prefix}${trunc(display, maxVal)}`;
  }
  const at = Math.max(0, Math.min(value.length, caret));
  // A `maxVal - 1` value window keeps the block column at maxVal - 2 or
  // less, so trunc neither cuts the block nor replaces it with "…".
  const start = Math.max(0, at - (maxVal - 2));
  const end = Math.min(value.length, start + Math.max(1, maxVal - 1));
  const windowed = value.slice(start, end);
  const display = windowed === "" ? `${block}${D}(none)${R}` : withCursor(windowed, at - start, block);
  return `${prefix}${trunc(display, maxVal)}`;
}

export function renderIssueComposer(props: IssueComposerProps): IssueComposerFrame {
  const { cols, bodyH, theme, toast, settings, insert, cursor, confirm, fieldEdit, fieldCursor, editing } = props;
  const boxWidth = Math.max(20, cols - 2);
  const inner = Math.max(12, boxWidth - 2);

  // ── Above (field lines — scroll away when terminal is short) ──
  const above: string[] = [];
  above.push(fieldLine("t", "Tags", settings.tags, fieldEdit === "tags" ? fieldCursor : null, cols));
  above.push(fieldLine("w", "Keywords", settings.keywords, fieldEdit === "keywords" ? fieldCursor : null, cols));
  above.push(fieldLine("d", "Depends", settings.depends, fieldEdit === "depends" ? fieldCursor : null, cols));
  above.push(fieldLine("f", "Files", settings.files, fieldEdit === "files" ? fieldCursor : null, cols));
  above.push(fieldLine("a", "Acceptance Gates", settings.acceptance, fieldEdit === "acceptance" ? fieldCursor : null, cols));
  if (settings.kind !== "ideas" && settings.kind !== "references") {
    const verLabel = settings.verification.charAt(0).toUpperCase() + settings.verification.slice(1);
    above.push(fieldLine("v", "Verification", verLabel, fieldEdit === "verification" ? fieldCursor : null, cols));
  }
  above.push(fieldLine("r", "Review", settings.review === "human" ? "Human" : "None", fieldEdit === "review" ? fieldCursor : null, cols));

  // ── Block (pinned to bottom: prompt box + bottom bar) ──
  const block: string[] = [];

  // Prompt box
  const promptText = settings.prompt;
  const emptyPrompt = !promptText.trim() && !insert;

  let displayLines: string[];
  if (emptyPrompt) {
    displayLines = [` ${D}Edit body${R}[${C}e${R}]`];
  } else {
    displayLines = wrapText(withCursor(promptText, cursor, `${GR}▌${R}`), Math.max(8, inner - 3));
  }

  // Half the window body, sized from the window itself and never from the
  // text. Field lines above yield when the window is short (the screen clips
  // them); the box scrolls past half.
  const promptHeight = Math.max(3, Math.floor(bodyH * 0.5));
  // Keep the caret line visible: when it moves above the window bottom,
  // scroll the window up with it (tail-pin otherwise).
  let promptTop = Math.max(0, displayLines.length - promptHeight);
  const caretLine = displayLines.findIndex((line) => line.includes("▌"));
  if (caretLine >= 0) promptTop = Math.max(0, Math.min(caretLine, displayLines.length - promptHeight));
  const shownPrompt = displayLines.slice(promptTop, promptTop + promptHeight);

  block.push(
    ` ${D}┌${"─".repeat(inner)}┐${R}`,
    ...shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`),
    ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
    ` ${D}└${"─".repeat(inner)}┘${R}`,
  );

  // Bottom bar: Kind + Priority (left) · Create[:!] (right)
  const kindColor =
    settings.kind === "ideas" ? PURPLE_FG
    : settings.kind === "features" ? YELLOW_FG
    : settings.kind === "references" ? SKY_FG
    : RED_FG;
  const kindLabel = settings.kind.charAt(0).toUpperCase() + settings.kind.slice(1);
  const kindToken = command("k", "Kind", kindLabel, kindColor);

  const priorityColor = settings.priority === "low" ? D : settings.priority === "medium" ? G : RED;
  const priorityLabel = settings.priority.charAt(0).toUpperCase() + settings.priority.slice(1);
  const priorityToken = command("p", "Priority", priorityLabel, priorityColor);

  const editorToken = command("E", "Editor", undefined, M);
  const leftSide = joinCommands([kindToken, priorityToken, editorToken]);
  const createBadge = editing
    ? commandBadge("Update", ":!", UPDATE_BG, WHITE)
    : commandBadge("Create", ":!", START_BG, WHITE);
  const padWidth = Math.max(1, boxWidth - visible(leftSide) - visible(createBadge) - 2);
  block.push(` ${leftSide}${" ".repeat(padWidth)}${createBadge}`);
  // One extra blank line below for breathing room
  block.push("");

  return {
    body: [],
    actions: " ",
    secondary: toast ? `${Y}${toast}${R}` : confirm
      ? `${Y}discard unsaved issue? press y to discard and exit, esc to stay${R}`
      : "",
    bottomAlign: { above, block, filler: "" },
  };
}