/**
 * machine_code — run detail screen contract.
 *
 * Props in, frame out. The TUI root owns scroll/cursor state and passes it
 * down; the screen returns updated offsets alongside the rendered body.
 * Section navigation labels live here so list and detail agree.
 */
import type { Layout } from "../../../paths.js";
import type { RunEvent, RunSummary } from "../../../state/runs.js";
import type { ChangeSummary } from "../../../report/run.js";
import type { UiTheme } from "../../format.js";

export type RunSection = "overview" | "timeline" | "processes" | "thinking" | "changes" | "related" | "context";

export const RUN_SECTIONS: RunSection[] = ["overview", "timeline", "processes", "thinking", "changes", "related", "context"];

export const RUN_SECTION_LABEL: Record<RunSection, string> = {
  overview: "Overview",
  timeline: "Timeline",
  processes: "Processes",
  thinking: "Thinking",
  changes: "Changes",
  related: "Related",
  context: "Context",
};

export interface RunDetailData {
  layout: Layout;
  summary: RunSummary;
  events: RunEvent[];
  dir: string;
}

export interface RunDetailProps {
  cols: number;
  /** Compact viewport: fewer status lines in the overview. */
  short: boolean;
  bodyH: number;
  theme: UiTheme;
  detail: RunDetailData;
  /** Repo-scoped run list for the related-runs panel. */
  scopedRuns: RunSummary[];
  section: RunSection;
  runScroll: number;
  processSel: number;
  processFollow: boolean;
  /** Line index into the rendered timeline (the cursor row). */
  eventSel: number;
  /** Event index under the cursor row, computed each render. */
  eventCursor: number;
  timelineFollow: boolean;
  timelineVerbose: boolean;
  thinkingScroll: number;
  thinkingFollow: boolean;
  childSel: number;
  /** Selected changed-file row in the changes section (index into ChangeSummary.files). */
  changeSel: number;
  /** Index of the changed file whose full diff is open (null = file list). */
  changeOpen: number | null;
  expanded: ReadonlySet<string>;
  /** Cached worktree change summary for the detail's run. */
  changes: ChangeSummary;
  /** Filesystem/LSP health tokens for the footer. */
  mapTokens: (root: string) => string[];
}

export interface RunDetailFrame {
  body: string[];
  runCwd: string;
  runHints: string;
  footerMapTokens: string[];
  footerCtx: string;
  runScroll: number;
  processSel: number;
  eventSel: number;
  eventCursor: number;
  thinkingScroll: number;
  childSel: number;
  changeSel: number;
  changeOpen: number | null;
}
