/**
 * machine_code — runs list screen.
 *
 * Pure render of the work tree (repository → kind → issue → runs, or
 * repository → status). Row focus dimming, issue tones, dependency
 * suffixes, dependency-chain gaps, and the pending-answer affordance live
 * here; the caller supplies the prebuilt index plus a pending-question
 * lookup.
 */
import { B, BL, C, D, DIM, G, GR, M, PURPLE_BG, R, RED, W, WHITE, Y, ago, agentTone, background, command, dim, fit, fmtMoney, fmtTokens, icon, joinCommands, pad, runIdFromEvent, selected, trunc, visible } from "../format.js";
import { RUN_GROUP_LABELS, repoLabel, type RunGroup, type RunIndex, type RunRow } from "../runs.js";
import type { RunSummary } from "../../state/runs.js";
import { windowedBody, type Viewport } from "./types.js";
import { ISSUE_STATUS_STYLE, KIND_BG, KIND_FG, issueTone } from "./tones.js";

export interface RunsListProps extends Viewport {
  runNarrow: boolean;
  index: RunIndex;
  selectedRow: RunRow | undefined;
  focus: Set<string> | null;
  group: RunGroup;
  reposScope: "all" | "cwd";
  /** Pending-question lookup for the awaiting-input affordance. */
  pendingFor: (run: RunSummary) => unknown;
  scroll: number;
}

export interface RunsListFrame {
  body: string[];
  actions: string;
  extraActions: string;
  secondary: string;
  scroll: number;
}

/** Priority is one color axis: red draws the eye, gray is neutral, dim recedes. */
const PRIORITY_TONE: Record<string, string> = { high: RED, medium: D, low: DIM };

/** Run slug as shown on the runs page, e.g. "RUN 739-aaas". */
function runSlugText(run: RunSummary): string {
  return `RUN ${runIdFromEvent(run)}`;
}

export function renderRunsList(props: RunsListProps): RunsListFrame {
  const { cols, narrow, runNarrow, bodyH, theme, toast, index, selectedRow, focus, group, reposScope, pendingFor } = props;
  const lines: string[] = [];
  const selectedId = selectedRow?.id;
  let selectedEndLine = lines.length;
  let prevKind: RunRow["kind"] | undefined;
  for (const row of index.rows) {
    // Deps view: one empty gap line before each dependency chain root (never
    // right under a section heading), so a chain reads as one connected
    // block and the next independent chain starts a new one. Gap lines carry
    // no text and are not cursor rows.
    if (row.kind === "issue" && row.chainStart === true && prevKind !== "section") lines.push("");
    const isSelected = row.id === selectedId;
    const indent = "  ".repeat(row.depth);
    const rendered: string[] = [];
    if (row.kind === "repo") {
      // Repos under orchestration wear a purple badge right after the name;
      // its width shrinks the cwd detail so the row stays on one line.
      const badge = row.orchestrating ? ` ${PURPLE_BG}${WHITE}Orchestrating…${R} ` : "";
      const text = ` ${row.collapsed ? "▸" : "▾"} ${B}${W}${row.label}${R}${badge}${narrow ? "" : `  ${D}${trunc(row.repoRoot, Math.max(20, cols - row.label.length - 16 - visible(badge)))}${R}`} ${D}(${row.count})${R}`;
      rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
    } else if (row.kind === "section") {
      // Kind headers: brand-color background hugging the text, bold black/white label + count.
      const kindBg = KIND_BG[row.tone];
      if (kindBg) {
        const text = ` ${indent}${kindBg}${B}\x1b[38;2;20;20;20m${row.collapsed ? "▸" : "▾"} ${row.label}  (${row.count})${R}`;
        rendered.push(isSelected ? selected(text, true) : text);
      } else {
        const sectionFg = `${B}${theme.sectionFg}`;
        const text = ` ${indent}${sectionFg}${row.collapsed ? "▸" : "▾"} ${row.label}${R} ${D}(${row.count})${R}`;
        rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
      }
    } else if (row.kind === "issue") {
      // Todo/needs-research slugs use the kind's brand color. All other statuses use their status color.
      const style = ISSUE_STATUS_STYLE[row.effective];
      const slugTone = issueTone(row.status, row.itemKind);
      const folded = row.collapsible ? `${row.collapsed ? "▸" : "▾"} ` : "";
      const review = row.review !== "none" ? ` ${D}· review ${row.review}${R}` : "";
      const priorityTone = PRIORITY_TONE[row.priority] ?? D;
      const priority = row.priority && row.priority !== "medium" ? ` ${priorityTone}· ${row.priority}${R}` : "";
      // One dim dependency suffix after priority/review: a slug naming no
      // issue shows as unknown (a typo is not waiting on real work), the rest
      // as blocked. Clean rows stay clean.
      const blockedBy = row.blockedBy ?? [];
      const unknownDeps = row.unknownDeps ?? [];
      let depText = "";
      if (unknownDeps.length === 1) depText = `· unknown dep ${unknownDeps[0]}`;
      else if (unknownDeps.length > 1) depText = `· unknown deps ${unknownDeps.length}`;
      else if (blockedBy.length === 1) depText = `· blocked by ${blockedBy[0]}`;
      else if (blockedBy.length > 1) depText = `· blocked by ${blockedBy.length}`;
      const deps = depText ? ` ${D}${depText}${R}` : "";
      const title = row.title
        ? ` ${D}— ${trunc(row.title, Math.max(12, cols - indent.length - row.slug.length - 25 - depText.length))}${R}`
        : "";
      // Blocked issues recede: the row body is dimmed (dim keeps any
      // background fills) while the glyph keeps the red blocked tone, so a
      // blocked issue reads as the dimmed, red-marked outlier.
      const rest = `${slugTone}${row.slug}${R}${priority}${review}${deps}${title}`;
      const text = ` ${indent}${folded}${slugTone}${style.glyph}${R} ${row.effective === "blocked" ? dim(rest) : rest}`;
      rendered.push(selected(text, isSelected));
    } else {
      const run = row.run;
      const ask = run.status === "awaiting_input" ? ` ${Y}ASK${R}` : "";
      const reason = run.stopReason && run.stopReason !== "completed" ? ` ${D}${run.stopReason}${R}` : "";
      const repoTag = "";
      const right = cols < 50
        ? `${D}${fmtTokens(run.usage.totalTokens)} · ${ago(run.lastActivityAt)}${R}`
        : `${D}${fmtTokens(run.usage.totalTokens)} tok · ${fmtMoney(run.cost.actual)} · ${ago(run.lastActivityAt)}${R}`;
      if (runNarrow) {
        const identity = `${indent}  ${icon(run.status)} ${D}${runSlugText(run)}${R}${ask}${reason}`;
        rendered.push(selected(` ${trunc(identity, Math.max(12, cols - visible(right) - 2))} ${right}`, isSelected));
        const agent = `${agentTone(run.agent)}${run.agent}${R}${repoTag}`;
        const request = run.request.replace(/\s+/g, " ").slice(0, 60);
        const detail = `${agent} ${D}${request}${R}`;
        rendered.push(selected(` ${indent}      ${trunc(detail, Math.max(12, cols - indent.length - 8))}`, isSelected));
      } else {
        const left = `${indent}  ${icon(run.status)} ${D}${runSlugText(run)}${R} ${agentTone(run.agent)}${run.agent}${R}${repoTag}${ask}${reason}`;
        const context = `  ${D}${run.request.replace(/\s+/g, " ").slice(0, 60)}${R}`;
        rendered.push(selected(` ${pad(left, Math.max(30, cols - visible(right) - visible(context) - 2))}${context}${right}`, isSelected));
      }
    }
    if (focus && !focus.has(row.id) && row.kind === "run") {
      for (let i = 0; i < rendered.length; i++) rendered[i] = dim(rendered[i]!);
    }
    if (isSelected) {
      selectedEndLine = lines.length + rendered.length - 1;
    }
    lines.push(...rendered);
    prevKind = row.kind;
  }
  if (index.rows.length === 0) {
    lines.push("");
    lines.push(` ${D}No runs here yet. Press ${C}n${R}${D} to start one.${R}`);
  }
  const w = windowedBody(lines, Math.min(selectedEndLine, Math.max(0, lines.length - 1)), props.scroll, bodyH);
  const selectedListRow = selectedRow && selectedRow.kind === "run" ? selectedRow : undefined;
  const selectedPending =
    selectedListRow && selectedListRow.run.status === "awaiting_input"
      ? pendingFor(selectedListRow.run)
      : null;
  const answerAction = selectedPending ? [command("a", "Answer", undefined, Y)] : [];
  return {
    ...w,
    actions: narrow
      ? joinCommands([
          command("n", "New", undefined, C),
          command("I", "Issue", undefined, RED),
          command("Enter", "Open", undefined, G),
          ...answerAction,
          command("space", "Fold", undefined, Y),
          command("j/k", "Move", undefined, M),
          command("/", "Search", undefined, BL),
        ])
      : joinCommands([
          command("n", "New run", undefined, C),
          command("I", "New issue", undefined, RED),
          command("Enter", "Open", undefined, G),
          ...answerAction,
          command("space", "Fold", undefined, Y),
          command("j/k", "Move", undefined, M),
          command("/", "Search", undefined, BL),
        ]),
    extraActions: joinCommands([
      command("g", "Group", RUN_GROUP_LABELS[group], C),
      command("f", "Repos", reposScope === "all" ? "all" : "cwd", M),
      command("D", "Delete", undefined, RED),
    ]),
    secondary: toast ? `${Y}${toast}${R}` : "",
  };
}
