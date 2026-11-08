/**
 * machine_code — runs list screen.
 *
 * Pure render of the run hierarchy (repository → category → packet → runs,
 * or repository → status). Row focus dimming, packet tones, the pending-answer
 * affordance, and footer commands all live here; the caller supplies the
 * prebuilt index plus a pending-question lookup.
 */
import { B, BL, C, D, G, GR, M, R, RED, W, Y, ago, agentTone, background, command, dim, fit, fmtMoney, fmtTokens, icon, joinCommands, pad, runIdFromEvent, selected, trunc, visible } from "../format.js";
import { RUN_GROUP_LABELS, repoLabel, type RunGroup, type RunIndex, type RunRow } from "../runs.js";
import type { RunSummary } from "../../state/runs.js";
import { windowedBody, type Viewport } from "./types.js";

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

/** Shared status glyph + color. Always render the name too, not color alone. */
function statusStyle(status: "todo" | "in-progress" | "blocked" | "done"): { tone: string; glyph: string } {
  switch (status) {
    case "in-progress":
      return { tone: C, glyph: "●" };
    case "blocked":
      return { tone: Y, glyph: "⏸" };
    case "done":
      return { tone: G, glyph: "✓" };
    default:
      return { tone: W, glyph: "○" };
  }
}

export function renderRunsList(props: RunsListProps): RunsListFrame {
  const { cols, narrow, runNarrow, bodyH, theme, toast, index, selectedRow, focus, group, reposScope, pendingFor } = props;
  const lines: string[] = [];
  const selectedId = selectedRow?.id;
  let selectedEndLine = lines.length;
  for (const row of index.rows) {
    const isSelected = row.id === selectedId;
    const indent = "  ".repeat(row.depth);
    const rendered: string[] = [];
    if (row.kind === "repo") {
      const text = ` ${row.collapsed ? "▸" : "▾"} ${B}${W}${row.label}${R}${narrow ? "" : `  ${D}${trunc(row.repoRoot, Math.max(20, cols - row.label.length - 16))}${R}`} ${D}(${row.count})${R}`;
      rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
    } else if (row.kind === "section") {
      const tone = row.tone === "status" ? Y : row.tone === "orphaned" ? Y : GR;
      const text = ` ${indent}${B}${theme.sectionFg}${tone}${row.collapsed ? "▸" : "▾"} ${row.label}${R} ${D}(${row.count})${R}`;
      rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
    } else if (row.kind === "planline") {
      // Status is both color-encoded and spelled out: color alone is easy to
      // miss and inaccessible. A linked packet's status wins when it is
      // further along than the checkbox.
      const style = statusStyle(row.status);
      const badge = `${B}${style.tone}[${row.status}]${R}`;
      const title = row.title
        ? ` ${D}— ${trunc(row.title, Math.max(12, cols - indent.length - row.slug.length - row.status.length - 21))}${R}`
        : "";
      const text = ` ${indent}${style.tone}${style.glyph}${R} ${badge} ${style.tone}${row.slug}${R}${title}`;
      rendered.push(selected(text, isSelected));
    } else if (row.kind === "packet") {
      const status = row.packet.status;
      const style = statusStyle(status);
      const badge = `${B}${style.tone}[${status}]${R}`;
      const left = `${indent}${row.collapsible ? (row.collapsed ? "▸" : "▾") : " "} ${style.tone}${style.glyph}${R} ${badge} ${style.tone}${row.slug}${R}`;
      const runs = row.directRuns > 0 ? `${D}${row.directRuns} run${row.directRuns === 1 ? "" : "s"}${R}` : "";
      const detail = `${D}${trunc(row.packet.deliverable, Math.max(12, cols - indent.length - 34))}${R}`;
      const text = ` ${pad(left, Math.max(20, cols - visible(`${runs}  ${detail}`) - 2))}${runs}  ${detail}`;
      rendered.push(selected(text, isSelected));
    } else {
      const run = row.run;
      const ask = run.status === "awaiting_input" ? ` ${Y}ASK${R}` : "";
      const pr = run.prNumber ? ` ${D}PR#${run.prNumber} ${run.prState ?? ""}${R}` : "";
      const reason = run.stopReason && run.stopReason !== "completed" ? ` ${D}${run.stopReason}${R}` : "";
      const repoTag = group === "overall" ? ` ${D}[${repoLabel(run.repoRoot)}]${R}` : "";
      const right = cols < 50
        ? `${D}${fmtTokens(run.usage.totalTokens)} · ${ago(run.lastActivityAt)}${R}`
        : `${D}${fmtTokens(run.usage.totalTokens)} tok · ${fmtMoney(run.cost.actual)} · ${ago(run.lastActivityAt)}${R}`;
      if (runNarrow) {
        const identity = `${indent}  ${icon(run.status)} ${D}${runIdFromEvent(run)}${R}${ask}${pr}${reason}`;
        rendered.push(selected(` ${trunc(identity, Math.max(12, cols - visible(right) - 2))} ${right}`, isSelected));
        const agent = `${agentTone(run.agent)}${run.agent}${R}${run.mode ? `/${run.mode}` : ""}${repoTag}`;
        const request = run.request.replace(/\s+/g, " ").slice(0, 60);
        const detail = `${agent} ${D}${request}${R}`;
        rendered.push(selected(` ${indent}      ${trunc(detail, Math.max(12, cols - indent.length - 8))}`, isSelected));
      } else {
        const left = `${indent}  ${icon(run.status)} ${D}${runIdFromEvent(run)}${R} ${agentTone(run.agent)}${run.agent}${R}${run.mode ? `/${run.mode}` : ""}${repoTag}${ask}${pr}${reason}`;
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
          command("Enter", "Open", undefined, G),
          ...answerAction,
          command("space", "Fold", undefined, Y),
          command("j/k", "Move", undefined, M),
          command("/", "Search", undefined, BL),
        ])
      : joinCommands([
          command("n", "New run", undefined, C),
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
