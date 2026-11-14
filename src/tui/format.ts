/**
 * machine_code — shared TUI formatting primitives.
 *
 * Pure string/ANSI helpers with no filesystem, model, or run-state access.
 * Every screen (runs list, run detail, issue detail, composer, models,
 * spend, settings) renders through these so tone, truncation, and command
 * tokens stay consistent.
 *
 * UI contract:
 * - `visible()` is the single ANSI-aware width measure; `trunc`/`fit`/`pad`
 *   are the only width enforcers.
 * - Colors are module constants (B/D/R/C/…) so screens never inline escapes.
 * - `command()` / `commandBadge()` / `joinCommands()` build every footer.
 */
import { DEFAULT_THEME, type ThemeConfig } from "../config.js";
import type { CatalogueRow } from "../catalogue/types.js";
import type { AvailabilityState } from "../availability.js";
import type { RunEvent, RunSummary } from "../state/runs.js";

/* ------------------------------------------------------- terminal control */

export const ALT = "\x1b[?1049h";
export const ALT_L = "\x1b[?1049l";
export const HOME = "\x1b[H";
export const CLEAR_BELOW = "\x1b[J";
export const HIDE = "\x1b[?25l";
export const SHOW = "\x1b[?25h";
export const SYNC_ON = "\x1b[?2026h";
export const SYNC_OFF = "\x1b[?2026l";

export const B = "\x1b[1m";
/** Secondary text: an explicit mid-gray reads far better than SGR faint on dark themes. */
export const D = "\x1b[38;2;154;164;178m";
export const R = "\x1b[0m";
export const C = "\x1b[36m";
/** Explicit true-color green; terminal palette "green" is often olive/yellow. */
export const G = "\x1b[38;2;78;201;107m";
export const Y = "\x1b[33m";
export const RED = "\x1b[31m";
export const M = "\x1b[35m";
export const BL = "\x1b[34m";
export const GR = "\x1b[90m";
export const W = "\x1b[37m";
export const BG = "\x1b[48;5;236m";
/** Neutral charcoal, slightly lighter than the body surface. */
export const PANEL_BG = "\x1b[48;2;18;18;18m";
/** Inactive detail tabs sit a touch darker than their section bar. */
export const SUBTAB_BG = "\x1b[48;2;5;5;5m";
/** Start action is the only destructive-red control in the composer. */
export const START_BG = "\x1b[48;2;170;30;30m";
/** Update action uses orange to distinguish edit from create. */
export const UPDATE_BG = "\x1b[48;2;200;120;20m";
/** Kind colors for the runs page, desaturated to sit with the muted green. */
const KIND_RGB = {
  purple: "139;124;170",
  yellow: "196;178;110",
  red: "190;110;110",
} as const;

/** Kind background colors for run list headers. */
export const PURPLE_BG = `\x1b[48;2;${KIND_RGB.purple}m`;
export const YELLOW_BG = `\x1b[48;2;${KIND_RGB.yellow}m`;
export const RED_BG = `\x1b[48;2;${KIND_RGB.red}m`;
/** The same colors as text, so issue rows match their kind header. */
export const PURPLE_FG = `\x1b[38;2;${KIND_RGB.purple}m`;
export const YELLOW_FG = `\x1b[38;2;${KIND_RGB.yellow}m`;
export const RED_FG = `\x1b[38;2;${KIND_RGB.red}m`;
export const WHITE = "\x1b[97m";
/** 256-color accents for status/category encodings on dark terminals. */
export const SKY = "\x1b[38;5;75m";
export const LIME = "\x1b[38;5;114m";
export const AMBER = "\x1b[38;5;214m";
export const ROSE = "\x1b[38;5;203m";
export const VIOLET = "\x1b[38;5;141m";
export const SLATE = "\x1b[38;5;110m";
export const WRAP_OFF = "\x1b[?7l";
export const WRAP_ON = "\x1b[?7h";

/** Vim-style half-page scrolls. PageUp/PageDown are not bound anywhere. */
export const CTRL_D = "\x04";
export const CTRL_U = "\x15";
export const HALF_PAGE = 10;

/** Dimmed hierarchy text: darker than D, still readable on the body surface. */
export const DIM = "\x1b[38;2;96;102;112m";

/** Subtle zebra stripe for timeline rows (slightly lighter than body #0a0a0a). */
export const ZEBRA_BG = "\x1b[48;2;15;15;17m";

/* ------------------------------------------------------------------ theme */

export interface UiTheme {
  headerBg: string;
  headerFg: string;
  footerBg: string;
  footerFg: string;
  bodyBg: string;
  subHeaderBg: string;
  subHeaderFg: string;
  backBg: string;
  backFg: string;
  sectionBg: string;
  sectionFg: string;
  sectionActiveBg: string;
  sectionActiveFg: string;
  tabActiveBg: string;
  tabActiveFg: string;
}

export function ansiHex(hex: string, layer: "fg" | "bg"): string {
  const raw = hex.trim().replace(/^#/, "");
  const expanded = raw.length === 3 ? raw.split("").map((char) => `${char}${char}`).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return layer === "fg" ? `${W}` : `${BG}`;
  const n = Number.parseInt(expanded, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `\x1b[${layer === "fg" ? 38 : 48};2;${r};${g};${b}m`;
}

export function resolveTheme(config?: ThemeConfig): UiTheme {
  const merged = { ...DEFAULT_THEME, ...(config ?? {}) };
  return {
    headerBg: ansiHex(merged.header_bg, "bg"),
    headerFg: ansiHex(merged.header_fg, "fg"),
    footerBg: ansiHex(merged.footer_bg, "bg"),
    footerFg: ansiHex(merged.footer_fg, "fg"),
    bodyBg: ansiHex(merged.body_bg, "bg"),
    subHeaderBg: ansiHex(merged.sub_header_bg, "bg"),
    subHeaderFg: ansiHex(merged.sub_header_fg, "fg"),
    backBg: ansiHex(merged.back_bg, "bg"),
    backFg: ansiHex(merged.back_fg, "fg"),
    sectionBg: ansiHex(merged.section_bg, "bg"),
    sectionFg: ansiHex(merged.section_fg, "fg"),
    sectionActiveBg: ansiHex(merged.section_active_bg, "bg"),
    sectionActiveFg: ansiHex(merged.section_active_fg, "fg"),
    tabActiveBg: ansiHex(merged.tab_active_bg, "bg"),
    tabActiveFg: ansiHex(merged.tab_active_fg, "fg"),
  };
}

/* ------------------------------------------------------------ model picker */

export interface ModelPickerEntry {
  row: CatalogueRow;
  fit: number;
  eligible: boolean;
  reason?: string;
}

const MODEL_REASON_RANK: Record<string, number> = {
  "model-cooling": 0,
  "provider-cooling": 1,
  "provider-disabled": 2,
  "provider-needs-auth": 3,
  "unfunded-provider": 4,
  "free-model": 5,
  "no-tool-support": 6,
  "below-min-fit": 7,
  "below-min-capability": 8,
  "below-min-context": 10,
  "context-too-small": 11,
  "output-too-small": 12,
  "non-coding-model": 13,
  "router-model": 14,
  "invalid-pricing": 15,
};

export function modelReasonRank(reason: string | undefined): number {
  if (!reason) return 99;
  if (reason.startsWith("below-min-")) return 9;
  return MODEL_REASON_RANK[reason] ?? 99;
}

export function modelReasonLabel(reason: string | undefined): string {
  if (!reason) return "ineligible";
  if (reason.startsWith("below-min-") && !["below-min-fit", "below-min-capability", "below-min-context"].includes(reason)) {
    return `below ${reason.slice("below-min-".length)} floor`;
  }
  switch (reason) {
    case "provider-not-configured": return "provider not configured";
    case "provider-filtered": return "provider filtered";
    case "model-filtered": return "model filtered";
    case "invalid-pricing": return "invalid price";
    case "provider-disabled": return "provider disabled";
    case "provider-needs-auth": return "needs auth";
    case "provider-cooling": return "provider cooling";
    case "model-cooling": return "cooling";
    case "non-coding-model": return "not coding";
    case "router-model": return "router";
    case "no-tool-support": return "no tools";
    case "free-model": return "zero-cost model (paid tier)";
    case "unfunded-provider": return "unfunded provider";
    case "below-min-fit": return "below fit floor";
    case "below-min-capability": return "below cap floor";
    case "below-min-context": return "context below floor";
    case "context-too-small": return "context too small";
    case "output-too-small": return "output too small";
    default: return reason;
  }
}

export function modelPriceText(row: CatalogueRow): string {
  if (row.free || (row.pricing.input === 0 && row.pricing.output === 0)) return "";
  return ` ${D}$${row.pricing.input}/$${row.pricing.output}${R}`;
}

export function modelReasonText(entry: ModelPickerEntry, availability: AvailabilityState): string {
  if (entry.eligible) return "";
  if (entry.reason === "model-cooling" || entry.reason === "provider-cooling") {
    const until = Math.max(
      availability.models[entry.row.key]?.cooldownUntil ?? 0,
      availability.providers[entry.row.providerID]?.cooldownUntil ?? 0,
    );
    const mins = until > Date.now() ? Math.max(1, Math.ceil((until - Date.now()) / 60_000)) : 0;
    return mins > 0 ? `cooling ${mins}m` : "cooling";
  }
  return modelReasonLabel(entry.reason);
}

/* ------------------------------------------------------------------ utils */

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visible(value: string): number {
  return [...stripAnsi(value)].length;
}

export function sanitizeLine(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

export function trunc(value: string, width: number): string {
  if (width <= 0) return "";
  if (visible(value) <= width) return value;
  let out = "";
  let count = 0;
  let i = 0;
  while (i < value.length && count < width - 1) {
    if (value[i] === "\x1b") {
      let j = i;
      while (j < value.length && value[j] !== "m") j++;
      if (j < value.length) j++;
      out += value.slice(i, j);
      i = j;
      continue;
    }
    out += value[i];
    count++;
    i++;
  }
  return out + "…" + R;
}

export function fit(value: string, width: number): string {
  const length = visible(value);
  if (length > width) return trunc(value, width);
  return value + " ".repeat(Math.max(0, width - length));
}

export function pad(value: string, width: number): string {
  const length = visible(value);
  return length >= width ? trunc(value, width) : value + " ".repeat(width - length);
}

/** Word-wrap plain text; preserves blank lines but avoids runs of blanks. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let blank = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ").trimEnd();
    if (line.trim() === "") {
      if (!blank) out.push("");
      blank = true;
      continue;
    }
    blank = false;
    if ([...line].length <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while ([...rest].length > width) {
      let cut = width;
      const slice = rest.slice(0, width);
      const space = slice.lastIndexOf(" ");
      if (space > Math.floor(width * 0.6)) cut = space;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest) out.push(rest);
  }
  return out;
}

export function ago(iso: string | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
}

export function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function fmtMoney(value: number): string {
  if (value >= 10) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

export function fmtContext(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Compact run-token label: 36.1K, 735K, 1.2M. */
export function fmtRunTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function icon(status: string): string {
  switch (status) {
    case "running": return `${G}●${R}`;
    case "done":
    case "completed": return `${G}✓${R}`;
    case "awaiting_input": return `${Y}!${R}`;
    case "paused": return `${Y}⏸${R}`;
    case "blocked": return `${Y}⊘${R}`;
    case "needs-human-review": return `${Y}◷${R}`;
    case "failed-gates":
    case "failed-human-review":
    case "failed": return `${RED}✗${R}`;
    case "cancelled": return `${GR}⃠${R}`;
    case "interrupted": return `${GR}◯${R}`;
    default: return `${GR}○${R}`;
  }
}

export function statusColor(status: string): string {
  if (status === "running") return C;
  if (status === "completed" || status === "done") return G;
  if (["awaiting_input", "paused", "blocked", "interrupted", "needs-human-review"].includes(status)) return Y;
  if (status === "failed" || status.startsWith("failed-")) return RED;
  return GR;
}

/** Per-event accent color for timeline dots and overview snippets. */
export function eventTone(type: string, isError = false): string {
  if (isError) return RED;
  switch (type) {
    case "run_start":
    case "context_assembled": return C;
    case "model_select":
    case "model_request":
    case "plan_updated": return BL;
    case "model_call_end":
    case "run_summary":
    case "child_spawned":
    case "child_completed": return M;
    case "tool_call_start": return Y;
    case "tool_call": return G;
    case "gates":
    case "agent_config": return B;
    case "retry":
    case "control":
    case "turn_cap":
    case "budget_exhausted": return Y;
    case "run_end":
    case "error_classified":
    case "malformed_tool_call":
    case "loop_blocked":
    case "holdings-exceeded": return RED;
    default: return D;
  }
}

/** Shared semantic tones for context provenance across previews and run details. */
export function contextTone(kind: string): string {
  switch (kind) {
    case "packet": return M; // legacy context provenance
    case "docs":
    case "knowledge": return C;
    case "reference": return M;
    case "file": return W;
    case "skill": return G;
    case "tool": return M;
    case "script": return BL;
    case "parent-run": return GR;
    default: return C;
  }
}

export function progress(value: number | undefined, width: number): string {
  if (value === undefined) return `${D}${"·".repeat(Math.max(1, width))}${R}`;
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return `${G}${"█".repeat(filled)}${D}${"░".repeat(Math.max(0, width - filled))}${R}`;
}

/**
 * One footer command: `Label[key]: Value`.
 * Labels recede into the surface; the key and its current value share one
 * semantic tone so the eye lands on the action and its state together.
 */
export function command(
  key: string,
  label: string,
  value?: string,
  tone: string = C,
): string {
  const head = `${D}${label}${R}${D}[${R}${B}${tone}${key}${R}${D}]${R}`;
  return value === undefined || value === "" ? head : `${head}${D}:${R} ${B}${tone}${value}${R}`;
}

/** Command token with an explicit background, for the destructive start action. */
export function commandBadge(label: string, key: string, background: string, foreground: string): string {
  return `${background}${foreground}${B} ${label}[${key}] ${R}`;
}

/** Stable role colors used wherever an agent name is shown. */
/** Tone for selection tier display. */
export function tierTone(tier: "paid" | "local"): string {
  return tier === "paid" ? G : BL;
}

export function agentTone(agent: string): string {
  switch (agent) {
    case "research": return PURPLE_FG;
    case "engineer": return BL;
    case "review": return RED;
    // Legacy run records keep their old colors.
    case "planner": return BL;
    case "build": return C;
    default: return C;
  }
}

export function joinCommands(items: Array<string | false | undefined | null>): string {
  return items.filter((item): item is string => Boolean(item)).join("  ");
}

/** Wrap command tokens on double-space boundaries, preserving ANSI styling. */
export function wrapCommands(text: string, width: number): string[] {
  const tokens = text.split(/\s{2,}/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current ? `${current}  ${token}` : token;
    if (current && visible(candidate) > width) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => (visible(line) > width ? trunc(line, width) : line));
}

export function wrapPlain(text: string, width: number): string[] {
  if (!text) return [];
  return wrapText(stripAnsi(text), width).map((line) => `${D}${line}${R}`);
}

/** Wrap pre-styled tokens with a caller-controlled visual gap. */
export function wrapTokenList(tokens: readonly string[], width: number, gap: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current ? `${current}${gap}${token}` : token;
    if (current && visible(candidate) > width) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => (visible(line) > width ? trunc(line, width) : line));
}

/** Split a raw stdin read into keypresses, keeping ANSI sequences intact. */
export function splitKeys(input: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < input.length) {
    if (input[index] === "\x1b") {
      const next = input[index + 1];
      if (next === "[" || next === "O") {
        let end = index + 2;
        while (end < input.length && !/[@-~]/.test(input[end]!)) end += 1;
        keys.push(input.slice(index, end + 1));
        index = end + 1;
      } else {
        keys.push("\x1b");
        index += 1;
      }
    } else {
      keys.push(input[index]!);
      index += 1;
    }
  }
  return keys;
}

/** Keep a full-width bar's background through embedded style resets. */
export function background(value: string, tone: string): string {
  return `${tone}${value.replaceAll(R, `${R}${tone}`)}${R}`;
}

export function selected(value: string, isSelected: boolean): string {
  if (!isSelected) return value;
  // Keep the selection background through embedded color resets.
  return `${BG}${value.replaceAll(R, `${R}${BG}`)}${R}`;
}

/** Replace every foreground color and attribute with one dark gray. */
export function dim(value: string): string {
  return `${DIM}${value.replace(/\x1b\[[0-9;]*m/g, (seq) => {
    if (seq === R) return `${R}${DIM}`;
    if (seq === BG || seq.startsWith("\x1b[48;")) return seq;
    return DIM;
  })}${R}`;
}

export function printable(data: string): string {
  let out = "";
  for (const ch of data) {
    if (ch === "\x1b") break;
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export function runIdFromEvent(run: RunSummary): string {
  return run.id.slice(-8);
}

/** Generic inherited request ("Build the task.") hides the real objective. */
export function isGenericTaskRequest(request: string): boolean {
  return /^(?:build|do|run|implement|work on)\s+(?:the\s+)?(?:task|issue)\.?$/i.test(request.trim());
}

/** True for write/edit tool events (both start and completion records). */
export function isEditToolEvent(event: RunEvent): boolean {
  if (event.type !== "tool_call" && event.type !== "tool_call_start") return false;
  const tool = String((event as { tool?: unknown }).tool ?? "");
  return tool === "write" || tool === "edit";
}

export function editEventArgs(event: RunEvent): Record<string, unknown> {
  const direct = (event as { args?: unknown }).args;
  if (direct !== undefined && direct !== null) return direct as Record<string, unknown>;
  const nested = (event as { call?: { args?: unknown } }).call?.args;
  return (nested ?? {}) as Record<string, unknown>;
}

/**
 * Human-readable edit rendering: path plus every hunk as -/+ diff lines.
 * Timeline keeps full JSON; Thinking and Overview use this instead.
 * Capped so a giant write cannot flood the section.
 */
export function editSummaryLines(event: RunEvent, width: number, maxLines = 30): string[] {
  const tool = String((event as { tool?: unknown }).tool ?? "edit");
  const args = editEventArgs(event);
  const path = typeof args.path === "string" ? args.path : "(unknown path)";
  const out: string[] = [`${tool} ${path}`];
  const pushLine = (line: string): boolean => {
    out.push(line);
    return out.length < maxLines;
  };
  const pushPair = (oldText: string, newText: string, hunkLabel?: string): void => {
    if (hunkLabel) {
      if (!pushLine(`… ${hunkLabel}`)) return;
    }
    const olds = oldText.split("\n").filter((line) => line.trim().length > 0);
    const news = newText.split("\n").filter((line) => line.trim().length > 0);
    for (const line of olds) {
      for (const wrapped of wrapText(line, Math.max(20, width))) {
        if (!pushLine(`- ${trunc(wrapped, Math.max(20, width - 2))}`)) return;
      }
    }
    for (const line of news) {
      for (const wrapped of wrapText(line, Math.max(20, width))) {
        if (!pushLine(`+ ${trunc(wrapped, Math.max(20, width - 2))}`)) return;
      }
    }
  };
  if (Array.isArray(args.edits) && args.edits.length > 0) {
    const edits = args.edits as Array<{ oldString?: unknown; newString?: unknown }>;
    edits.forEach((hunk, index) => {
      if (out.length >= maxLines) return;
      pushPair(
        String(hunk.oldString ?? ""),
        String(hunk.newString ?? ""),
        edits.length > 1 ? `hunk ${index + 1}/${edits.length}` : undefined,
      );
    });
    if (out.length >= maxLines) out.push(`… capped at ${maxLines} lines`);
  } else if (typeof args.oldString === "string" || typeof args.newString === "string") {
    pushPair(String(args.oldString ?? ""), String(args.newString ?? ""));
    if (out.length >= maxLines) out.push(`… capped at ${maxLines} lines`);
  } else if (typeof args.content === "string") {
    const lines = args.content.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      for (const wrapped of wrapText(line, Math.max(20, width))) {
        if (!pushLine(`+ ${trunc(wrapped, Math.max(20, width - 2))}`)) break;
      }
      if (out.length >= maxLines) break;
    }
    if (out.length >= maxLines) out.push(`… capped at ${maxLines} lines (${Buffer.byteLength(args.content, "utf8")} bytes total)`);
    else out.push(`… ${Buffer.byteLength(args.content, "utf8")} bytes total`);
  }
  return out;
}

/** Latest edit/write tool events, newest last, for Thinking and Overview snippets. */
export function recentEditEvents(events: readonly RunEvent[], limit = 5): RunEvent[] {
  const out: RunEvent[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    if (!isEditToolEvent(event)) continue;
    out.push(event);
  }
  return out.slice(-Math.max(1, limit));
}
