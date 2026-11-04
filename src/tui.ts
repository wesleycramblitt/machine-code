/**
 * machine_code — TUI.
 *
 * Four durable pages (runs, models, spend, settings) plus focused
 * detail/composer screens. The frame contract is unchanged: exactly `rows`
 * lines, two header lines, two footer lines, content clipped to the middle.
 *
 * The TUI wraps the CLI's file/CLI primitives rather than inventing a second
 * source of truth. Every screen is derived from run summaries, the issue
 * cache, the catalogue, config, and the spend ledger on each refresh.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout, type Layout } from "./paths.js";
import { listAllRuns, listProjects, readRun, type RunEvent, type RunSummary } from "./state/runs.js";
import { summarizeRun, readStateView } from "./state/outcome.js";
import { appendInbox, latestUnansweredQuestion, readInbox } from "./state/question.js";
import { readIssueCache, writeIssueCache } from "./issues/cache.js";
import type { Issue, IssueRef } from "./issues/provider.js";
import { filterRuns, headerCounts, issueGlyphKind, issueRowDetail, sortRuns, type RunFilter } from "./tui/status.js";
import {
  RUN_GROUPS,
  RUN_GROUP_LABELS,
  buildRunIndex,
  orderIssueTree,
  repoLabel,
  repoOf,
  type RunGroup,
  type RunRow,
} from "./tui/runs.js";
import { scrollLines, selectableLines } from "./tui/scroll.js";
import { describeTimelineEvent, isTimelineEvent, lastTimelineIndex, stepTimelineSelection } from "./tui/timeline.js";
import { buildSettings, settingsFileFor, type SettingRow } from "./tui/settings.js";
import { forkSettingsFromRun, type ForkedRunSettings } from "./tui/fork.js";
import { loadMachineConfig, loadPolicy, CAPABILITY_AXES, SELECTION_TIERS, DEFAULT_THEME, type AgentPolicy, type MachineConfig, type Policy, type ThemeConfig } from "./config.js";
import { axisWeights, isMetaRouter, modelStatus, pick } from "./select.js";
import { readSpendSummary, spendBar, spendDays } from "./spend.js";
import { loadAvailability, saveAvailability, type AvailabilityState } from "./availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "./availability/probe.js";
import { latestProcessRecords } from "./processes/registry.js";
import { planSchedule, type OrchestrationScope } from "./orchestrator/scheduler.js";
import { listOrchestrations } from "./orchestrator/state.js";
import { skillListItems, toolListItems, tokensForChars } from "./tui/tools.js";
import { toolSchemaChars } from "./tools/schema.js";
import { readLogTail } from "./processes/logs.js";
import { reconcileProcessRecords } from "./processes/reconcile.js";
import { terminateAllProcesses, terminateProcessRecord } from "./processes/supervisor.js";
import { AGENT_META, AGENT_NAMES, agentDef, type AgentDef, type IssueAccess } from "./agents.js";
import { PRESETS, resolveAgent, resolveAgentConfig, type AgentConfig } from "./agents/config.js";
import { issueAccessFromCapabilities } from "./policy/capabilities.js";
import { createModelsCollection, providerStatuses } from "./models.js";
import { fundedProviderIds } from "./data.js";
import { loadCatalogue } from "./catalogue/load.js";
import { filterModels, groupModels, siblingOffers, type ModelSort } from "./catalogue/query.js";
import type { CatalogueDocument, CatalogueRow } from "./catalogue/types.js";
import { previewContext, artifactPreview, discoverKnowledgeFiles, type ContextPreview } from "./context/preview.js";
import { skillMetas } from "./context/references.js";
import { changesFor, contextUsage, readContextManifest, relatedRuns, thinkingChunks, touchedPaths, type ChangeSummary, type ThinkingChunk } from "./report/run.js";
import { artifactPath, listArtifacts, type ArtifactDef } from "./artifacts/registry.js";
import { loadSemantic, readSemanticDirty, renderSemanticIndex } from "./map/semantic.js";
import { readCachedMap, renderMapIndex, symbolCount } from "./map/deterministic.js";
import { serverAvailable } from "./lsp/index.js";

/* --------------------------------------------------------------- terminal */

const ALT = "\x1b[?1049h";
const ALT_L = "\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

const B = "\x1b[1m";
/** Secondary text: an explicit mid-gray reads far better than SGR faint on dark themes. */
const D = "\x1b[38;2;154;164;178m";
const R = "\x1b[0m";
const C = "\x1b[36m";
/** Explicit true-color green; terminal palette "green" is often olive/yellow. */
const G = "\x1b[38;2;78;201;107m";
const Y = "\x1b[33m";
const RED = "\x1b[31m";
const M = "\x1b[35m";
const BL = "\x1b[34m";
const GR = "\x1b[90m";
const W = "\x1b[37m";
const BG = "\x1b[48;5;236m";
/** Neutral charcoal, slightly lighter than the body surface. */
const PANEL_BG = "\x1b[48;2;18;18;18m";
/** Inactive detail tabs sit a touch darker than their section bar. */
const SUBTAB_BG = "\x1b[48;2;5;5;5m";
/** Start action is the only destructive-red control in the composer. */
const START_BG = "\x1b[48;2;170;30;30m";
const WHITE = "\x1b[97m";
const WRAP_OFF = "\x1b[?7l";
const WRAP_ON = "\x1b[?7h";

interface UiTheme {
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

function ansiHex(hex: string, layer: "fg" | "bg"): string {
  const raw = hex.trim().replace(/^#/, "");
  const expanded = raw.length === 3 ? raw.split("").map((char) => `${char}${char}`).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return layer === "fg" ? `${W}` : `${BG}`;
  const n = Number.parseInt(expanded, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `\x1b[${layer === "fg" ? 38 : 48};2;${r};${g};${b}m`;
}

function resolveTheme(config?: ThemeConfig): UiTheme {
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

type Page = "runs" | "models" | "spend" | "settings" | "orchestrate";
type Screen = "list" | "issue" | "run" | "newrun" | "answer" | "correct" | "model";
type RunSection = "overview" | "timeline" | "processes" | "thinking" | "changes" | "related" | "context";
type RunListFilter = RunFilter | "attention";

const TABS: Array<{ id: Page; label: string; key: string }> = [
  { id: "runs", label: "Runs", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "spend", label: "Spend", key: "3" },
  { id: "settings", label: "Settings", key: "4" },
  { id: "orchestrate", label: "Orchestrate", key: "5" },
];
const PAGE_IDS = new Set<Page>(TABS.map((tab) => tab.id));
const RUN_SECTIONS: RunSection[] = ["overview", "timeline", "processes", "thinking", "changes", "related", "context"];
const RUN_SECTION_LABEL: Record<RunSection, string> = {
  overview: "Overview",
  timeline: "Timeline",
  processes: "Processes",
  thinking: "Thinking",
  changes: "Changes",
  related: "Related",
  context: "Context",
};
const NEW_RUN_AGENTS = [...AGENT_NAMES];
const NEW_RUN_PRESET_INFO: Record<string, string> = {
  plan: "Planner flow. Creates issue graphs, uses direct verification, asks when needed.",
  orchestrate: "Delegated flow. Verified checks and issue tracking; used by the Orchestrator.",
  implement: "Build flow. Verified checks, no clarifying questions.",
  review: "Review flow. Direct verification, no clarifying questions.",
  assistant: "Assistant flow. Issues disabled; asks when needed.",
  unrestricted: "Permissive flow. Verified checks, delegation on, asks when needed.",
};
const NEW_RUN_SETTING_FIELDS = [
  "preset",
  "verification",
  "issues",
  "ask",
  "approval",
  "ambiguity",
  "minFit",
  "floors",
] as const;
type NewRunSettingField = (typeof NEW_RUN_SETTING_FIELDS)[number];

interface ContextPanelItem {
  text: string;
  chars: number;
  exists: boolean;
  key: string;
  fixed?: boolean;
  available?: boolean;
  counted?: boolean;
}
const NEW_RUN_CONTEXT_TABS = ["Issues", "Knowledge", "References", "Skills", "Tools", "Scripts", "Plans", "Codebase"] as const;

type NewRunState = ForkedRunSettings;

interface ModelPickerEntry {
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
  "not-free": 4,
  "unfunded-provider": 5,
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

function modelReasonRank(reason: string | undefined): number {
  if (!reason) return 99;
  if (reason.startsWith("below-min-")) return 9;
  return MODEL_REASON_RANK[reason] ?? 99;
}

function modelReasonLabel(reason: string | undefined): string {
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
    case "not-free": return "paid only";
    case "unfunded-provider": return "unfunded provider";
    case "below-min-fit": return "below fit floor";
    case "below-min-capability": return "below cap floor";
    case "below-min-context": return "context below floor";
    case "context-too-small": return "context too small";
    case "output-too-small": return "output too small";
    default: return reason;
  }
}

function modelReasonText(entry: ModelPickerEntry, availability: AvailabilityState): string {
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

interface RunDetail {
  layout: Layout;
  summary: RunSummary;
  events: RunEvent[];
  dir: string;
}

interface ChangesCache {
  runId: string;
  at: number;
  data: ChangeSummary;
}

/* ------------------------------------------------------------------ utils */

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function visible(value: string): number {
  return [...stripAnsi(value)].length;
}

function sanitizeLine(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

function trunc(value: string, width: number): string {
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

function fit(value: string, width: number): string {
  const length = visible(value);
  if (length > width) return trunc(value, width);
  return value + " ".repeat(Math.max(0, width - length));
}

function pad(value: string, width: number): string {
  const length = visible(value);
  return length >= width ? trunc(value, width) : value + " ".repeat(width - length);
}

/** Word-wrap plain text; preserves blank lines but avoids runs of blanks. */
function wrapText(text: string, width: number): string[] {
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

function ago(iso: string | undefined): string {
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

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function fmtMoney(value: number): string {
  if (value >= 10) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function fmtContext(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Compact run-token label: 36.1K, 735K, 1.2M. */
function fmtRunTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function icon(status: string): string {
  switch (status) {
    case "running": return `${C}●${R}`;
    case "done":
    case "completed": return `${G}✓${R}`;
    case "awaiting_input": return `${Y}?${R}`;
    case "paused": return `${Y}⏸${R}`;
    case "blocked": return `${Y}⊘${R}`;
    case "failed": return `${RED}✗${R}`;
    case "cancelled": return `${GR}⃠${R}`;
    case "interrupted": return `${GR}◯${R}`;
    default: return `${GR}○${R}`;
  }
}

function issueIcon(issue: Issue): string {
  switch (issueGlyphKind(issue)) {
    case "closed": return `${G}✓${R}`;
    case "blocked": return `${Y}⊘${R}`;
    case "ready": return `${G}●${R}`;
    case "draft": return `${Y}◐${R}`;
    case "open": return issue.kind === "epic" ? `${C}○${R}` : `${GR}○${R}`;
  }
}

function statusColor(status: string): string {
  if (status === "running") return C;
  if (status === "completed" || status === "done") return G;
  if (["awaiting_input", "paused", "blocked", "interrupted"].includes(status)) return Y;
  if (status === "failed") return RED;
  return GR;
}

/** Compact codebase-index health tokens for bottom footers. */
function mapStatusTokens(root: string): string[] {
  const mapCached = existsSync(join(root, ".machine_code", "local", "cache", "map.json"));
  const semantic = loadSemantic(root);
  const semanticDirty = readSemanticDirty(root);
  const lspReady = serverAvailable("typescript");
  return [
    `${mapCached ? G : Y}MAP${mapCached ? "✓" : "✗"}${R}`,
    `${semantic ? (semanticDirty.length ? Y : G) : GR}SEM${semantic ? (semanticDirty.length ? "~" : "✓") : "-"}${R}`,
    `${lspReady ? G : GR}LSP${lspReady ? "✓" : "✗"}${R}`,
  ];
}

/** Shared semantic tones for context provenance across previews and run details. */
function contextTone(kind: string): string {
  switch (kind) {
    case "issue":
    case "epic":
    case "feature":
    case "task": return Y;
    case "packet": return M;
    case "knowledge": return C;
    case "reference": return M;
    case "file": return W;
    case "skill": return G;
    case "tool": return M;
    case "script": return BL;
    case "plan":
    case "project":
    case "parent-run": return GR;
    default: return C;
  }
}

function progress(value: number | undefined, width: number): string {
  if (value === undefined) return `${D}${"·".repeat(Math.max(1, width))}${R}`;
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return `${G}${"█".repeat(filled)}${D}${"░".repeat(Math.max(0, width - filled))}${R}`;
}

/**
 * One footer command: `Label[key]: Value`.
 * Labels recede into the surface; the key and its current value share one
 * semantic tone so the eye lands on the action and its state together.
 */
function command(
  key: string,
  label: string,
  value?: string,
  tone: string = C,
): string {
  const head = `${D}${label}${R}${D}[${R}${B}${tone}${key}${R}${D}]${R}`;
  return value === undefined || value === "" ? head : `${head}${D}:${R} ${B}${tone}${value}${R}`;
}

/** Command token with an explicit background, for the destructive start action. */
function commandBadge(label: string, key: string, background: string, foreground: string): string {
  return `${background}${foreground}${B} ${label}[${key}] ${R}`;
}

/** Stable role colors used wherever an agent name is shown. */
function agentTone(agent: string): string {
  switch (agent) {
    case "sudo": return RED;
    case "general": return G;
    case "planner": return BL;
    case "build": return C;
    case "review": return M;
    default: return C;
  }
}

/** Free is the safe default; paid is the yellow caution path. */
function tierTone(tier: string): string {
  return tier === "free" ? G : Y;
}

function issueAccessTone(access: IssueAccess): string {
  return access === "create" ? G : access === "plan" ? C : access === "read" ? D : GR;
}

function joinCommands(items: Array<string | false | undefined | null>): string {
  return items.filter((item): item is string => Boolean(item)).join("  ");
}

/** Wrap command tokens on double-space boundaries, preserving ANSI styling. */
function wrapCommands(text: string, width: number): string[] {
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

function wrapPlain(text: string, width: number): string[] {
  if (!text) return [];
  return wrapText(stripAnsi(text), width).map((line) => `${D}${line}${R}`);
}

/** Wrap pre-styled tokens with a caller-controlled visual gap. */
function wrapTokenList(tokens: readonly string[], width: number, gap: string): string[] {
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
function splitKeys(input: string): string[] {
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
function background(value: string, tone: string): string {
  return `${tone}${value.replaceAll(R, `${R}${tone}`)}${R}`;
}

function selected(value: string, isSelected: boolean): string {
  if (!isSelected) return value;
  // Keep the selection background through embedded color resets.
  return `${BG}${value.replaceAll(R, `${R}${BG}`)}${R}`;
}

function printable(data: string): string {
  let out = "";
  for (const ch of data) {
    if (ch === "\x1b") break;
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

function runIdFromEvent(run: RunSummary): string {
  return run.id.slice(-8);
}

function refKey(ref: IssueRef | undefined): string {
  return ref ? `${ref.repo}#${ref.number}` : "";
}

/* ------------------------------------------------------------------ app */

export async function runTui(): Promise<void> {
  const l = layout();
  mkdirSync(l.localDir, { recursive: true });

  let page: Page = "runs";
  let screen: Screen = "list";
  let runsFilter: RunListFilter = "all";
  let runsText = "";
  let runsGroup: RunGroup = "gh-issue";
  let runsSel = 0;
  let runsScroll = 0;
  let runsAttention = false;
  const collapsed = new Set<string>();

  let modelText = "";
  let modelGroup: "provider" | "family" | "none" = "provider";
  let modelSort: ModelSort = "capability";
  let modelsAll = false;
  let modelsFree = false;
  let modelsCoding = true;
  let modelSel = 0;
  let modelScroll = 0;
  const probingModels = new Set<string>();
  /** Rows in the exact order they are rendered (grouped), used by Enter/selection. */
  let modelVisible: CatalogueRow[] = [];
  let selectedModelKey: string | null = null;

  let spendDaysWindow = 30;
  let spendBy: "provider" | "model" | "day" | "agent" = "provider";
  let spendScroll = 0;

  let settingsSel = 0;
  let settingsScroll = 0;

  let selectedIssueKey: string | null = null;
  let selectedRunId: string | null = null;
  let issueCachesByRepo = new Map<string, readonly Issue[]>();
  let issueRunSel = 0;
  let issueScroll = 0;
  let runSection: RunSection = "overview";
  let runScroll = 0;
  let processSel = 0;
  let processFollow = false;
  let eventSel = 0;
  let eventScroll = 0;
  /** Line offset inside a selected timeline block (expanded inputs/outputs). */
  let eventBodyScroll = 0;
  /** Follow the newest timeline event; j/k or PgUp/PgDn turns it off. */
  let timelineFollow = true;
  /** Show routine internals in the timeline. */
  let timelineVerbose = false;
  let thinkingScroll = 0;
  let thinkingFollow = true;
  let childSel = 0;
  let orchestrateScope: OrchestrationScope = "project";
  let orchestrateRef: IssueRef | undefined;
  let orchestrateSel = 0;
  let orchestrateScroll = 0;
  const expanded = new Set<string>();
  let changesCache: ChangesCache | null = null;

  let newrun: NewRunState = {
    agent: "general",
    preset: "unrestricted",
    verification: "verified",
    issues: "optional",
    ask: true,
    approval: "human",
    ambiguity: "precise",
    tier: "free",
    minFit: undefined,
    floors: "role",
    prompt: "",
  };
  let newRunRepo = l.repoRoot;
  /** Parent run id when the composer was opened with fork[f]. */
  let newRunParentId: string | null = null;
  let issuePick: "newrun" | null = null;
  let issuePickSel = 0;
  let issuePickText = "";
  let modelPick: "newrun" | null = null;
  let modelPickSel = 0;
  let modelPickText = "";
  let modelPickEntries: ModelPickerEntry[] = [];
  /** New-run prompt is modal: navigation keys are disabled while true. */
  let newRunInsert = false;
  /** `:` starts the two-key `:!` start command. */
  let newRunColon = false;
  /** Advanced, rarely-touched new-run options live behind [s]. */
  let newRunSettings = false;
  let newRunSettingsSel = 0;
  let newRunContextTab = 0;
  let newRunContextItem = 0;
  let newRunContextItemKeys: string[] = [];
  let newRunContextItemAvailable: boolean[] = [];
  let newRunContextSectionKey = "";
  const newRunContextExcluded = new Set<string>();
  const newRunContextIncluded = new Set<string>();
  /**
   * Static inputs to the new-run preview (policy, catalogue, provider status,
   * context files) are expensive to reload on every keystroke, so they are
   * cached and only the prompt length is applied per frame.
   */
  let newRunPreviewCache: {
    key: string;
    at: number;
    context: ContextPreview;
    policy?: Policy;
    machine?: MachineConfig;
    catalogue: CatalogueDocument | null;
    configured: Set<string>;
    availability: AvailabilityState;
  } | null = null;
  let answerText = "";
  let answerQuestionId = "";
  let correctText = "";
  let searchMode = false;
  let searchText = "";
  let toast = "";
  let toastAt = 0;
  let pendingRunAt = 0;
  let issueRefreshAt = 0;
  let issueRefreshing = false;
  let issueStatus = "no cache";

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write(ALT + HIDE);

  const cleanup = () => {
    stdin.setRawMode?.(false);
    process.stdout.write(SYNC_OFF + SHOW + ALT_L);
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const notify = (message: string) => {
    toast = message;
    toastAt = Date.now();
  };

  const findRunDetail = (id: string): RunDetail | null => {
    const local = readRun(l, id);
    if (local) return { layout: l, summary: local.summary, events: local.events, dir: join(l.runsDir, id) };
    for (const project of listAllRuns(l.home).map((run) => run.repoRoot)) {
      if (!project) continue;
      const rl = layout(project);
      const found = readRun(rl, id);
      if (found) return { layout: rl, summary: found.summary, events: found.events, dir: join(rl.runsDir, id) };
    }
    return null;
  };

  const collectIssueCaches = (runs: readonly RunSummary[]): Map<string, readonly Issue[]> => {
    const repos = new Set<string>([l.repoRoot, ...listProjects(l.home), ...runs.map(repoOf)]);
    const caches = new Map<string, readonly Issue[]>();
    for (const repoRoot of repos) {
      if (!repoRoot) continue;
      const cache = readIssueCache(layout(repoRoot));
      if (cache) caches.set(repoRoot, cache.issues);
    }
    return caches;
  };

  const issueRepoOf = (ref: IssueRef | undefined): string | undefined => {
    if (!ref) return undefined;
    const key = refKey(ref);
    for (const [repoRoot, issues] of issueCachesByRepo) {
      if (issues.some((issue) => refKey(issue.ref) === key)) return repoRoot;
    }
    return undefined;
  };

  const selectedIssue = (): Issue | undefined => {
    if (!selectedIssueKey) return undefined;
    for (const issues of issueCachesByRepo.values()) {
      const issue = issues.find((candidate) => refKey(candidate.ref) === selectedIssueKey);
      if (issue) return issue;
    }
    return undefined;
  };

  const issueByRef = (ref: IssueRef | undefined): Issue | undefined => {
    if (!ref) return undefined;
    for (const issues of issueCachesByRepo.values()) {
      const issue = issues.find((candidate) => refKey(candidate.ref) === refKey(ref));
      if (issue) return issue;
    }
    return undefined;
  };

  const refreshIssues = async (scope: "current" | "all" = "current") => {
    if (issueRefreshing) return;
    issueRefreshing = true;
    issueRefreshAt = Date.now();
    const repoRoots = scope === "all" ? [...new Set([l.repoRoot, ...listProjects(l.home)])] : [l.repoRoot];
    let refreshed = 0;
    let unavailable = 0;
    try {
      const { createIssueProvider } = await import("./issues/index.js");
      for (const repoRoot of repoRoots) {
        const repoLayout = layout(repoRoot);
        try {
          const bundle = await createIssueProvider(repoLayout, loadMachineConfig(repoLayout));
          if (bundle.provider.kind === "none") {
            unavailable += 1;
            continue;
          }
          const issues = await bundle.provider.list({ state: "all", limit: 300 });
          writeIssueCache(repoLayout, bundle.repo ?? "", issues);
          refreshed += 1;
        } catch {
          unavailable += 1;
        }
      }
      issueStatus = unavailable > 0
        ? `fresh ${refreshed} repo(s), ${unavailable} unavailable`
        : `fresh ${refreshed} repo(s)`;
      if (scope === "all") notify(issueStatus);
    } finally {
      issueRefreshing = false;
    }
  };

  const openUrl = (url: string | undefined) => {
    if (!url) { notify("no URL for this item"); return; }
    try {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => notify(url));
      child.unref();
      notify(`opened ${url}`);
    } catch {
      notify(url);
    }
  };

  const openEditor = (file: string | null | undefined) => {
    if (!file) { notify("no file source for this setting"); return; }
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) { notify(file); return; }
    stdin.setRawMode?.(false);
    process.stdout.write(SYNC_OFF + SHOW + ALT_L);
    let status: number | null = null;
    try {
      const result = spawnSync(editor, [file], { stdio: "inherit", shell: false });
      status = result.status;
    } catch {
      notify(`could not launch editor: ${editor}`);
    }
    process.stdout.write(ALT + HIDE);
    stdin.setRawMode?.(true);
    stdin.resume();
    if (status !== null) notify(status === 0 ? `edited ${basename(file)}` : `editor exited ${status}`);
  };

  const launch = (args: string[], repoRoot = l.repoRoot) => {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    try {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: repoRoot,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      pendingRunAt = Date.now();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const defaultNewRun = (): NewRunState => {
    const agent = "general";
    const repoLayout = layout(newRunRepo);
    const def = agentDef(repoLayout, agent);
    const preset = PRESETS[def.preset];
    // A new run starts from the machine selection tier, not a hard-coded free
    // default. The per-run toggle can still override it.
    let tier: "free" | "paid" = "free";
    try {
      tier = loadMachineConfig(repoLayout).selection.tier;
    } catch {
      // keep the safe default when the machine config is unavailable
    }
    return {
      agent,
      preset: def.preset,
      verification: preset?.verification ?? "verified",
      issues: preset?.issues ?? "optional",
      ask: preset?.ask ?? true,
      approval: preset?.approval ?? "human",
      ambiguity: preset?.ambiguity ?? "precise",
      tier,
      minFit: undefined,
      floors: "role",
      prompt: "",
    };
  };

  newrun = defaultNewRun();

  const applyPreset = (name: string) => {
    const preset = PRESETS[name];
    newrun.preset = name;
    if (!preset) return;
    newrun.verification = preset.verification;
    newrun.issues = preset.issues;
    newrun.ask = preset.ask;
    newrun.approval = preset.approval;
    newrun.ambiguity = preset.ambiguity;
  };

  const resetNewRunUi = () => {
    newRunInsert = false;
    newRunColon = false;
    newRunSettings = false;
    newRunSettingsSel = 0;
    newRunContextTab = 0;
    newRunContextItem = 0;
    newRunContextExcluded.clear();
    newRunContextIncluded.clear();
    newRunPreviewCache = null;
    newRunParentId = null;
    modelPick = null;
    modelPickSel = 0;
    modelPickText = "";
    modelPickEntries = [];
    issuePick = null;
    issuePickSel = 0;
    issuePickText = "";
  };

  const startNewRun = (issue?: IssueRef, repoRoot = l.repoRoot) => {
    const previous = newrun;
    newRunRepo = repoRoot;
    newrun = {
      ...defaultNewRun(),
      ...(previous.tier ? { tier: previous.tier } : {}),
      ...(previous.agent ? { agent: previous.agent } : {}),
      ...(issue ? { issue } : {}),
    };
    // Keep the selected agent's mode/preset coherent.
    const def = agentDef(layout(newRunRepo), newrun.agent);
    applyPreset(def.preset);
    resetNewRunUi();
    screen = "newrun";
  };

  const forkRun = (detail: RunDetail) => {
    const summary = detail.summary;
    if (summary.status === "created" || summary.status === "running" || summary.status === "awaiting_input") {
      notify(`interrupt ${summary.id.slice(-8)} before forking; its worktree is still active`);
      return;
    }
    const repoLayout = layout(summary.repoRoot);
    const agent = AGENT_NAMES.includes(summary.agent) ? summary.agent : "general";
    const policy = effectivePolicy(summary.repoRoot);
    const machine = (() => {
      try { return loadMachineConfig(repoLayout); } catch { return undefined; }
    })();
    const defaults = resolveAgentConfig({
      role: agent,
      agentPolicy: policy?.agents[agent],
      machineOverrides: machine?.agents[agent],
    });
    const configured = new Set(
      providerStatuses(createModelsCollection())
        .filter((status) => status.configured)
        .map((status) => status.id),
    );
    newRunRepo = summary.repoRoot;
    newrun = forkSettingsFromRun({
      summary,
      events: detail.events,
      catalogue: loadCatalogue(repoLayout.catalogueFile),
      defaults,
      configuredProviders: configured,
    });
    resetNewRunUi();
    newRunParentId = summary.id;
    screen = "newrun";
    notify(`forked settings from ${summary.id.slice(-8)}; edit the request and start`);
  };

  const cycleAgent = () => {
    const index = NEW_RUN_AGENTS.indexOf(newrun.agent);
    newrun.agent = NEW_RUN_AGENTS[(index + 1) % NEW_RUN_AGENTS.length] ?? newrun.agent;
    const def = agentDef(layout(newRunRepo), newrun.agent);
    applyPreset(def.preset);
  };

  const cycleNewRunSetting = (field: NewRunSettingField) => {
    if (field === "preset") {
      const presets = ["plan", "orchestrate", "implement", "review", "assistant", "unrestricted"];
      const next = presets[(presets.indexOf(newrun.preset) + 1) % presets.length]!;
      applyPreset(next);
      return;
    }
    if (field === "verification") {
      const values: NewRunState["verification"][] = ["direct", "verified", "redundant"];
      newrun.verification = values[(values.indexOf(newrun.verification) + 1) % values.length]!;
      return;
    }
    if (field === "issues") {
      const values: NewRunState["issues"][] = ["required", "optional", "disabled"];
      newrun.issues = values[(values.indexOf(newrun.issues) + 1) % values.length]!;
      return;
    }
    if (field === "ask") { newrun.ask = !newrun.ask; return; }
    if (field === "approval") { newrun.approval = newrun.approval === "human" ? "agent" : "human"; return; }
    if (field === "ambiguity") {
      const values: NewRunState["ambiguity"][] = ["strict", "precise", "adaptive", "autonomous"];
      newrun.ambiguity = values[(values.indexOf(newrun.ambiguity) + 1) % values.length]!;
      return;
    }
    if (field === "minFit") {
      const values: Array<number | null | undefined> = [undefined, 6, 6.5, 7, 7.5, 8, 8.5, 0];
      newrun.minFit = values[(values.findIndex((value) => value === newrun.minFit) + 1) % values.length];
      return;
    }
    const floors: NewRunState["floors"][] = ["role", "strict", "off"];
    newrun.floors = floors[(floors.indexOf(newrun.floors) + 1) % floors.length]!;
  };

  const effectivePolicy = (repoRoot = l.repoRoot): Policy | undefined => {
    try { return loadPolicy(layout(repoRoot)); } catch { return undefined; }
  };

  const orchestrateCandidates = (): Array<{ scope: OrchestrationScope; ref?: IssueRef }> => {
    const cached = readIssueCache(l)?.issues ?? [];
    return [
      { scope: "project" },
      ...cached.filter((issue) => issue.kind === "epic").map((issue) => ({ scope: "epic" as const, ref: issue.ref })),
      ...cached.filter((issue) => issue.kind === "feature").map((issue) => ({ scope: "feature" as const, ref: issue.ref })),
    ];
  };

  const modelPreview = (): {
    context: ContextPreview;
    model?: CatalogueRow;
    fit?: number;
    estimate?: { inputTokens: number; outputTokens: number };
    error?: string;
    policy?: Policy;
    machine?: MachineConfig;
  } => {
    const newRunLayout = layout(newRunRepo);
    // Everything below depends on the repo/issue, not on the text being typed.
    // Cache it for the duration of an insert session so keystrokes stay cheap.
    const previewKey = `${newRunRepo}\0${refKey(newrun.issue)}`;
    const previewTtl = newRunInsert ? 60_000 : 5_000;
    if (
      !newRunPreviewCache ||
      newRunPreviewCache.key !== previewKey ||
      Date.now() - newRunPreviewCache.at > previewTtl
    ) {
      const cache = readIssueCache(newRunLayout);
      const statuses = providerStatuses(createModelsCollection());
      const machine = (() => { try { return loadMachineConfig(newRunLayout); } catch { return undefined; } })();
      newRunPreviewCache = {
        key: previewKey,
        at: Date.now(),
        context: previewContext(newRunLayout, cache?.issues ?? [], newrun.issue, "", {
          planFile: machine?.context.planFile,
          knowledgeIndex: machine?.context.knowledgeIndex,
        }),
        policy: effectivePolicy(newRunRepo),
        machine,
        catalogue: loadCatalogue(newRunLayout.catalogueFile),
        configured: new Set(statuses.filter((status) => status.configured).map((status) => status.id)),
        availability: loadAvailability(l.home),
      };
    }
    const base = newRunPreviewCache;
    const context: ContextPreview = { ...base.context, promptChars: newrun.prompt.length };
    const policy = base.policy;
    const machine = base.machine;
    const catalogue = base.catalogue;
    if (!policy || !machine || !catalogue) return { context, error: "configuration/catalogue unavailable", machine };
    const ap = policy.agents[newrun.agent];
    if (!ap) return { context, error: `unknown agent ${newrun.agent}`, machine };
    const resolved = resolveAgent(newRunLayout, newrun.agent, {
      agentPolicy: ap,
      machineOverrides: machine.agents[newrun.agent],
      runOverrides: {
        preset: newrun.preset,
        verification: newrun.verification,
        issues: newrun.issues,
        ask: newrun.ask,
        approval: newrun.approval,
        ambiguity: newrun.ambiguity,
      },
    });
    const toolChars = toolSchemaChars(
      resolved.def.tools.filter((tool) => tool !== "issue" || newrun.issues !== "disabled"),
    );
    const effective = { ...ap, minAxes: { ...(ap.minAxes ?? {}) } };
    if (newrun.minFit !== undefined) effective.minFit = newrun.minFit ?? 0;
    if (newrun.floors === "off") {
      effective.minFit = 0;
      for (const axis of CAPABILITY_AXES) effective.minAxes[axis] = 0;
    }
    if (newrun.floors === "strict") {
      for (const axis of CAPABILITY_AXES) {
        const current = effective.minAxes[axis] ?? ap.minFit;
        effective.minAxes[axis] = Math.min(10, Math.round((current + 0.5) * 10) / 10);
      }
    }
    const select = (requireModel?: string) => pick({
      agent: newrun.agent,
      policy: effective,
      machine,
      catalogue: catalogue.models,
      configuredProviders: base.configured,
      availability: base.availability,
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: context.chars + context.promptChars + toolChars,
      tier: newrun.tier,
      requireModel,
    });
    let result = select(newrun.model);
    if ("error" in result && newrun.model) {
      // A fork or an earlier pick can leave a pin that is now cooling,
      // unfunded, or below this agent's floors. Prefer auto-selection over a
      // dead end, and say what happened.
      const pinned = newrun.model;
      const fallback = select(undefined);
      if (!("error" in fallback)) {
        newrun.model = undefined;
        notify(`pinned model ${pinned} is not eligible; using auto-selection`);
        result = fallback;
      }
    }
    if ("error" in result) {
      const reasons = Object.entries(result.rejectedByReason)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => `${modelReasonLabel(reason)} ${count}`)
        .join(", ");
      const pin = newrun.model ? ` · pinned ${newrun.model}` : "";
      return {
        context,
        error: reasons ? `${result.error} (${reasons})${pin}` : `${result.error}${pin}`,
        policy,
        machine,
      };
    }
    return {
      context,
      model: result.selected,
      fit: result.candidates.find((candidate) => candidate.key === result.selected.key)?.fit,
      estimate: result.estimate,
      policy,
      machine,
    };
  };

  const buildNewRunArgs = (): string[] | null => {
    if (newrun.prompt.trim().length === 0) {
      notify("type a task before starting");
      return null;
    }
    const modelState = modelPreview();
    if (modelState.error) {
      notify(`no model is ready: ${modelState.error}`);
      return null;
    }
    const policy = effectivePolicy(newRunRepo);
    const newRunLayout = layout(newRunRepo);
    const machine = newRunPreviewCache?.machine ?? (() => {
      try { return loadMachineConfig(newRunLayout); } catch { return undefined; }
    })();
    const issueAccess = resolveAgentConfig({
      role: newrun.agent,
      agentPolicy: policy?.agents[newrun.agent],
      machineOverrides: machine?.agents[newrun.agent],
    }).issueAccess ?? agentDef(newRunLayout, newrun.agent).issueAccess;
    const selectedIssue = newrun.issue ? issueByRef(newrun.issue) : undefined;
    const planningAgent = newrun.agent === "planner" || newrun.agent === "review";
    if (selectedIssue?.reserved && !planningAgent) {
      const allowed =
        (newrun.agent === "sudo" && selectedIssue.kind === "task") ||
        (newrun.agent === "general" && selectedIssue.kind !== "task");
      if (!allowed) {
        notify(`${newrun.agent} cannot attach to a reserved Planning & Review anchor; choose a deliverable Task.`);
        return null;
      }
    }
    if (
      !planningAgent &&
      newrun.agent !== "general" &&
      selectedIssue &&
      selectedIssue.kind !== "task" &&
      issueAccess !== "create"
    ) {
      notify(`${newrun.agent} attaches to a Task. Choose a Task or an agent with issue creation access.`);
      return null;
    }
    const args = [
      "run",
      "--agent", newrun.agent,
      ...(newrun.model ? ["--model", newrun.model] : []),
      "--tier", newrun.tier,
      "--preset", newrun.preset,
      "--verify", newrun.verification,
      "--issues", newrun.issues,
      "--ask", String(newrun.ask),
      "--approval", newrun.approval,
      "--ambiguity", newrun.ambiguity,
      ...(newRunParentId ? ["--parent", newRunParentId] : []),
    ];
    if (newrun.floors === "off") {
      args.push("--min-fit", "0");
    } else if (newrun.minFit !== undefined) {
      args.push("--min-fit", String(newrun.minFit ?? 0));
    }
    if (newrun.floors === "off") {
      args.push("--min-axes", "reasoning=0,code=0,agentic=0,general=0");
    } else if (newrun.floors === "strict") {
      const ap = policy?.agents[newrun.agent];
      const floors = CAPABILITY_AXES.map((axis) => {
        const current = ap?.minAxes?.[axis] ?? ap?.minFit ?? 6;
        return `${axis}=${Math.min(10, Math.round((current + 0.5) * 10) / 10)}`;
      });
      args.push("--min-axes", floors.join(","));
    }
    if (newrun.issue) {
      args.push("--issue", String(newrun.issue.number));
      if (!planningAgent && issueAccess === "create" && selectedIssue && selectedIssue.kind !== "task") args.push("--auto-issue");
    }
    const excludedSections = [...newRunContextExcluded]
      .filter((key) => key.startsWith("section:"))
      .map((key) => key.slice("section:".length));
    const excludedItems = [...newRunContextExcluded].filter((key) => !key.startsWith("section:"));
    if (excludedSections.length > 0 || excludedItems.length > 0) {
      args.push("--context-exclude", JSON.stringify({ sections: excludedSections, items: excludedItems }));
    }
    const includedKnowledge = [...newRunContextIncluded]
      .filter((key) => key.startsWith("knowledge:"))
      .map((key) => key.slice("knowledge:".length));
    if (includedKnowledge.length > 0) {
      args.push("--context-include", JSON.stringify({ knowledge: includedKnowledge }));
    }
    args.push(newrun.prompt);
    return args;
  };

  const submitNewRun = () => {
    newRunColon = false;
    const args = buildNewRunArgs();
    if (!args) return;
    if (launch(args, newRunRepo)) {
      notify("run started; opening it when the record appears");
      screen = "list";
      page = "runs";
      selectedRunId = null;
    }
  };

  const answerRun = (run: RunRow | RunSummary | undefined) => {
    const summary = "run" in (run ?? {}) ? (run as RunRow & { run: RunSummary }).run : (run as RunSummary | undefined);
    if (!summary) return;
    const detail = findRunDetail(summary.id);
    if (!detail) { notify("run record not found"); return; }
    const pending = latestUnansweredQuestion(
      detail.events.filter((event) => event.type === "question") as Array<{ questionId?: string; text?: string }>,
      readInbox(detail.dir),
    );
    if (!pending?.questionId) { notify("no pending question"); return; }
    selectedRunId = detail.summary.id;
    answerQuestionId = pending.questionId;
    answerText = "";
    screen = "answer";
  };

  const interrupt = (summary: RunSummary | undefined) => {
    if (!summary || summary.status !== "running") { notify("run is not running"); return; }
    const dir = join(summary.repoRoot, ".machine_code", "local", "runs", summary.id);
    let seq = 1;
    try {
      const ack = JSON.parse(readFileSync(join(dir, "control.ack"), "utf8")) as { seq?: number };
      if (typeof ack.seq === "number") seq = ack.seq + 1;
    } catch { /* no ack */ }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "control"), JSON.stringify({ seq, action: "interrupt", from: process.pid }) + "\n", "utf8");
      notify("interrupt requested");
    } catch { notify("could not write control request"); }
  };

  const startCorrect = (summary: RunSummary | undefined) => {
    if (!summary) return;
    selectedRunId = summary.id;
    correctText = "";
    screen = "correct";
  };

  const submitCorrection = () => {
    if (!selectedRunId || correctText.trim().length === 0) { notify("type a correction"); return; }
    const args = ["correct", selectedRunId, correctText];
    if (launch(args)) {
      notify("correction queued; opening the child run when it appears");
      screen = "list";
      page = "runs";
    }
  };

  const approveSelected = (issue: Issue | undefined, run: RunSummary | undefined, repoRoot = l.repoRoot) => {
    const target = run?.prNumber && run.prState === "open" ? run.prNumber : issue?.ref.number;
    if (!target) { notify("nothing to approve"); return; }
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cliPath, "approve", String(target)], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    notify(`approval requested for ${target}`);
  };

  const runDetailData = (): RunDetail | null => (selectedRunId ? findRunDetail(selectedRunId) : null);

  const currentChanges = (detail: RunDetail): ChangeSummary => {
    if (changesCache && changesCache.runId === detail.summary.id && Date.now() - changesCache.at < 4_000) {
      return changesCache.data;
    }
    const data = changesFor(detail.summary.worktree);
    changesCache = { runId: detail.summary.id, at: Date.now(), data };
    return data;
  };

  const searchSeed = (): string => {
    if (page === "runs") return runsText;
    if (page === "models") return modelText;
    return searchText;
  };

  const applySearch = () => {
    if (page === "runs") runsText = searchText;
    else if (page === "models") modelText = searchText;
    searchMode = false;
  };

  /* --------------------------------------------------------------- render */

  const draw = () => {
    const cols = Math.max(20, process.stdout.columns || 120);
    const rows = Math.max(6, process.stdout.rows || 40);
    const narrow = cols < 84;
    /** Run rows need the wider one-line layout; below this they stack identity and request. */
    const runNarrow = cols < 120;
    const short = rows < 24;
    const footerReserve = cols < 50 ? 7 : cols < 70 ? 6 : cols < 90 ? 5 : cols < 110 ? 4 : 3;
    // The composer and models pages never need the run list; skipping the
    // filesystem walk there keeps prompt typing responsive.
    const needRunData =
      pendingRunAt > 0 ||
      page === "orchestrate" ||
      (page === "runs" && (screen === "list" || screen === "issue" || screen === "run"));
    const allRuns = needRunData ? listAllRuns(l.home) : [];
    const cache = needRunData ? readIssueCache(l) : undefined;
    if (needRunData) issueCachesByRepo = collectIssueCaches(allRuns);
    const issues = needRunData ? issueCachesByRepo.get(l.repoRoot) ?? cache?.issues ?? [] : [];
    const counts = needRunData ? headerCounts(allRuns) : headerCounts([]);
    const settingsMachine = (() => { try { return loadMachineConfig(l); } catch { return undefined; } })();
    const theme = resolveTheme(settingsMachine?.theme);
    if (toast && Date.now() - toastAt > 8_000) toast = "";

    // Resolve a newly launched run before the header is built, so the first
    // frame already shows the run-detail chrome.
    if (pendingRunAt > 0) {
      const fresh = allRuns
        .filter((run) => new Date(run.startedAt).getTime() >= pendingRunAt - 1_500)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
      if (fresh) {
        selectedRunId = fresh.id;
        runSection = "overview";
        screen = "run";
        page = "runs";
        pendingRunAt = 0;
        notify(`opened new run ${fresh.id.slice(-8)}`);
      } else if (Date.now() - pendingRunAt > 15_000) {
        pendingRunAt = 0;
      }
    }

    const runsListScreen = page === "runs" && screen === "list";
    const runIndicators = [
      `${C}●${R} ${counts.active} running`,
      `${Y}?${R} ${counts.awaiting} awaiting`,
      `${Y}⏸${R} ${counts.paused} paused`,
    ];
    const statusTokens = [`${Y}PR${R} ${counts.openPrs} open`];

    const catalogue = page === "models" ? loadCatalogue(l.catalogueFile) : null;
    const statuses = page === "models" ? providerStatuses(createModelsCollection()) : [];
    const activeProviders = new Set(statuses.map((status) => status.id));
    // Hide stale rows for providers that are disabled or no longer registered.
    const catalogueRows = (catalogue?.models ?? []).filter((row) => activeProviders.has(row.providerID));
    const configured = new Set(statuses.filter((status) => status.configured).map((status) => status.id));
    const modelRows = page === "models"
      ? filterModels(catalogueRows, {
          text: modelText,
          providers: modelsAll ? undefined : configured,
          freeOnly: modelsFree,
          codingOnly: modelsCoding,
          sort: modelSort,
          weights: policyWeightsFor(newrun.agent),
        })
      : [];
    if (modelSel >= modelRows.length) modelSel = Math.max(0, modelRows.length - 1);
    const selectedModel = modelRows[modelSel];

    const settingsPolicy = page === "settings" ? effectivePolicy() : undefined;
    const settingsRows = page === "settings" ? buildSettings(l, settingsMachine, settingsPolicy) : [];
    if (settingsSel >= settingsRows.length) settingsSel = Math.max(0, settingsRows.length - 1);

    const tabTokens = TABS.map((tab) =>
      tab.id === page
        ? `${theme.tabActiveBg}${theme.tabActiveFg}${B} ${tab.key}:${tab.label} ${R}`
        : `${theme.headerFg}${D}${tab.key}:${tab.label}${R}`,
    );
    // Detail screens replace the whole header (tabs included) with a Back bar.
    const runDetailHeader = page === "runs" && screen === "run";
    const backHeader =
      runDetailHeader ||
      (page === "runs" && (screen === "newrun" || screen === "answer" || screen === "correct")) ||
      (page === "models" && screen === "model");
    // Tabs stay visible on every other screen. Runs and models replace the
    // blank separator with a live summary line; other pages keep the blank.
    const backTitle =
      page === "runs" && screen === "newrun"
        ? `  ${B}${theme.headerFg}New Run${R}`
        : runDetailHeader
          ? `  ${B}${theme.headerFg}Run Details${R}`
          : page === "models" && screen === "model"
            ? `  ${B}${theme.headerFg}Model Details${R}`
            : "";
    const headerRight =
      page === "runs" && screen === "newrun" && !newRunInsert && !modelPick && !issuePick && !newRunSettings
        ? command("s", "Settings", undefined, M)
        : "";
    const backLine = `${theme.backBg}${theme.backFg}${B} Back[Esc] ${R}${backTitle}`;
    const headerSubLines = runsListScreen
      ? wrapTokenList([...runIndicators, ...statusTokens], cols, "  ").map((line) => ` ${line}`)
      : page === "models" && screen === "list"
        ? [` ${D}${modelRows.length} model(s)${modelText ? ` · “${modelText}”` : ""}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`]
        : [""];
    const rightHeaderPath = (path: string): string => {
      const text = trunc(path, Math.max(10, cols - 2));
      return `${" ".repeat(Math.max(0, cols - visible(text) - 1))}${GR}${text}${R}`;
    };
    const backSubLine = page === "runs" && screen === "newrun" ? rightHeaderPath(newRunRepo) : "";
    const header: string[] = backHeader
      ? [
          headerRight
            ? `${backLine}${" ".repeat(Math.max(2, cols - visible(backLine) - visible(headerRight)))}${headerRight}`
            : backLine,
          backSubLine,
        ]
      : [...wrapTokenList(tabTokens, cols, " "), ...headerSubLines];
    // The header shares the body surface; only the Back label keeps its own tone.
    const headerTone = theme.bodyBg;
    // Prompt editing moves its controls into the body but keeps the model line.
    const hideFooter = screen === "newrun" && newRunInsert;
    const bodyH = Math.max(1, rows - header.length - footerReserve);

    const filteredRuns = runsListScreen
      ? runsFilter === "all" || runsFilter === "attention"
        ? allRuns
        : filterRuns(allRuns, runsFilter)
      : [];
    const runIndex = buildRunIndex({
      runs: filteredRuns,
      issuesByRepo: runsListScreen ? issueCachesByRepo : new Map(),
      group: runsGroup,
      collapsed,
      text: runsText,
      attentionOnly: runsAttention || runsFilter === "attention",
      preferredRepo: l.repoRoot,
    });
    if (runsSel >= runIndex.selectable.length) runsSel = Math.max(0, runIndex.selectable.length - 1);
    const selectedRow = runIndex.selectable[runsSel];

    let body: string[] = [];
    let actions = "";
    /** A second footer command row for view controls that would otherwise crowd the main one. */
    let extraActions = "";
    let secondary = "";
    /** New-run content pinned to the bottom of the body, directly above the footer. */
    let bottomAlign: { above: string[]; block: string[]; filler?: string } | null = null;
    /** True when `secondary` already carries its own styling (new-run model info). */
    let secondaryStyled = false;
    /** Run details show only the working directory in their footer. */
    let runCwd = "";
    let runHints = "";
    /** Right-aligned MAP/SEM/LSP status for the bottom footer. */
    let footerMapTokens: string[] = [];
    /** Context usage shown at the far left of the index footer row. */
    let footerCtx = "";
    /** Override for the bottom footer band; new-run uses the body surface. */
    let footerBandTone = "";

    const clipBody = (lines: string[]) => {
      if (lines.length > bodyH) return lines.slice(0, bodyH);
      return [...lines, ...Array.from({ length: bodyH - lines.length }, () => "")];
    };

    /* ------------------------------------------------------------- runs */
    if (page === "runs" && screen === "list") {
      const lines: string[] = [];
      if (runsGroup === "gh-issue" && issueCachesByRepo.size === 0) {
        lines.push(` ${Y}No issue cache yet.${R} ${D}Runs without issues are listed under Untracked; press r to refresh when gh is available.${R}`);
        lines.push("");
      }
      const selectedId = selectedRow?.id;
      let selectedEndLine = lines.length;
      for (const row of runIndex.rows) {
        const isSelected = row.id === selectedId;
        const indent = "  ".repeat(row.depth);
        const rendered: string[] = [];
        if (row.kind === "repo") {
          const text = ` ${row.collapsed ? "▸" : "▾"} ${B}${W}${row.label}${R}${narrow ? "" : `  ${D}${trunc(row.repoRoot, Math.max(20, cols - row.label.length - 16))}${R}`} ${D}(${row.count})${R}`;
          rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
        } else if (row.kind === "section") {
          const tone = row.tone === "status" ? Y : row.tone === "orphaned" ? Y : row.tone === "issues" ? C : GR;
          const text = ` ${indent}${B}${theme.sectionFg}${tone}${row.collapsed ? "▸" : "▾"} ${row.label}${R} ${D}(${row.count})${R}`;
          rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
        } else if (row.kind === "issue") {
          const roll = row.rollup;
          const detail = issueRowDetail(cols);
          const badge = detail === "identity" || !row.issue.reserved ? "" : `${M}[P&R]${R} `;
          const left = `${indent}${row.collapsible ? (row.collapsed ? "▸" : "▾") : " "} ${issueIcon(row.issue)} ${BL}#${row.issue.ref.number}${R} ${D}${row.issue.kind}${R} ${badge}${B}${W}${row.issue.title}${R}`;
          const parts: string[] = [];
          if (detail !== "identity") {
            if (!row.issue.reserved && roll.pct !== undefined) {
              const width = detail === "full" ? 6 : 4;
              parts.push(`${progress(roll.pct, width)} ${String(roll.pct).padStart(3)}%`);
            }
            if ((detail === "full" || detail === "medium") && row.issue.kind !== "task" && !row.issue.reserved && roll.tasksTotal > 0) {
              parts.push(`${D}${roll.tasksClosed}/${roll.tasksTotal} tasks${R}`);
            }
            parts.push(detail === "compact"
              ? `${roll.runsTotal}r`
              : `${roll.runsTotal} run${roll.runsTotal === 1 ? "" : "s"}${roll.runsActive ? ` ${C}${roll.runsActive}●${R}` : ""}`);
            if (detail === "full") {
              if (roll.prState) parts.push(`${Y}PR ${roll.prState}${R}`);
              parts.push(`${D}${fmtMoney(roll.cost)} · ${ago(roll.lastActivity)}${R}`);
            }
          }
          const right = parts.join("  ");
          const text = right
            ? ` ${pad(left, Math.max(20, cols - visible(right) - 2))}${right}`
            : ` ${trunc(left, Math.max(12, cols - 1))}`;
          rendered.push(selected(text, isSelected));
        } else {
          const run = row.run;
          const ask = run.status === "awaiting_input" ? ` ${Y}ASK${R}` : "";
          const pr = run.prNumber ? ` ${D}PR#${run.prNumber} ${run.prState ?? ""}${R}` : "";
          const reason = run.stopReason && run.stopReason !== "completed" ? ` ${D}${run.stopReason}${R}` : "";
          const repoTag = runsGroup === "overall" ? ` ${D}[${repoLabel(run.repoRoot)}]${R}` : "";
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
        if (isSelected) {
          selectedEndLine = lines.length + rendered.length - 1;
        }
        lines.push(...rendered);
      }
      if (runIndex.rows.length === 0) {
        lines.push("");
        lines.push(` ${D}No runs here yet. Press ${C}n${R}${D} to start one.${R}`);
      }
      const windowed = selectableLines(lines, Math.min(selectedEndLine, Math.max(0, lines.length - 1)), runsScroll, bodyH);
      runsScroll = windowed.scroll;
      body = clipBody(windowed.lines);
      actions = narrow
        ? joinCommands([
            command("n", "New", undefined, C),
            command("Enter", "Open", undefined, G),
            command("space", "Fold", undefined, Y),
            command("j/k", "Move", undefined, M),
            command("/", "Search", undefined, BL),
          ])
        : joinCommands([
            command("n", "New run", undefined, C),
            command("Enter", "Open", undefined, G),
            command("space", "Fold", undefined, Y),
            command("j/k", "Move", undefined, M),
            command("/", "Search", undefined, BL),
          ]);
      extraActions = joinCommands([
        command("g", "Group", RUN_GROUP_LABELS[runsGroup], C),
        command("f", "Filter", runsFilter, M),
      ]);
      if (toast) secondary = `${Y}${toast}${R}`;
    }

    /* ------------------------------------------------------------ issue */
    else if (page === "runs" && screen === "issue") {
      const issue = selectedIssue();
      if (!issue) {
        screen = "list";
        return draw();
      }
      const issueRoot = issueRepoOf(issue.ref) ?? l.repoRoot;
      const repoIssues = issueCachesByRepo.get(issueRoot) ?? issues;
      const preview = previewContext(layout(issueRoot), repoIssues, issue.ref);
      const issueRuns = sortRuns(allRuns.filter((run) => refKey(run.issue) === refKey(issue.ref)), "activity");
      const ancestors: Issue[] = [];
      let parentRef = issue.parent;
      while (parentRef) {
        const parent = issueByRef(parentRef);
        if (!parent) break;
        ancestors.push(parent);
        parentRef = parent.parent;
      }
      const lines: string[] = [];
      lines.push(` ${issueIcon(issue)} ${BL}#${issue.ref.number}${R} ${B}${W}${issue.title}${R} ${D}${issue.kind} · ${issue.state}${R}${issue.reserved ? ` ${M}[P&R]${R}` : ""}`);
      if (ancestors.length) lines.push(` ${D}${ancestors.reverse().map((parent) => `#${parent.ref.number} ${parent.title}`).join("  ←  ")}${R}`);
      lines.push(` ${D}${issue.labels.join(" · ") || "no labels"}${R}`);
      if (issue.blockedBy.length) lines.push(` ${Y}blocked by ${issue.blockedBy.map((ref) => `#${ref.number}`).join(", ")}${R}`);
      lines.push("");
      for (const line of wrapText(issue.body || "(no body)", Math.max(20, cols - 4)).slice(0, short ? 4 : 10)) lines.push(` ${W}${line}${R}`);
      if (issue.acceptance.length) {
        lines.push("", ` ${B}${C}Acceptance${R}`);
        for (const item of issue.acceptance.slice(0, 8)) lines.push(`   ${G}✓${R} ${W}${item}${R}`);
      }
      lines.push("", ` ${B}${C}Context cascade${R} ${D}${preview.chars.toLocaleString()} chars · ${preview.sources.length} source(s)${R}`);
      const ctxBits = [
        preview.artifacts.files.length ? `files ${preview.artifacts.files.length}` : "",
        preview.artifacts.knowledge.length ? `knowledge ${preview.artifacts.knowledge.length}` : "",
        preview.artifacts.references.length ? `references ${preview.artifacts.references.length}` : "",
        preview.artifacts.tools.length ? `tools ${preview.artifacts.tools.length}` : "",
        preview.artifacts.scripts.length ? `scripts ${preview.artifacts.scripts.length}` : "",
      ].filter(Boolean).join(" · ");
      lines.push(`   ${ctxBits || `${D}(none declared; hierarchy only)${R}`}`);
      for (const artifact of [...preview.artifacts.tools, ...preview.artifacts.scripts].slice(0, 6)) {
        lines.push(`   ${M}${artifact.kind}${R} ${W}${artifact.name}${R} ${D}${artifact.description}${R}`);
      }
      if (preview.warnings.length) lines.push(`   ${Y}${preview.warnings.slice(0, 3).join("; ")}${R}`);
      lines.push("", ` ${B}${C}Runs${R} ${D}${issueRuns.length}${R}`);
      if (issueRuns.length === 0) lines.push(`   ${D}none — press n to start one under this issue${R}`);
      const runStart = lines.length;
      for (let i = 0; i < issueRuns.length; i++) {
        const run = issueRuns[i]!;
        const isSelected = i === Math.min(issueRunSel, issueRuns.length - 1);
        const line = `   ${icon(run.status)} ${D}${runIdFromEvent(run)}${R} ${agentTone(run.agent)}${run.agent}${R}${run.mode ? `/${run.mode}` : ""}  ${D}${fmtTokens(run.usage.totalTokens)} tok · ${fmtMoney(run.cost.actual)} · ${ago(run.lastActivityAt)}${R}`;
        lines.push(selected(line, isSelected));
      }
      const w = selectableLines(lines, Math.max(0, runStart + issueRunSel), issueScroll, bodyH);
      issueScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("n", "New run", undefined, C),
        command("Enter", "Open", undefined, G),
        command("j/k", "Select", undefined, M),
        command("p", "Approve", undefined, Y),
        command("o", "Open URL", undefined, BL),
        command("Esc", "Back", undefined, GR),
      ]);
      secondary = `${D}${issue.kind} #${issue.ref.number} · ${issueRuns.length} run(s) · ${preview.chars.toLocaleString()} context chars${toast ? ` · ${Y}${toast}${R}` : ""}${R}`;
    }

    /* ---------------------------------------------------------- new run */
    else if (screen === "newrun") {
      footerMapTokens = mapStatusTokens(newRunRepo);
      footerBandTone = theme.bodyBg;
      const preview = modelPreview();
      const ctx = preview.context;
      const ap = preview.policy?.agents[newrun.agent];
      const def = agentDef(layout(newRunRepo), newrun.agent);
      const issueChain = ctx.issueChain;
      const issueObj = newrun.issue ? issueByRef(newrun.issue) : undefined;
      const issueValue = newrun.issue ? `#${newrun.issue.number} ${issueObj?.kind ?? ""}`.trim() : "NA";
      const displayAgent = newrun.agent ? `${newrun.agent[0]!.toUpperCase()}${newrun.agent.slice(1)}` : newrun.agent;
      const resolvedAgent = resolveAgent(layout(newRunRepo), newrun.agent, {
        agentPolicy: ap,
        machineOverrides: preview.machine?.agents[newrun.agent],
        runOverrides: {
          preset: newrun.preset,
          verification: newrun.verification,
          issues: newrun.issues,
          ask: newrun.ask,
          approval: newrun.approval,
          ambiguity: newrun.ambiguity,
        },
      });
      const issueAccess = resolvedAgent.config.issueAccess ?? def.issueAccess;
      const planningAgent = newrun.agent === "planner" || newrun.agent === "review";
      const issueOutcome = (() => {
        if (!newrun.issue) return "no issue · run is untracked";
        if (!issueObj) return "issue is not in the cache";
        if (issueObj.reserved) {
          if (planningAgent) return "planning/review attaches to reserved Task 0";
          if (newrun.agent === "general" && issueObj.kind !== "task") {
            return "general attaches to reserved Task 0";
          }
          if (newrun.agent === "sudo" && issueObj.kind === "task") return "runs attach here";
          return "reserved anchor · choose a deliverable Task";
        }
        if (issueObj.kind === "task") return "runs attach here";
        if (planningAgent) return "planning/review attaches to reserved Task 0";
        if (newrun.agent === "general") return "general attaches to reserved Task 0";
        if (issueAccess === "create") {
          return issueObj.kind === "epic" ? "will auto-create a Feature and Task" : "will auto-create a Task";
        }
        return "choose a Task or an agent with issue creation access";
      })();
      const displayTier = newrun.tier === "free" ? "Free" : "Paid";
      const itemsFor = (kinds: readonly string[]) =>
        ctx.sources
          .filter((source) => kinds.includes(source.kind))
          .map((source) => ({
            text: source.note ? `${source.ref} · ${source.note}` : source.ref,
            chars: source.chars,
            exists: source.exists,
            key: `${source.kind}:${source.ref}`,
          }));
      const referencedToolChars = new Map(
        ctx.sources.filter((source) => source.kind === "tool").map((source) => [source.ref, source.chars]),
      );
      const newRunLayout = layout(newRunRepo);
      const artifacts = listArtifacts(newRunLayout);
      const toolItems = toolListItems(
        resolvedAgent.def.tools.filter((tool) => tool !== "issue" || newrun.issues !== "disabled"),
        issueAccess,
        artifacts
          .filter((artifact) => artifact.kind === "tool")
          .map((artifact) => ({ name: artifact.name, description: artifact.description })),
        referencedToolChars,
      );
      const knowledgeItems: ContextPanelItem[] = itemsFor(["knowledge"]);
      const referenceItems: ContextPanelItem[] = itemsFor(["reference"]);
      const knownKnowledge = new Set(knowledgeItems.map((item) => item.key));
      for (const path of discoverKnowledgeFiles(newRunLayout)) {
        const key = `knowledge:${path}`;
        if (knownKnowledge.has(key)) continue;
        let size = 0;
        try {
          size = statSync(join(newRunLayout.repoRoot, path)).size;
        } catch {
          // keep the row visible with an unknown size
        }
        knowledgeItems.push({
          text: `${path} · available`,
          chars: size,
          exists: true,
          key,
          available: true,
          counted: false,
        });
      }
      const scriptItems: ContextPanelItem[] = itemsFor(["script"]);
      const knownScripts = new Set(scriptItems.map((item) => item.key));
      for (const artifact of artifacts.filter((item) => item.kind === "script")) {
        const key = `script:${artifact.name}`;
        if (knownScripts.has(key)) continue;
        let size = 0;
        const path = artifactPath(newRunLayout, artifact);
        if (path) {
          try {
            size = statSync(path).size;
          } catch {
            // keep the row visible with an unknown size
          }
        }
        scriptItems.push({
          text: `${artifact.name} · script · available`,
          chars: size,
          exists: true,
          key,
          available: true,
          counted: false,
        });
      }
      const skillSources = ctx.sources.filter((source) => source.kind === "skill");
      const aggregateSkill = skillSources.find((source) => /^\d+ skills$/.test(source.ref));
      const skillItems: ContextPanelItem[] = aggregateSkill
        ? skillListItems(skillMetas(newRunLayout), aggregateSkill.chars)
        : [];
      const bodyChars = new Map<string, number>();
      for (const source of skillSources) {
        if (source === aggregateSkill) continue;
        bodyChars.set(source.ref, (bodyChars.get(source.ref) ?? 0) + source.chars);
      }
      for (const item of skillItems) {
        const name = item.key.slice("skill:".length);
        item.chars += bodyChars.get(name) ?? 0;
        bodyChars.delete(name);
      }
      for (const [name, chars] of bodyChars) {
        skillItems.push({ text: name, chars, exists: true, key: `skill:${name}` });
      }
      const roleFit = ap ? (newrun.tier === "free" ? ap.freeMinFit ?? ap.minFit : ap.minFit) : undefined;
      const floorText = newrun.floors === "role" ? `role${roleFit !== undefined ? ` ${roleFit}` : ""}` : newrun.floors;
      const fitText = newrun.minFit === undefined ? `role${roleFit !== undefined ? ` ${roleFit}` : ""}` : String(newrun.minFit);
      const estimateCost = preview.estimate
        ? fmtMoney(
            ((preview.estimate as { inputTokens: number }).inputTokens * (preview.model?.pricing.input ?? 0) +
              (preview.estimate as { outputTokens: number }).outputTokens * (preview.model?.pricing.output ?? 0)) /
              1_000_000,
          )
        : "?";
      const fitScore = preview.fit;
      const fitTone = fitScore === undefined ? D : fitScore >= 7.5 ? G : fitScore >= 6 ? Y : RED;
      const costTone = preview.model?.free ? G : RED;
      const modelIdentity = preview.error
        ? command("m", "Model", preview.error, RED)
        : command("m", "Model", preview.model?.key ?? "?", C);
      const fitPart = fitScore === undefined ? "" : `${D}fit${R} ${fitTone}${fitScore.toFixed(2)}${R}`;
      const isFree = Boolean(
        preview.model && (preview.model.free || (preview.model.pricing.input === 0 && preview.model.pricing.output === 0)),
      );
      const costPart = isFree ? `${G}free${R}` : `${D}cost${R} ${costTone}${estimateCost}${R}`;
      const detailParts = preview.model
        ? [
            `${D}${preview.model.kind}${R}`,
            `${D}ctx${R} ${C}${fmtContext(preview.model.context)}${R}`,
            ...(!isFree && preview.model.pricing.input > 0
              ? [`${D}in${R} ${Y}$${preview.model.pricing.input}/M${R}`]
              : []),
            ...(!isFree && preview.model.pricing.output > 0
              ? [`${D}out${R} ${Y}$${preview.model.pricing.output}/M${R}`]
              : []),
          ]
        : [];
      const modelInfo = preview.error
        ? ` ${modelIdentity}`
        : [
            ` ${[modelIdentity, fitPart, costPart, ...detailParts].filter(Boolean).join("  ")}`,
            ` ${[modelIdentity, fitPart, costPart].filter(Boolean).join("  ")}`,
            ` ${modelIdentity}`,
          ].find((line) => visible(line) <= cols) ?? ` ${modelIdentity}`;
      const floorsText = (() => {
        if (!ap) return "floors unavailable";
        if (newrun.floors === "off") return "floors off · fit 0";
        const fit =
          newrun.minFit === null
            ? 0
            : newrun.minFit ?? (newrun.tier === "free" ? ap.freeMinFit ?? ap.minFit : ap.minFit) ?? 0;
        const axes =
          newrun.floors === "strict"
            ? Object.fromEntries(
                CAPABILITY_AXES.map((axis) => [
                  axis,
                  Math.min(10, Math.round(((ap.minAxes?.[axis] ?? ap.minFit ?? 6) + 0.5) * 10) / 10),
                ]),
              )
            : newrun.tier === "free"
              ? { ...(ap.minAxes ?? {}), ...(ap.freeMinAxes ?? {}) }
              : ap.minAxes;
        return `${newrun.tier} floors ${newrun.floors} · fit ${fit.toFixed(1)} · axes ${axisFloorText(axes)}`;
      })();
      const minimumsText = trunc(`${D}${floorsText}${R}`, Math.max(10, cols - 1));
      const minimumsInfo = ` ${" ".repeat(Math.max(0, cols - visible(minimumsText) - 1))}${minimumsText}`;
      const issueSources = ctx.sources.filter((source) => source.kind === "issue");
      const issueItems: ContextPanelItem[] = [];
      for (let index = 0; index < issueChain.length; index++) {
        const issue = issueChain[index]!;
        const source = issueSources[index];
        const contextKind = index === 0 ? "task" : index === 1 ? "feature" : "epic";
        const files = ctx.sources.filter((item) => item.kind === "file" && item.depth === index);
        const otherContext = ctx.sources.filter(
          (item) =>
            item.depth === index &&
            (item.kind === "knowledge" ||
              item.kind === "reference" ||
              item.kind === "tool" ||
              item.kind === "script" ||
              (item.kind === "skill" && !/^\d+ skills$/.test(item.ref))),
        );
        const fileSummary = files.length > 0
          ? `${files.length} file${files.length === 1 ? "" : "s"}`
          : "no mc:context files";
        issueItems.push({
          text:
            `#${issue.ref.number} ${issue.kind} ${issue.title} · ${fileSummary}` +
            (otherContext.length > 0 ? ` · ${otherContext.length} other context` : ""),
          chars: source?.chars ?? 0,
          exists: source?.exists ?? true,
          key: `${contextKind}:${issue.ref.repo}#${issue.ref.number}`,
        });
        for (const file of files) {
          issueItems.push({
            text: `  ${file.ref}${file.note ? ` · ${file.note}` : ""}`,
            chars: file.chars,
            exists: file.exists,
            key: `file:${file.ref}`,
          });
        }
      }
      const mapEnabled = preview.machine?.map.enabled !== false;
      const semanticEnabled = mapEnabled && preview.machine?.map.semantic !== false;
      const cachedMap = readCachedMap(newRunRepo);
      const semantic = loadSemantic(newRunRepo);
      const semanticDirty = readSemanticDirty(newRunRepo);
      const mapChars = mapEnabled ? (cachedMap ? renderMapIndex(cachedMap).length : 1024) : 0;
      const semanticChars = semanticEnabled ? (semantic ? renderSemanticIndex(semantic).length : 1024) : 0;
      const codebaseItems = [
        {
          text: mapEnabled
            ? cachedMap
              ? `repo map · ${cachedMap.files.length} files · ${symbolCount(cachedMap)} symbols`
              : "repo map · builds on first turn"
            : "repo map · disabled",
          chars: mapChars,
          exists: mapEnabled && Boolean(cachedMap),
          key: "map:index",
        },
        {
          text: semanticEnabled
            ? semantic
              ? `semantic index · ${Object.keys(semantic.modules).length} modules${semanticDirty.length ? ` · ${semanticDirty.length} dirty` : ""}`
              : "semantic index · builds when available"
            : "semantic index · disabled",
          chars: semanticChars,
          exists: semanticEnabled && Boolean(semantic),
          key: "semantic:index",
        },
      ];
      const sections = [
        { label: "Issues", tone: Y, sectionKey: "section:issues", items: issueItems },
        { label: "Knowledge", tone: contextTone("knowledge"), sectionKey: "section:knowledge", items: knowledgeItems },
        { label: "References", tone: contextTone("reference"), sectionKey: "section:references", items: referenceItems },
        { label: "Skills", tone: contextTone("skill"), sectionKey: "section:skills", items: skillItems },
        { label: "Tools", tone: contextTone("tool"), sectionKey: "section:tools", items: toolItems },
        { label: "Scripts", tone: contextTone("script"), sectionKey: "section:scripts", items: scriptItems },
        { label: "Plans", tone: contextTone("plan"), sectionKey: "section:plans", items: itemsFor(["plan", "project"]) },
        { label: "Codebase", tone: BL, sectionKey: "section:codebase", items: codebaseItems },
      ];
      if (newRunContextTab >= sections.length) newRunContextTab = 0;
      const isIncludedAvailable = (item: unknown): boolean => {
        const row = item as ContextPanelItem;
        return row.available === true && row.key.startsWith("knowledge:") && newRunContextIncluded.has(row.key);
      };
      const isCounted = (item: unknown): boolean => {
        const row = item as ContextPanelItem;
        return row.counted !== false || isIncludedAvailable(row);
      };
      const isShownAvailable = (item: unknown): boolean => {
        const row = item as ContextPanelItem;
        return row.available === true && !isIncludedAvailable(row);
      };
      const excludedTokens = sections.reduce((sum, section) => {
        const sectionOff = newRunContextExcluded.has(section.sectionKey);
        return sum + section.items
          .filter((item) => {
            if (!isCounted(item)) return false;
            if ((item as { fixed?: boolean }).fixed) return false;
            return sectionOff || newRunContextExcluded.has(item.key);
          })
          .reduce((itemSum, item) => itemSum + tokensForChars(item.chars), 0);
      }, 0);
      const totalTokens = sections.reduce(
        (sum, section) =>
          sum +
          section.items
            .filter((item) => isCounted(item))
            .reduce((itemSum, item) => itemSum + tokensForChars(item.chars), 0),
        0,
      );
      const contextTokens = Math.max(0, totalTokens - excludedTokens) + tokensForChars(ctx.promptChars);
      footerCtx = `${C}ctx${R} ${W}${(contextTokens / 1000).toFixed(1)}K${R}`;
      // The context panel and prompt box share the same width.
      const panelWidth = Math.max(20, cols - 2);
      const panelLine = (line: string, isSelected = false, indent = false): string => {
        const body = line.startsWith(" ") ? line.slice(1) : line;
        const padded = fit(indent ? ` ${body}` : body, panelWidth);
        return ` ${isSelected ? selected(padded, true) : background(padded, PANEL_BG)}`;
      };
      const tabBar = wrapTokenList(
        sections.map((section, index) => {
          const label = newRunContextExcluded.has(section.sectionKey) ? `${section.label}✕` : section.label;
          return index === newRunContextTab
            ? `${theme.sectionActiveBg}${theme.sectionActiveFg}${B} ${label} ${R}`
            : `${theme.sectionFg}${label}${R}`;
        }),
        panelWidth,
        "  ",
      ).map((line) => panelLine(line, false, true));
      const activeSection = sections[newRunContextTab]!;
      newRunContextSectionKey = activeSection.sectionKey;
      newRunContextItemKeys = activeSection.items.map((item) => item.key);
      newRunContextItemAvailable = activeSection.items.map(
        (item) => (item as { available?: boolean }).available === true,
      );
      newRunContextItem = Math.min(newRunContextItem, Math.max(0, activeSection.items.length - 1));
      const sectionOff = newRunContextExcluded.has(activeSection.sectionKey);
      const availableItems = activeSection.items.filter((item) => isShownAvailable(item));
      const contextItems = activeSection.items.filter((item) => !isShownAvailable(item));
      const keptItems = contextItems.filter((item) => {
        if ((item as { fixed?: boolean }).fixed) return true;
        return !sectionOff && !newRunContextExcluded.has(item.key);
      });
      const sectionTokens = keptItems
        .filter((item) => isCounted(item))
        .reduce((sum, item) => sum + tokensForChars(item.chars), 0);
      const keptLabel = contextItems.length > 0 ? ` · ${keptItems.length}/${contextItems.length} kept` : "";
      const availableLabel = availableItems.length > 0 ? ` · ${availableItems.length} available` : "";
      const sectionHeader = panelLine(
        `${B}${activeSection.tone}${activeSection.label}${R} ${D}·${R} ${C}${fmtTokens(sectionTokens)}${R}` +
          `${D} tok${keptLabel}${availableLabel}${R}`,
        false,
        true,
      );
      const issueHint = activeSection.sectionKey === "section:issues"
        ? panelLine(` ${D}${issueOutcome}${R}`, false, true)
        : "";
      const itemRoom = Math.max(1, Math.floor(bodyH * 0.28));
      const itemStart = Math.max(
        0,
        Math.min(newRunContextItem - Math.floor(itemRoom / 2), Math.max(0, activeSection.items.length - itemRoom)),
      );
      const visibleItems = activeSection.items.slice(itemStart, itemStart + itemRoom);
      const itemLines: string[] = [];
      if (itemStart > 0) itemLines.push(panelLine(`  ${D}… ${itemStart} above${R}`));
      for (let offset = 0; offset < visibleItems.length; offset++) {
        const item = visibleItems[offset]!;
        const index = itemStart + offset;
        const fixed = (item as { fixed?: boolean }).fixed === true;
        const available = isShownAvailable(item);
        const excluded = !fixed && !available && (sectionOff || newRunContextExcluded.has(item.key));
        const mark = excluded ? `${RED}✕${R}` : available ? `${D}·${R}` : item.exists ? `${G}✓${R}` : `${Y}?${R}`;
        const count = `${D}${fmtTokens(tokensForChars(item.chars))}${available ? " avail" : ""}${R}`;
        const line = `  ${mark} ${W}${trunc(item.text, Math.max(12, cols - 30))}${R} ${count}`;
        itemLines.push(panelLine(line, index === newRunContextItem));
      }
      const remainingItems = activeSection.items.length - (itemStart + visibleItems.length);
      if (remainingItems > 0) itemLines.push(panelLine(`  ${D}… ${remainingItems} more${R}`));
      const compact = (key: string, label: string, tone: string): string =>
        `${B}${tone}${key}${R} ${D}${label}${R}`;
      const contextCommands = panelLine(
        joinCommands([
          compact("h/l", "tabs", Y),
          compact("j/k", "sel", M),
          `${B}${G}space${R} ${G}✓${R}${D}/${R}${RED}✕${R}`,
          !newRunInsert && activeSection.sectionKey === "section:issues"
            ? command("i", "Issue", issueValue, newrun.issue ? C : GR)
            : "",
        ]),
        false,
        true,
      );
      const summary = [
        modelInfo,
        minimumsInfo,
        "",
        ...tabBar,
        panelLine(""),
        sectionHeader,
        ...(issueHint ? [issueHint] : []),
        ...(itemLines.length ? itemLines : [panelLine(`  ${D}none${R}`)]),
      ];
      if (ctx.warnings.length > 0) summary.push(` ${Y}${ctx.warnings[0]}${R}`);

      const boxWidth = panelWidth;
      const inner = Math.max(12, boxWidth - 2);
      const promptText = newrun.prompt || (newRunInsert ? "" : "Press p to type the task");
      // Include the cursor before wrapping so a freshly typed trailing space is
      // not trimmed away until the next keystroke.
      const promptLines = wrapText(newRunInsert ? `${promptText}▌` : promptText, Math.max(8, inner - 3));
      const promptActions = newRunInsert
        ? joinCommands([
            command("Esc", "Done", undefined, Y),
            command("Enter", "Newline", undefined, G),
            command("Backspace", "Delete", undefined, M),
          ])
        : joinCommands([
            command("p", "Prompt", undefined, M),
            newrun.prompt.trim() ? commandBadge("Start", ":!", START_BG, WHITE) : "",
          ]);
      const promptControls = newRunInsert
        ? promptActions
        : joinCommands([
            command("a", "Agent", displayAgent, agentTone(newrun.agent)),
            command("t", "Tier", displayTier, tierTone(newrun.tier)),
            promptActions,
          ]);
      const promptHint = promptControls
        ? ` ${" ".repeat(Math.max(0, boxWidth - visible(promptControls)))}${promptControls}`
        : "";
      const availableForPrompt = Math.max(3, bodyH - summary.length - (promptHint ? 7 : 6));
      const promptHeight = Math.max(3, Math.min(16, availableForPrompt, Math.floor(bodyH * 0.5)));
      const shownPrompt = promptLines.slice(-promptHeight);
      const promptBox = [
        ` ${D}┌${"─".repeat(inner)}┐${R}`,
        ...shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`),
        ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
        ` ${D}└${"─".repeat(inner)}┘${R}`,
      ];

      if (modelPick === "newrun") {
        const list = modelPickEntries;
        const availability = loadAvailability(l.home);
        const total = list.length + 1;
        if (modelPickSel >= total) modelPickSel = Math.max(0, total - 1);
        const autoLine = ` ${newrun.model === undefined ? `${C}▸` : " "} ${G}Auto${R} ${D}let the selector choose${R}`;
        const entries: string[] = [selected(autoLine, modelPickSel === 0)];
        for (let i = 0; i < list.length; i++) {
          const entry = list[i]!;
          const row = entry.row;
          const chosen = row.key === newrun.model;
          const free = row.free ? ` ${G}FREE${R}` : "";
          const status = entry.eligible
            ? `${G}✓${R}`
            : entry.reason === "model-cooling" || entry.reason === "provider-cooling"
              ? `${Y}⏸${R}`
              : `${RED}✕${R}`;
          const reason = entry.eligible ? "" : ` ${D}${modelReasonText(entry, availability)}${R}`;
          const line = ` ${chosen ? `${C}▸` : " "} ${status} ${C}${row.key}${R} ${D}fit ${entry.fit.toFixed(2)}${R}${free}${reason}`;
          entries.push(selected(line, modelPickSel === i + 1));
        }
        const eligibleCount = list.filter((entry) => entry.eligible).length;
        const reasonCounts = new Map<string, number>();
        for (const entry of list) {
          if (entry.eligible) continue;
          const reason = entry.reason ?? "ineligible";
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
        const reasonSummary = [...reasonCounts.entries()]
          .sort(
            (a, b) =>
              modelReasonRank(a[0]) - modelReasonRank(b[0]) ||
              b[1] - a[1] ||
              a[0].localeCompare(b[0]),
          )
          .slice(0, 4)
          .map(([reason, count]) => `${modelReasonLabel(reason)} ${count}`)
          .join(" · ");
        const summaryText =
          `${eligibleCount} eligible · ${list.length - eligibleCount} ineligible` +
          (reasonSummary ? ` · ${reasonSummary}` : "");
        const selectedEntry = modelPickSel > 0 ? list[modelPickSel - 1] : undefined;
        const selectedHint = selectedEntry && !selectedEntry.eligible
          ? ` ${RED}${selectedEntry.row.key}: ${modelReasonText(selectedEntry, availability)}${R}`
          : "";
        const visible = Math.max(1, bodyH - 6);
        const start = Math.max(0, Math.min(modelPickSel - Math.floor(visible / 2), Math.max(0, total - visible)));
        const picker: string[] = [
          ` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Select model${R} ${D}(type to filter; Enter selects)${R}`,
          ` ${D}${summaryText}${R}`,
          "",
          ...entries.slice(start, start + visible),
          ...(list.length === 0 ? [` ${D}No configured models match this filter.${R}`] : []),
          ...(selectedHint ? [selectedHint] : []),
          "",
          ` ${D}filter: ${modelPickText || "(all)"}${R}`,
        ];
        body = clipBody(picker.slice(0, bodyH));
        actions = joinCommands([
          command("Enter", "Select", undefined, G),
          command("j/k", "Move", undefined, M),
          command("Esc", "Close", undefined, GR),
        ]);
        secondary =
          `${D}${list.length} model(s) · ✓ eligible · ⏸ cooling · ✕ ineligible` +
          `${modelPickText ? ` · “${modelPickText}”` : ""}${R}` +
          `${toast ? ` · ${Y}${toast}${R}` : ""}`;
      } else if (issuePick === "newrun") {
        const list = pickerIssues();
        if (issuePickSel >= list.length) issuePickSel = Math.max(0, list.length - 1);
        const picker: string[] = [` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Link an issue${R} ${D}(type to filter; Enter selects)${R}`, ""];
        for (let i = 0; i < list.length; i++) {
          const { issue, depth } = list[i]!;
          const indent = "  ".repeat(depth);
          const selectedIssue = newrun.issue && refKey(issue.ref) === refKey(newrun.issue);
          const reserved = issue.reserved ? ` ${M}[P&R]${R}` : "";
          const line = ` ${indent}${selectedIssue ? C + "▸" : " "} ${BL}#${issue.ref.number}${R} ${D}${issue.kind}${R} ${W}${issue.title}${R}${reserved}`;
          picker.push(selected(line, i === issuePickSel));
        }
        picker.push("", ` ${D}filter: ${issuePickText || "(all)"}${R}`);
        body = clipBody(picker.slice(0, bodyH));
        actions = joinCommands([
          command("Enter", "Select", undefined, G),
          command("j/k", "Move", undefined, M),
          command("Esc", "Close", undefined, GR),
        ]);
        secondary = `${D}${list.length} issue(s)${issuePickText ? ` · “${issuePickText}”` : ""}${R}`;
      } else if (newRunSettings) {
        const labels: Record<NewRunSettingField, string> = {
          preset: "Preset",
          verification: "Verify",
          issues: "GH issues",
          ask: "Ask",
          approval: "Approval",
          ambiguity: "Ambiguity",
          minFit: "Min fit",
          floors: "Floors",
        };
        const values: Record<NewRunSettingField, string> = {
          preset: newrun.preset,
          verification: newrun.verification,
          issues: newrun.issues,
          ask: newrun.ask ? "on" : "off",
          approval: newrun.approval,
          ambiguity: newrun.ambiguity,
          minFit: fitText,
          floors: floorText,
        };
        const preset = PRESETS[newrun.preset];
        const modeText = def.modes.length === 0
          ? "single-agent (no role modes)"
          : `${def.defaultMode ?? def.modes[0]} default · ${def.modes.join(", ")}`;
        const lines: string[] = [
          ` ${B}${W}New-run settings${R} ${D}· ${def.blurb}${R}`,
          ` ${D}Agent${R} ${agentTone(newrun.agent)}${newrun.agent}${R} ${D}· ${def.readonly ? "read-only" : "can write"} · issue access ${def.issueAccess} · default preset ${def.preset}${R}`,
          ` ${D}Mode${R}  ${W}${modeText}${R}`,
          ` ${D}${def.modes.length === 0 ? "All current roles run as one agent. Orchestration is a separate command, not a run mode." : `Mode config: ${def.modes.map((mode) => { const cfg = def.modeConfig[mode]; return `${mode}=${cfg?.verification ?? "role"}${cfg?.review ? "+review" : ""}`; }).join(" · ")}`}${R}`,
          ` ${D}Preset${R} ${C}${newrun.preset}${R} ${D}· ${NEW_RUN_PRESET_INFO[newrun.preset] ?? ""}${R}`,
          ` ${D}Defaults${R} ${D}${preset ? presetConfigText(preset) : "unknown preset"}${R}`,
          ` ${D}Effective${R} ${D}${presetConfigText(resolvedAgent.config)} · issue access ${resolvedAgent.config.issueAccess ?? def.issueAccess}${R}`,
          ` ${D}Policy${R} ${D}${policyFloorText(ap, newrun.tier)}${R}`,
          ` ${D}Tools${R} ${D}${def.tools.join(", ")}${R}`,
          "",
        ];
        const fieldLineIndexes: number[] = [];
        for (let i = 0; i < NEW_RUN_SETTING_FIELDS.length; i++) {
          fieldLineIndexes.push(lines.length);
          const field = NEW_RUN_SETTING_FIELDS[i]!;
          const value = values[field];
          const tone = i % 2 === 0 ? C : M;
          const line = `  ${pad(labels[field], 12)} ${tone}${B}${value}${R}`;
          lines.push(selected(line, i === newRunSettingsSel));
        }
        const field = NEW_RUN_SETTING_FIELDS[newRunSettingsSel]!;
        lines.push("", ` ${B}${C}${labels[field]}${R}`);
        for (const line of wrapText(settingExplanation(field, newrun, ap, def), Math.max(20, cols - 4))) {
          lines.push(` ${D}${line}${R}`);
        }
        lines.push("", ` ${B}${C}Presets${R} ${D}· current ${newrun.preset}${R}`);
        for (const name of Object.keys(NEW_RUN_PRESET_INFO)) {
          const current = name === newrun.preset ? `${C}▸${R}` : " ";
          lines.push(` ${current} ${B}${W}${name.padEnd(12)}${R} ${D}${NEW_RUN_PRESET_INFO[name]}${R}`);
        }
        const selectedLine = fieldLineIndexes[Math.min(newRunSettingsSel, fieldLineIndexes.length - 1)] ?? 0;
        const start = Math.max(
          0,
          Math.min(selectedLine - Math.floor(bodyH / 3), Math.max(0, lines.length - bodyH)),
        );
        body = clipBody(lines.slice(start, start + bodyH));
        actions = joinCommands([
          command("j/k", "Move", undefined, M),
          command("Enter", "Change", undefined, G),
          command("Esc/s", "Close", undefined, GR),
        ]);
      } else {
        // Context and inherited sources stay above; the composer is pinned to
        // the bottom of the body so it sits directly above the key-command row.
        bottomAlign = {
          above: summary,
          block: [
            contextCommands,
            ...promptBox,
            ...(promptHint ? [promptHint] : []),
            "",
          ],
          filler: panelLine(""),
        };
        // Agent, tier, issue, and prompt controls live beside the prompt or in
        // the Issues panel; the bottom footer has no command row.
        actions = " ";
        secondaryStyled = true;
        secondary = toast ? `${D}· ${Y}${toast}${R}` : "";
      }
    }

    /* ------------------------------------------------------------ model */
    else if (page === "models" && screen === "model" && selectedModelKey) {
      const model = catalogueRows.find((row) => row.key === selectedModelKey);
      if (!model) {
        screen = "list";
        return draw();
      }
      const weights = policyWeightsFor(newrun.agent);
      const offers = siblingOffers(catalogueRows, model);
      const lines: string[] = [
        ` ${B}${W}${model.key}${R}`,
        ` ${D}${model.kind} · ${model.coding ? "coding" : "non-coding"} · ${model.modes.join(", ") || "plain chat"}${R}`,
        "",
        ` ${B}${C}Capability${R}`,
      ];
      for (const axis of CAPABILITY_AXES) {
        const score = model.scores[axis];
        lines.push(`   ${axis.padEnd(10)} ${progress(score * 10, Math.min(24, Math.max(8, Math.floor(cols / 4))))} ${score.toFixed(2)}`);
      }
      lines.push(`   ${"weighted".padEnd(10)} ${weights ? `${D}role ${R}${agentTone(newrun.agent)}${newrun.agent}${R}` : `${D}neutral${R}`} ${modelWeightedFit(model, weights).toFixed(2)}`);
      lines.push("", ` ${B}${C}Offer${R}`);
      lines.push(`   context ${C}${fmtContext(model.context)}${R} · max out ${C}${fmtContext(model.maxOutput)}${R} · in ${Y}$${model.pricing.input}${R}/M · out ${Y}$${model.pricing.output}${R}/M ${model.free ? `${G}free${R}` : `${RED}paid${R}`}`);
      if (model.benchmarks) {
        lines.push(`   benchmarks ${D}${Object.entries(model.benchmarks).filter(([, value]) => typeof value === "number").slice(0, 6).map(([key, value]) => `${key} ${value}`).join("  ")}${R}`);
      }
      const availabilityState = loadAvailability(l.home);
      const modelHealth = availabilityState.models[model.key];
      const providerHealth = availabilityState.providers[model.providerID];
      const coolingUntil = modelHealth?.cooldownUntil ?? 0;
      const lastProbe = modelHealth?.lastProbeResult;
      const probeTone =
        lastProbe === "ready" ? G : lastProbe === "cooling" ? Y : lastProbe === "unknown" || lastProbe === "skipped" ? D : RED;
      const healthText = probingModels.has(model.key)
        ? `${C}probing${R}`
        : coolingUntil > Date.now()
          ? `${Y}cooling ${Math.max(1, Math.ceil((coolingUntil - Date.now()) / 60_000))}m${R}`
          : lastProbe
            ? `${probeTone}${lastProbe}${R}`
            : `${D}not probed${R}`;
      lines.push("", ` ${B}${C}Availability${R}`);
      lines.push(`   ${healthText}${modelHealth?.lastProbeAt ? ` ${D}· ${ago(new Date(modelHealth.lastProbeAt).toISOString())}${R}` : ""}`);
      const providerBits = [
        providerHealth?.disabled ? `${RED}funds${R}` : "",
        providerHealth?.needsAuth ? `${RED}auth${R}` : "",
        (providerHealth?.cooldownUntil ?? 0) > Date.now()
          ? `${Y}provider cooling ${Math.max(1, Math.ceil(((providerHealth?.cooldownUntil ?? 0) - Date.now()) / 60_000))}m${R}`
          : "",
      ].filter(Boolean);
      if (providerBits.length > 0) lines.push(`   provider ${model.providerID} · ${providerBits.join(" · ")}`);
      lines.push("", ` ${B}${C}Providers offering this model${R}`);
      for (const offer of offers.slice(0, Math.max(3, Math.floor(bodyH / 2)))) {
        lines.push(`   ${offer.providerID === model.providerID ? C + "▸" : " "} ${pad(offer.providerID, 18)} ${Y}$${offer.pricing.input}${R}/${Y}$${offer.pricing.output}${R}  ${D}ctx ${fmtContext(offer.context)}${R}`);
      }
      const w = selectableLines(lines, modelScroll, modelScroll, bodyH);
      modelScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("Esc", "Back", undefined, GR),
        command("j/k", "Scroll", undefined, M),
        command("t", "Probe", undefined, G),
        command("p", "Copy key", undefined, C),
        command("o", "Provider", undefined, BL),
      ]);
      secondary = `${D}${model.key}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`;
    }

    /* ----------------------------------------------------------- models */
    else if (page === "models" && screen === "list") {
      const lines: string[] = [];
      const groups = groupModels(modelRows, modelGroup);
      modelVisible = groups.flatMap((group) => group.rows);
      let flatIndex = 0;
      let selectedLine = 0;
      for (const group of groups) {
        lines.push(background(fit(` ${B}${theme.sectionFg}${group.key}${R} ${D}(${group.rows.length})${R}`, cols), theme.sectionBg));
        for (const row of group.rows) {
          const isSelected = flatIndex === modelSel;
          if (isSelected) selectedLine = lines.length;
          const free = row.free || (row.pricing.input === 0 && row.pricing.output === 0) ? ` ${G}free${R}` : "";
          const cooling = (() => {
            if (probingModels.has(row.key)) return ` ${C}…${R}`;
            const avail = loadAvailability(l.home);
            const phase = avail.models[row.key];
            if (!phase?.cooldownUntil || phase.cooldownUntil <= Date.now()) return "";
            const minutes = Math.max(1, Math.ceil((phase.cooldownUntil - Date.now()) / 60_000));
            return ` ${Y}⏱${minutes >= 60 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`}${R}`;
          })();
          const axes = narrow ? "" : ` ${D}R${row.scores.reasoning.toFixed(1)} C${row.scores.code.toFixed(1)} A${row.scores.agentic.toFixed(1)} G${row.scores.general.toFixed(1)}${R}`;
          const left = `   ${row.coding === false ? `${GR}○${R}` : `${G}●${R}`} ${BL}${trunc(row.name, narrow ? 20 : 30)}${R}${free}${cooling}`;
          const right = `${D}${fmtContext(row.context)}${R} ${D}cap${R} ${row.scores.capability.toFixed(1)}${axes} ${Y}$${row.pricing.input}${R}/${Y}$${row.pricing.output}${R}`;
          lines.push(selected(` ${narrow ? trunc(left, Math.max(18, cols - 18)) + " " + right : pad(left, Math.max(26, cols - visible(right) - 2)) + right}`, isSelected));
          flatIndex++;
        }
      }
      if (lines.length === 0) lines.push(` ${D}No matching models.${R}`);
      const w = selectableLines(lines, Math.min(selectedLine, Math.max(0, lines.length - 1)), modelScroll, bodyH);
      modelScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("Enter", "Details", undefined, G),
        command("/", "Search", undefined, BL),
        command("a", "Providers", modelsAll ? "all" : "configured", C),
        command("f", "Free", modelsFree ? "only" : "all", modelsFree ? G : GR),
        command("c", "Coding", modelsCoding ? "only" : "all", modelsCoding ? G : GR),
        command("g", "Group", modelGroup, BL),
        command("s", "Sort", modelSort, C),
        command("j/k", "Move", undefined, GR),
      ]);
      secondary = "";
    }

    /* ------------------------------------------------------- orchestrate */
    else if (page === "orchestrate" && screen === "list") {
      const runs = allRuns.filter((run) => run.repoRoot === l.repoRoot);
      let scopeRef = orchestrateRef;
      if (orchestrateScope !== "project" && !scopeRef) {
        const wanted = orchestrateScope === "epic" ? "epic" : "feature";
        const first = issues.find((issue) => issue.kind === wanted);
        scopeRef = first?.ref;
        orchestrateRef = scopeRef;
      }
      const schedule = planSchedule({
        issues,
        scope: orchestrateScope,
        ...(scopeRef ? { scopeRef } : {}),
        runs,
        maxParallel: 2,
      });
      const scopeText = schedule.scopeRef ? `${schedule.scope} #${schedule.scopeRef.number}` : schedule.scope;
      const states = listOrchestrations(l);
      const ledger =
        states.find(
          (candidate) =>
            candidate.scope === orchestrateScope &&
            ((!scopeRef && !candidate.scopeRef) ||
              (scopeRef &&
                candidate.scopeRef?.repo === scopeRef.repo &&
                candidate.scopeRef.number === scopeRef.number)),
        ) ?? states[0];
      const lines: string[] = [
        ` ${B}${W}Orchestrate${R} ${D}${scopeText}${R}  ${G}${schedule.ready.length} ready${R}  ${Y}${schedule.blocked.length} blocked${R}  ${D}${schedule.dispatch.length} dispatch${R}`,
        ` ${D}${l.repoRoot}${R}`,
      ];
      if (ledger) {
        lines.push(
          ` ${C}${ledger.id}${R}  ${D}${ledger.checkpoint ?? "preflight"}${R}  ` +
            `${D}packets ${ledger.approvedPackets?.length ?? 0} · results ${ledger.approvedResults?.length ?? 0}${R}` +
            `${ledger.stopReason ? `  ${RED}${ledger.stopReason}${R}` : ""}`,
        );
      }
      if (issues.length === 0) {
        lines.push("", ` ${Y}No cached issues. Press r to refresh.${R}`);
      } else if (schedule.tasks.length === 0) {
        lines.push("", ` ${D}No tasks in scope.${R}`);
      } else {
        const taskLines: string[] = [];
        for (let i = 0; i < schedule.tasks.length; i++) {
          const task = schedule.tasks[i]!;
          const mark = task.ready ? `${G}READY${R}` : `${Y}BLOCK${R}`;
          const plan = task.plan ? `${task.plan.status}/${task.plan.verification}` : "no-plan";
          const line =
            ` ${mark} ${D}#${task.issue.ref.number}${R} ${C}${plan.padEnd(16)}${R} ` +
            `${W}${trunc(task.issue.title, Math.max(16, cols - 38))}${R}` +
            `${task.reason ? ` ${D}${trunc(task.reason, Math.max(12, cols - 80))}${R}` : ""}`;
          taskLines.push(selected(line, i === orchestrateSel));
        }
        orchestrateSel = Math.max(0, Math.min(orchestrateSel, taskLines.length - 1));
        const available = Math.max(1, bodyH - lines.length - 1);
        if (orchestrateSel < orchestrateScroll) orchestrateScroll = orchestrateSel;
        if (orchestrateSel >= orchestrateScroll + available) orchestrateScroll = orchestrateSel - available + 1;
        orchestrateScroll = Math.max(0, Math.min(orchestrateScroll, Math.max(0, taskLines.length - available)));
        lines.push(...taskLines.slice(orchestrateScroll, orchestrateScroll + available));
      }
      if (schedule.dispatch.length > 0) {
        lines.push("", ` ${D}dispatch ${R}${schedule.dispatch.map((task) => `#${task.issue.ref.number}`).join(", ")}`);
      }
      for (const error of schedule.errors) lines.push(` ${RED}${error}${R}`);
      body = clipBody(lines);
      actions = joinCommands([
        command("s", "Scope", orchestrateScope, Y),
        command("r", "Issues", undefined, C),
        command("x", "Start", undefined, G),
        command("a", "Approve", undefined, Y),
        command("A", "Result", undefined, Y),
        command("j/k", "Move", undefined, M),
        command("Enter", "Open issue", undefined, G),
      ]);
      secondary = `${D}${scopeText}${R}`;
    }

    /* ------------------------------------------------------------ spend */
    else if (page === "spend") {
      const query = { days: spendDaysWindow === 0 ? undefined : spendDaysWindow };
      const summary = readSpendSummary(l.home, query);
      const headerLines = [
        ` ${B}${W}Spend${R} ${D}${spendDaysWindow === 0 ? "all time" : `last ${spendDaysWindow} days`}${R}`,
        ` ${Y}$${summary.totalActual.toFixed(4)}${R} actual  ${D}$${summary.totalEstimated.toFixed(4)} estimate${R}  ${C}${fmtTokens(summary.totalTokens)}${R} tok  ${G}${fmtTokens(summary.freeTokens)}${R} free`,
      ];
      const lines: string[] = [
        ...headerLines.map((line) => background(fit(line, cols), theme.sectionBg)),
        "",
      ];
      if (spendBy === "day") {
        const series = spendDays(summary, spendDaysWindow === 0 ? 30 : Math.min(spendDaysWindow, 90));
        const max = Math.max(0, ...series.map((entry) => entry.bucket.actual));
        for (const entry of series.slice(-Math.max(4, bodyH - 5))) {
          lines.push(`  ${entry.day} ${spendBar(entry.bucket.actual, max, Math.max(8, Math.min(24, cols - 28)))} ${fmtMoney(entry.bucket.actual)}  ${D}${fmtTokens(entry.bucket.tokens)} tok${R}`);
        }
      } else {
        const buckets =
          spendBy === "provider" ? summary.byProvider :
          spendBy === "model" ? summary.byModel :
          summary.byAgent;
        const entries = Object.entries(buckets).sort((a, b) => b[1].actual - a[1].actual).slice(0, 40);
        const max = Math.max(0, ...entries.map(([, bucket]) => bucket.actual));
        for (const [key, bucket] of entries) {
          const label = key === "map" ? "map (semantic)" : key;
          const perMillion = bucket.tokens > 0 ? bucket.actual / (bucket.tokens / 1_000_000) : 0;
          const keyTone = spendBy === "agent" ? agentTone(key) : W;
          lines.push(`  ${keyTone}${pad(label, narrow ? 20 : 38)}${R} ${spendBar(bucket.actual, max, narrow ? 4 : 10)} ${fmtMoney(bucket.actual)}  ${D}${String(bucket.calls).padStart(4)} calls · ${fmtTokens(bucket.tokens)} tok · ${fmtTokens(bucket.freeTokens)} free${perMillion > 0 ? ` · ${fmtMoney(perMillion)}/Mtok` : ""}${R}`);
        }
      }
      const w = selectableLines(lines, spendScroll, spendScroll, bodyH);
      spendScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("g", "Group", spendBy, C),
        command("d", "Range", spendDaysWindow === 0 ? "all" : `${spendDaysWindow}d`, Y),
        command("j/k", "Scroll", undefined, M),
        command("r", "Refresh", undefined, GR),
      ]);
      secondary = `${D}ledger ${join(l.home, "spend.jsonl")}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`;
    }

    /* --------------------------------------------------------- settings */
    else if (page === "settings") {
      const lines: string[] = [];
      let section = "";
      let index = 0;
      let selectedLine = 0;
      const visibleRows: SettingRow[] = [];
      for (const row of settingsRows) {
        if (row.section !== section) {
          section = row.section;
          lines.push(background(fit(` ${B}${theme.sectionFg}${section.toUpperCase()}${R}`, cols), theme.sectionBg));
        }
        const isSelected = index === settingsSel;
        if (isSelected) selectedLine = lines.length;
        const path = settingsFileFor(l, row);
        const line = `   ${isSelected ? C + "▸" : " "} ${pad(row.label, narrow ? 20 : 28)} ${W}${trunc(row.value, Math.max(10, cols - (narrow ? 32 : 54)))}${R} ${D}${path ? basename(path) : ""}${R}`;
        lines.push(selected(line, isSelected));
        if (row.detail && !narrow) lines.push(`       ${D}${trunc(row.detail, cols - 8)}${R}`);
        visibleRows.push(row);
        index++;
      }
      const w = selectableLines(lines, Math.min(selectedLine, Math.max(0, lines.length - 1)), settingsScroll, bodyH);
      settingsScroll = w.scroll;
      body = clipBody(w.lines);
      const row = visibleRows[Math.min(settingsSel, visibleRows.length - 1)];
      actions = command("j/k", "Select", undefined, M);
      secondary = row ? `${D}${row.label} · ${settingsFileFor(l, row) ?? "(no file)"}${toast ? ` · ${Y}${toast}${R}` : ""}${R}` : "";
    }

    /* ------------------------------------------------------------- run */
    else if (page === "runs" && screen === "run") {
      const detail = runDetailData();
      if (!detail) {
        body = [` ${RED}Run ${selectedRunId ?? "?"} no longer exists.${R}`];
        actions = command("Esc", "Back", undefined, GR);
      } else {
        const s = detail.summary;
        const ev = detail.events;
        const pending = latestUnansweredQuestion(
          ev.filter((event) => event.type === "question") as Array<{ questionId?: string; text?: string }>,
          readInbox(detail.dir),
        );
        const context = readContextManifest(detail.dir);
        const relatedList = relatedRuns(allRuns, s);
        const thinking = thinkingChunks(ev);
        const outcomeText =
          s.summary ??
          summarizeRun({
            summary: s,
            events: ev,
            state: readStateView(detail.dir),
            finalText: s.finalText,
          }).text;
        const recentActivity = ev.filter((event) => isTimelineEvent(event, false)).slice(-8);
        const thinkingByCall = new Map<string, ThinkingChunk[]>();
        for (const chunk of thinking) {
          if (typeof chunk.call !== "number") continue;
          const key = `${chunk.attempt ?? 0}:${chunk.call}`;
          const list = thinkingByCall.get(key) ?? [];
          list.push(chunk);
          thinkingByCall.set(key, list);
        }
        const touched = touchedPaths(ev);
        runCwd = `${s.worktree ?? s.repoRoot}  ${s.worktree ? "worktree" : "read-only"}`;
        const hint = (key: string, label: string, tone = M): string =>
          `${B}${tone}${key}${R} ${D}${label}${R}`;
        runHints = joinCommands([
          command("f", "fork", undefined, Y),
          ...(runSection === "timeline"
            ? [
                hint("j/k", "events"),
                hint("space", "expand", G),
                hint("PgUp/Dn", "scroll"),
                hint("F", `follow ${timelineFollow ? "ON" : "OFF"}`, Y),
                hint("v", timelineVerbose ? "all" : "key events"),
              ]
            : runSection === "processes"
              ? [
                  hint("j/k", "select"),
                  hint("F", "follow", Y),
                  hint("o", "log", G),
                  hint("x", "kill", RED),
                  hint("X", "kill all", RED),
                ]
              : runSection === "overview" || runSection === "changes" || runSection === "context"
                ? [hint("j/k", "scroll"), hint("PgUp/Dn", "page")]
                : runSection === "related"
                  ? [hint("j/k", "select")]
                  : []),
        ]);
        footerMapTokens = mapStatusTokens(s.worktree ?? s.repoRoot);
        const sectionBar = wrapTokenList(
          RUN_SECTIONS.map((section) =>
            section === runSection
              ? `${theme.sectionActiveBg}${theme.sectionActiveFg}${B} ${RUN_SECTION_LABEL[section]} ${R}`
              : `${SUBTAB_BG}${theme.sectionFg} ${RUN_SECTION_LABEL[section]} ${R}`,
          ),
          cols - 2,
          "  ",
        ).map((line) => background(fit(` ${line}`, cols), theme.sectionBg));
        const ctxUsage = contextUsage(s.usage, ev);
        const timeLabel = s.endedAt ? `ended ${ago(s.endedAt)} ago` : `updated ${ago(s.lastActivityAt)} ago`;
        const lines: string[] = [
          ` ${icon(s.status)} ${B}${BL}${s.id}${R}  ${statusColor(s.status)}${s.status.toUpperCase()}${R}  ${agentTone(s.agent)}${s.agent}${R}${s.mode ? `/${s.mode}` : ""}  ${G}${s.modelCalls}${R} call(s)  ${Y}${fmtMoney(s.cost.actual)}${R}  ${D}${timeLabel}${R}`,
          ` ${M}${fmtRunTokens(s.usage.totalTokens)}${R}${D} total${R}`,
        ];
        footerCtx = `${C}ctx${R} ${W}${fmtRunTokens(ctxUsage.tokens)}${R}`;
        const runIssueAccess = s.capabilities
          ? issueAccessFromCapabilities(s.capabilities)
          : agentDef(l, s.agent).issueAccess;
        const issueMeta = [s.issue ? `#${s.issue.number}` : "", s.prNumber ? `PR #${s.prNumber} ${s.prState ?? ""}` : ""]
          .filter(Boolean)
          .join("  ");
        const accessMeta = `${D}issues${R} ${issueAccessTone(runIssueAccess)}${runIssueAccess}${R}`;
        if (issueMeta) lines.push(` ${D}${issueMeta}${R}  ${accessMeta}`);
        else lines.push(` ${accessMeta}`);
        lines.push("", ...sectionBar, "");
        if (runSection === "overview") {
          lines.push(` ${B}${statusColor(s.status)}Status${R}`);
          const statusText = s.error ?? s.status.toUpperCase();
          const statusTone = s.error || s.status === "failed" ? RED : W;
          for (const line of wrapText(statusText, cols - 4).slice(0, short ? 3 : 6)) {
            lines.push(`  ${statusTone}${line}${R}`);
          }
          if (pending?.text) lines.push(` ${Y}? ASK${R} ${W}${trunc(pending.text, cols - 8)}${R}`);
          lines.push("", ` ${B}${G}Summary${R}`);
          for (const rawLine of outcomeText.split("\n")) {
            for (const line of wrapText(rawLine, cols - 4)) lines.push(`  ${W}${line}${R}`);
          }
          lines.push("", ` ${B}${BL}Request${R}`);
          for (const line of wrapText(s.request, cols - 4).slice(0, short ? 3 : 6)) lines.push(`  ${W}${line}${R}`);
          lines.push("", ` ${B}${M}Now${R}`);
          const lastModel = [...ev].reverse().find((event) => event.type === "model_select" && !event.error);
          const lastTool = [...ev].reverse().find((event) => event.type === "tool_call_start");
          const lastEnd = [...ev].reverse().find((event) => event.type === "model_call_end");
          lines.push(`  ${D}model${R}  ${C}${String(lastModel?.key ?? "(pending)")}${R}`);
          if (lastTool) lines.push(`  ${D}tool${R}   ${Y}${String(lastTool.tool)}${R} ${D}${JSON.stringify(lastTool.args ?? {}).slice(0, cols - 18)}${R}`);
          if (lastEnd) lines.push(`  ${D}turn${R}   ${D}${String(lastEnd.stopReason ?? "")}${R} ${D}· ${fmtTokens(Number((lastEnd.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0))} tok${R}`);
          if (recentActivity.length) {
            lines.push("", ` ${B}${C}Activity${R}${s.status === "running" ? ` ${G}live${R}` : ""}`);
            for (const event of recentActivity) {
              const time = String(event.t ?? "").slice(11, 19);
              lines.push(`  ${D}${time}${R} ${trunc(describeTimelineEvent(event), Math.max(12, cols - 12))}`);
            }
          }
          lines.push("", ` ${B}${G}Progress${R}`);
          const mapRoot = s.worktree ?? s.repoRoot;
          const semantic = loadSemantic(mapRoot);
          const semanticDirty = readSemanticDirty(mapRoot);
          const mapCached = existsSync(join(mapRoot, ".machine_code", "local", "cache", "map.json"));
          const mapTone = mapCached ? G : Y;
          const semanticTone = semantic && semanticDirty.length === 0 ? G : Y;
          const semanticText = semantic
            ? `${semanticDirty.length ? `stale (${semanticDirty.length})` : "cached"} · ${Object.keys(semantic.modules).length} modules`
            : "missing";
          const lspReady = serverAvailable("typescript");
          lines.push(
            `  ${D}map${R}     ${mapTone}${mapCached ? "deterministic cached" : "deterministic missing"}${R}` +
              ` ${D}·${R} ${D}semantic${R} ${semanticTone}${semanticText}${R}`,
          );
          lines.push(`  ${D}lsp${R}     ${lspReady ? G : Y}typescript ${lspReady ? "ready" : "missing"}${R}`);
          lines.push(`  ${D}startup${R} ${C}${context ? `${context.chars.toLocaleString()} chars / ${context.sources.length} sources` : "not recorded"}${R}`);
          lines.push(`  ${D}changes${R} ${touched.length ? `${G}${touched.length}${R} ${D}path(s) touched${R}` : `${D}none yet${R}`}`);
          if (relatedList.length) lines.push(`  ${D}related${R}  ${M}${relatedList.length}${R} ${D}run(s)${R}`);
          lines.push(`  ${D}parent${R}  ${s.parentRunId ? `${D}${s.parentRunId.slice(-8)}${R}` : `${D}none${R}`}`);
          if (context) {
            lines.push("", ` ${B}${C}Context${R}`);
            for (const source of context.sources.slice(0, short ? 3 : 8)) {
              const tone = contextTone(source.kind);
              lines.push(`  ${tone}${source.kind.padEnd(10)}${R} ${D}${String(source.bytes).padStart(6)}b${R} ${W}${source.ref}${R}`);
            }
          }
          if (thinking.length) {
            lines.push("", ` ${B}${Y}Latest thinking${R}`);
            for (const line of wrapText(thinking[thinking.length - 1]!.text, cols - 4).slice(-Math.max(1, short ? 3 : 8))) lines.push(`  ${W}${line}${R}`);
          }
          const w = scrollLines(lines, runScroll, bodyH);
          runScroll = w.scroll;
          body = clipBody(w.lines);
        } else if (runSection === "timeline") {
          const eventLines: string[] = [];
          const starts: number[] = [];
          let timelineAttempt = 0;
          if (timelineFollow) {
            const lastVisible = lastTimelineIndex(ev, timelineVerbose);
            if (lastVisible >= 0 && eventSel !== lastVisible) {
              eventSel = lastVisible;
              eventBodyScroll = 0;
            }
          }
          for (let i = 0; i < ev.length; i++) {
            starts[i] = eventLines.length;
            const event = ev[i]!;
            if (event.type === "model_select" && event.call === 0) timelineAttempt += 1;
            if (!isTimelineEvent(event, timelineVerbose)) continue;
            const isSelected = i === eventSel;
            const prefix = isSelected ? `${C}▸${R}` : " ";
            const time = String(event.t ?? "").slice(11, 19);
            const expandedEvent = expanded.has(`${s.id}:${i}`);
            const type = String(event.type);
            if (type === "run_start") eventLines.push(`${prefix} ${GR}${time}${R} ${C}▶ start${R} ${agentTone(String(event.agent))}${event.agent}${R}${event.mode ? `/${event.mode}` : ""}`);
            else if (type === "model_select") {
              if (event.error) eventLines.push(`${prefix} ${GR}${time}${R} ${RED}select error ${String(event.error)}${R}`);
              else {
                const estimate = (event.estimate ?? {}) as { inputTokens?: number; outputTokens?: number };
                eventLines.push(`${prefix} ${GR}${time}${R} ${BL}select${R} ${C}${String(event.key)}${R} ${D}${event.estimate ? `${estimate.inputTokens ?? 0}+${estimate.outputTokens ?? 0} tok` : ""}${R}`);
                if (expandedEvent && Array.isArray(event.candidates)) {
                  for (const candidate of event.candidates.slice(0, 4)) {
                    const chosen = candidate.key === event.key ? `${C}✓${R}` : " ";
                    eventLines.push(`    ${chosen} ${D}${Number(candidate.score ?? 0).toFixed(3)}${R} ${candidate.key} ${D}fit ${Number(candidate.fit ?? 0).toFixed(2)}${R}`);
                  }
                }
              }
            } else if (type === "model_request") {
              const messages = Number(event.messages ?? 0);
              const chars = Number(event.chars ?? 0);
              eventLines.push(`${prefix} ${GR}${time}${R} ${BL}input${R} ${D}${messages} msg · ${fmtTokens(chars)} chars${R}`);
              const input = typeof event.input === "string" ? event.input : "";
              if (input) {
                const inputLines = input.split("\n");
                const shown = expandedEvent ? inputLines : inputLines.slice(0, 3);
                for (const line of shown) {
                  for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
                }
                if (!expandedEvent && inputLines.length > 3) {
                  eventLines.push(`    ${D}… ${inputLines.length - 3} more lines (space to expand)${R}`);
                }
              }
            } else if (type === "model_call_end") {
              const usage = (event.usage ?? {}) as { totalTokens?: number; input?: number; output?: number };
              eventLines.push(`${prefix} ${GR}${time}${R} ${M}◉${R} ${W}${String(event.provider)}${R}/${String(event.model)} ${statusColor(String(event.stopReason))}${String(event.stopReason)}${R} ${G}${fmtTokens(Number(usage.totalTokens ?? 0))}${R}tok ${Y}$${Number(event.cost ?? 0).toFixed(5)}${R}`);
              const callChunks =
                typeof event.call === "number"
                  ? (thinkingByCall.get(`${timelineAttempt}:${event.call}`) ?? [])
                  : [];
              const textChunk = callChunks
                .filter((chunk) => chunk.kind === "text")
                .map((chunk) => chunk.text)
                .join("");
              const output = (
                typeof event.text === "string" && event.text.trim().length > 0
                  ? event.text
                  : textChunk
              ).trim();
              if (output) {
                const outputLines = output.split("\n");
                const shown = expandedEvent ? outputLines : outputLines.slice(0, 3);
                const more =
                  !expandedEvent && outputLines.length > shown.length
                    ? ` ${D}(${outputLines.length - shown.length} more lines; space to expand)${R}`
                    : "";
                eventLines.push(`    ${M}output${R}${more}`);
                for (const line of shown) {
                  for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${W}${wrapped}${R}`);
                }
              }
              const reasoning = callChunks
                .filter((chunk) => chunk.kind === "thinking")
                .map((chunk) => chunk.text)
                .join("\n")
                .trim();
              if (reasoning) {
                const reasoningLines = reasoning.split("\n");
                const shown = expandedEvent ? reasoningLines : reasoningLines.slice(0, 3);
                const more =
                  !expandedEvent && reasoningLines.length > shown.length
                    ? ` ${D}(${reasoningLines.length - shown.length} more lines; space to expand)${R}`
                    : "";
                eventLines.push(`    ${M}thinking${R}${more}`);
                for (const line of shown) {
                  for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
                }
              }
              if (expandedEvent) {
                eventLines.push(`    ${D}input ${usage.input ?? 0}  output ${usage.output ?? 0}${R}`);
              }
            } else if (type === "model_delta") {
              // Streaming deltas are coalesced by the Thinking section; showing
              // each chunk here split the response into unreadable fragments.
            } else if (type === "tool_call_start") {
              eventLines.push(`${prefix} ${GR}${time}${R} ${Y}⚡${R} ${B}${String(event.tool)}${R} ${D}calling…${R}`);
              if (event.args) {
                const argsText = stripAnsi(JSON.stringify(event.args));
                if (expandedEvent) {
                  for (const line of wrapText(argsText, cols - 6)) eventLines.push(`    ${D}${line}${R}`);
                } else {
                  eventLines.push(`    ${D}${trunc(argsText.replace(/\s+/g, " "), Math.max(20, cols - 8))}${R}`);
                }
              }
            } else if (type === "tool_call") {
              const isEdit = event.tool === "write" || event.tool === "edit";
              eventLines.push(`${prefix} ${GR}${time}${R} ${isEdit ? `${G}✎${R}` : `${Y}⚡${R}`} ${B}${String(event.tool)}${R} ${event.isError ? `${RED}ERR${R}` : `${G}ok${R}`}${typeof event.durationMs === "number" ? ` ${D}${event.durationMs}ms${R}` : ""}`);
              const args = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) ?? null;
              if (expandedEvent && args) {
                for (const line of wrapText(JSON.stringify(args), cols - 6)) eventLines.push(`    ${D}${line}${R}`);
              }
              const result = event.result;
              if (result !== undefined) {
                const text = stripAnsi(typeof result === "string" ? result : JSON.stringify(result));
                if (expandedEvent) {
                  for (const line of text.split("\n")) {
                    for (const wrapped of wrapText(line, cols - 6)) eventLines.push(`    ${G}→${R} ${wrapped}`);
                  }
                } else {
                  const preview = text.split("\n").filter((line) => line.trim().length > 0).slice(0, 2);
                  for (const line of preview) eventLines.push(`    ${G}→${R} ${trunc(line, Math.max(20, cols - 8))}`);
                  if (text.split("\n").length > 2) eventLines.push(`    ${D}… (space to expand)${R}`);
                }
              }
            } else if (type === "gates") {
              eventLines.push(`${prefix} ${GR}${time}${R} ${B}⊞ gates${R} ${event.passed ? `${G}PASS${R}` : `${RED}FAIL${R}`}`);
              if (expandedEvent && Array.isArray(event.results)) {
                for (const gate of event.results as Array<{ passed?: boolean; command?: string }>) eventLines.push(`    ${gate.passed ? `${G}✓` : `${RED}✗`}${R} ${gate.command}`);
              }
            } else if (type === "error_classified") eventLines.push(`${prefix} ${GR}${time}${R} ${RED}⚠ ${String(event.kind)}${R}`);
            else if (type === "malformed_tool_call") eventLines.push(`${prefix} ${GR}${time}${R} ${RED}⚠ malformed tool call${R} ${D}${String(event.model ?? "")}${R}`);
            else if (type === "retry") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}↻ retry${R} ${D}${String(event.failedModel)}${R}`);
            else if (type === "control") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}⌘ ${String(event.action)}${R}`);
            else if (type === "run_end") eventLines.push(`${prefix} ${GR}${time}${R} ${statusColor(String(event.status))}■ ${String(event.status).toUpperCase()}${R}`);
            else if (type === "child_spawned") eventLines.push(`${prefix} ${GR}${time}${R} ${M}↳ child${R} ${C}${String(event.childRunId ?? "").slice(-8)}${R} ${agentTone(String(event.role ?? ""))}${String(event.role ?? "")}${R}`);
            else if (type === "child_completed") eventLines.push(`${prefix} ${GR}${time}${R} ${M}↲ child done${R} ${C}${String(event.childRunId ?? "").slice(-8)}${R} ${String(event.status ?? "")}`);
            else if (type === "issue_created") eventLines.push(`${prefix} ${GR}${time}${R} ${G}+ issue${R} #${String(event.number ?? event.issue ?? "")} ${D}${String(event.kind ?? "")}${event.title ? ` ${String(event.title)}` : ""}${R}`);
            else if (type === "issue_linked") eventLines.push(`${prefix} ${GR}${time}${R} ${G}link${R} #${String(event.issue ?? "")} under #${String(event.parent ?? "")}`);
            else if (type === "plan_updated") eventLines.push(`${prefix} ${GR}${time}${R} ${BL}plan${R} #${String(event.issue ?? "")} ${D}${String(event.status ?? "")}${R}`);
            else if (type === "run_summary") eventLines.push(`${prefix} ${GR}${time}${R} ${B}${G}summary${R} ${D}${String(event.headline ?? event.stopReason ?? "")}${R}`);
            else if (type === "turn_cap") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}turn cap${R} ${D}${String(event.turns ?? "")} turns${R}`);
            else if (type === "budget_exhausted") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}budget exhausted${R} ${D}${String(event.totalTokens ?? "")} tok${R}`);
            else if (type === "loop_blocked") eventLines.push(`${prefix} ${GR}${time}${R} ${RED}loop blocked${R} ${D}${String(event.tool ?? "")}${R}`);
            else if (type === "context_assembled") eventLines.push(`${prefix} ${GR}${time}${R} ${BL}context${R} ${D}${fmtTokens(Number(event.chars ?? 0))} chars${R}`);
            else eventLines.push(`${prefix} ${GR}${time}${R} ${D}${type}${R}`);
          }
          eventSel = Math.max(0, Math.min(ev.length - 1, eventSel));
          while (eventSel < ev.length - 1 && !isTimelineEvent(ev[eventSel], timelineVerbose)) eventSel += 1;
          while (eventSel > 0 && !isTimelineEvent(ev[eventSel], timelineVerbose)) eventSel -= 1;
          const visibleCount = Math.max(1, bodyH - 4);
          const start = starts[eventSel] ?? 0;
          const end = starts[eventSel + 1] ?? eventLines.length;
          if (end - start <= visibleCount) {
            eventBodyScroll = 0;
            // Keep the whole selected block visible; selected model calls should
            // show their output, not just their header.
            if (end > eventScroll + visibleCount) eventScroll = end - visibleCount;
            if (start < eventScroll) eventScroll = start;
          } else {
            // A long block starts at the top so the first output lines are visible.
            // PgDn/PgUp move the line offset inside the block.
            const maxBodyScroll = Math.max(0, end - start - visibleCount);
            eventBodyScroll = Math.max(0, Math.min(eventBodyScroll, maxBodyScroll));
            eventScroll = start + eventBodyScroll;
          }
          eventScroll = Math.max(0, Math.min(eventScroll, Math.max(0, eventLines.length - visibleCount)));
          lines.push(...eventLines.slice(eventScroll, eventScroll + visibleCount));
          body = clipBody(lines);
        } else if (runSection === "thinking") {
          const chunks = thinking;
          const thinkingLines: string[] = [];
          for (const chunk of chunks) {
            const label = chunk.kind === "thinking" ? `${M}thinking${R}` : `${C}response${R}`;
            const live = chunk.complete ? "" : `${Y} live${R}`;
            thinkingLines.push(` ${GR}${String(chunk.at).slice(11, 19)}${R} ${D}call ${chunk.call ?? "?"}${R} ${label}${live}`);
            for (const line of wrapText(chunk.text, Math.max(20, cols - 6))) thinkingLines.push(` ${chunk.kind === "thinking" ? D : W}${line}${R}`);
            thinkingLines.push("");
          }
          if (thinkingLines.length === 0) thinkingLines.push(` ${D}No assistant text recorded yet.${R}`);
          const viewport = bodyH - lines.length;
          if (thinkingFollow) thinkingScroll = Math.max(0, thinkingLines.length - viewport);
          thinkingScroll = Math.max(0, Math.min(thinkingScroll, Math.max(0, thinkingLines.length - viewport)));
          lines.push(...thinkingLines.slice(thinkingScroll, thinkingScroll + viewport));
          body = clipBody(lines);
        } else if (runSection === "changes") {
          const changes = currentChanges(detail);
          lines.push(` ${B}${C}Worktree${R} ${D}${s.worktree ?? "(none)"}${R}`);
          if (changes.error) lines.push(` ${Y}${changes.error}${R}`);
          if (changes.status) for (const line of changes.status.split("\n").slice(0, Math.max(3, bodyH - 12))) lines.push(`  ${W}${line}${R}`);
          if (changes.diffStat) {
            lines.push("", ` ${B}${C}Diffstat${R}`);
            for (const line of changes.diffStat.split("\n").slice(0, Math.max(2, bodyH - 18))) lines.push(`  ${D}${line}${R}`);
          }
          if (changes.recent) {
            lines.push("", ` ${B}${C}Recent commits${R}`);
            for (const line of changes.recent.split("\n").slice(0, 5)) lines.push(`  ${W}${line}${R}`);
          }
          if (touched.length) {
            lines.push("", ` ${B}${C}Touched by tools${R}`);
            for (const path of touched.slice(0, 10)) lines.push(`  ${G}✎${R} ${W}${path}${R}`);
          }
          const w = scrollLines(lines, runScroll, bodyH);
          runScroll = w.scroll;
          body = clipBody(w.lines);
        } else if (runSection === "processes") {
          const records = reconcileProcessRecords(detail.dir);
          if (records.length === 0) {
            lines.push(` ${D}No OS processes recorded for this run.${R}`);
          } else {
            const live = records.filter((record) => record.status === "running").length;
            lines.push(` ${B}${C}Processes${R} ${D}${records.length} total · ${live} running${R}`);
            const viewport = Math.max(1, bodyH - lines.length - 1);
            if (processFollow) processSel = records.length - 1;
            processSel = Math.max(0, Math.min(processSel, records.length - 1));
            const start = Math.max(0, Math.min(processSel - Math.floor(viewport / 2), records.length - viewport));
            for (let i = start; i < Math.min(records.length, start + viewport); i++) {
              const record = records[i]!;
              const tone = record.status === "running" ? Y : record.status === "exited" ? G : RED;
              const icon = record.status === "running" ? "●" : record.status === "exited" ? "✓" : "✗";
              const pid = record.pid ? `pid ${record.pid}` : "pid -";
              const ended = record.exitCode === undefined ? "" : ` exit ${record.exitCode}`;
              const line =
                ` ${tone}${icon}${R} ${D}${record.id}${R} ${tone}${record.status.padEnd(10)}${R}` +
                ` ${D}${record.origin.padEnd(8)}${R} ${W}${trunc(record.name, Math.max(16, cols - 48))}${R} ${D}${pid}${ended}${R}`;
              lines.push(selected(line, i === processSel));
              const log = readLogTail(record.stdoutLog, 4_000);
              const tail = log.trim().split("\n").filter(Boolean).at(-1);
              if (tail && i === processSel) lines.push(`   ${D}${trunc(tail, Math.max(16, cols - 6))}${R}`);
            }
          }
          body = clipBody(lines);
        } else if (runSection === "related") {
          lines.push(` ${B}${C}Lineage${R}`);
          if (s.orchestrationId) {
            lines.push(
              `  ${D}orchestration${R} ${C}${s.orchestrationId}${R}` +
                `${s.orchestrationScope ? ` ${D}${s.orchestrationScope}${R}` : ""}`,
            );
          }
          if (s.taskIssue) lines.push(`  ${D}task${R}        ${W}#${s.taskIssue.number}${R}`);
          if (s.attempt !== undefined) lines.push(`  ${D}attempt${R}     ${W}${s.attempt}${R}`);
          if (s.phase) lines.push(`  ${D}phase${R}       ${W}${s.phase}${R}`);
          if (s.planReview) lines.push(`  ${D}plan review${R} ${W}${s.planReview}${R}`);
          if (s.resultReview) lines.push(`  ${D}result${R}      ${W}${s.resultReview}${R}`);
          if (s.planSnapshotHash) lines.push(`  ${D}snapshot${R}    ${D}${s.planSnapshotHash.slice(0, 12)}${R}`);
          if (s.parentRunId) lines.push(`  ${D}parent${R}      ${D}${s.parentRunId.slice(-8)}${R}`);
          if (s.resumedFrom) lines.push(`  ${D}resumed${R}     ${D}${s.resumedFrom.slice(-8)}${R}`);
          if (s.forkReason) lines.push(`  ${D}fork${R}        ${W}${s.forkReason}${R}`);
          lines.push("", ` ${B}${M}Related runs${R}`);
          if (relatedList.length === 0) lines.push(` ${D}No related runs.${R}`);
          if (childSel >= relatedList.length) childSel = Math.max(0, relatedList.length - 1);
          for (let i = 0; i < relatedList.length; i++) {
            const related = relatedList[i]!;
            const isSelected = i === childSel;
            const line = ` ${icon(related.status)} ${D}${related.id.slice(-8)}${R} ${agentTone(related.agent)}${related.agent}${R}${related.mode ? `/${related.mode}` : ""} ${D}${fmtTokens(related.usage.totalTokens)} tok · ${fmtMoney(related.cost.actual)} · ${ago(related.lastActivityAt)}${R} ${related.request.replace(/\s+/g, " ").slice(0, 40)}`;
            lines.push(selected(line, isSelected));
          }
          body = clipBody(lines);
        } else if (runSection === "context") {
          if (!context) lines.push(` ${D}No context manifest recorded.${R}`);
          else {
            lines.push(` ${B}${C}Context manifest${R} ${D}${context.chars.toLocaleString()} chars / ${context.sources.length} sources${R}`);
            for (const source of context.sources) {
              const tone = contextTone(source.kind);
              lines.push(`  ${tone}${source.kind.padEnd(10)}${R} ${D}${String(source.bytes).padStart(6)}b${R} ${D}${source.origin.padEnd(9)}${R} ${W}${trunc(source.ref, cols - 36)}${R}${source.truncated ? ` ${Y}trunc${R}` : ""}${source.warning ? ` ${Y}${source.warning}${R}` : ""}`);
            }
          }
          const w = scrollLines(lines, runScroll, bodyH);
          runScroll = w.scroll;
          body = clipBody(w.lines);
        }
      }
    }

    /* ----------------------------------------------------------- answer */
    else if (screen === "answer") {
      const detail = runDetailData();
      const pending = detail
        ? latestUnansweredQuestion(
            detail.events.filter((event) => event.type === "question") as Array<{ questionId?: string; text?: string }>,
            readInbox(detail.dir),
          )
        : null;
      const width = Math.max(20, cols - 8);
      const lines = [
        "",
        ` ${Y}?${R} ${W}${pending?.text ?? "(question text not recorded)"}${R}`,
        "",
        ` ${B}${C}Answer${R}`,
        ` ${D}┌${"─".repeat(width)}┐${R}`,
      ];
      const wrapped = wrapText(answerText || "(type the answer, then press Enter)", width - 2);
      const boxHeight = Math.max(1, Math.min(bodyH - 8, 8));
      for (let i = 0; i < boxHeight; i++) lines.push(` ${D}│${R} ${W}${fit(wrapped[i] ?? "", width - 2)}${R} ${D}│${R}`);
      lines.push(` ${D}└${"─".repeat(width)}┘${R}`);
      body = clipBody(lines);
      actions = joinCommands([
        command("Enter", "Send", undefined, G),
        command("Esc", "Cancel", undefined, GR),
      ]);
      secondary = `${D}answers are appended to the run inbox and picked up without replaying the transcript${R}`;
    }

    /* ---------------------------------------------------------- correct */
    else if (screen === "correct") {
      const detail = runDetailData();
      const width = Math.max(20, cols - 8);
      const lines = [
        "",
        ` ${D}This interrupts the current run and starts a fresh child with the parent's issue,${R}`,
        ` ${D}context, and worktree changes. The new run sees only the correction, not the old transcript.${R}`,
        "",
        ` ${B}${C}Correction${R}`,
        ` ${D}┌${"─".repeat(width)}┐${R}`,
      ];
      const wrapped = wrapText(correctText || "(describe the correction; Enter starts the child run)", width - 2);
      const boxHeight = Math.max(1, Math.min(bodyH - 9, 7));
      for (let i = 0; i < boxHeight; i++) lines.push(` ${D}│${R} ${W}${fit(wrapped[i] ?? "", width - 2)}${R} ${D}│${R}`);
      lines.push(` ${D}└${"─".repeat(width)}┘${R}`);
      if (detail) lines.push(` ${D}parent ${detail.summary.id} · ${detail.summary.worktree ? "inheriting worktree" : "no worktree"}${R}`);
      body = clipBody(lines);
      actions = joinCommands([
        command("Enter", "Start run", undefined, G),
        command("Esc", "Cancel", undefined, GR),
        command("i", "Interrupt", undefined, RED),
      ]);
      secondary = `${D}Esc returns to the run; use i when you only want to stop it${R}`;
    }

    if (runDetailHeader && runCwd) header[1] = rightHeaderPath(runCwd);

    /* ------------------------------------------------------------ compose */
    if (searchMode) {
      actions = joinCommands([
        command("/", "Search", searchText || "…", C),
        command("Enter", "Apply", undefined, G),
        command("Esc", "Cancel", undefined, GR),
      ]);
      secondary = `${D}filters ${page} · type to edit${R}`;
    }
    const defaultActions = joinCommands([
      command("1-4", "Pages", undefined, C),
      command("q", "Quit", undefined, GR),
    ]);
    const commandRows = hideFooter
      ? []
      : runDetailHeader
        ? [
            ...(runHints ? wrapCommands(runHints, cols) : []),
            ...(extraActions ? wrapCommands(extraActions, cols) : []),
          ]
        : [
            ...wrapCommands(actions || defaultActions, cols),
            ...(extraActions ? wrapCommands(extraActions, cols) : []),
          ];
    const secondaryRows = runDetailHeader
      ? []
      : secondaryStyled
        ? wrapCommands(secondary, cols).slice(0, 2)
        : wrapPlain(secondary, cols).slice(0, narrow ? 2 : 1);
    const rightFooter = footerMapTokens.join("  ");
    const mapFooterLine = (() => {
      if (!footerCtx && !rightFooter) return "";
      if (!rightFooter) return ` ${footerCtx}`;
      if (!footerCtx) return `${" ".repeat(Math.max(0, cols - visible(rightFooter)))}${rightFooter}`;
      const left = ` ${footerCtx}`;
      const gap = Math.max(1, cols - visible(left) - visible(rightFooter));
      return `${left}${" ".repeat(gap)}${rightFooter}`;
    })();
    const mapFooterSurface = runDetailHeader ? theme.sectionBg : screen === "newrun" ? theme.bodyBg : "";
    const styledMapFooterLine =
      mapFooterLine && mapFooterSurface ? background(mapFooterLine, mapFooterSurface) : mapFooterLine;
    const bottomLines = styledMapFooterLine ? [styledMapFooterLine] : [];
    const footer = [...commandRows, ...secondaryRows, ...bottomLines];
    // Key legends sit on the near-black surface; trailing rows keep the footer band.
    const legendRows = commandRows.length;
    const bodySpace = Math.max(0, rows - header.length - footer.length);
    if (bottomAlign) {
      const block = bottomAlign.block.slice(-bodySpace);
      const room = Math.max(0, bodySpace - block.length);
      const above = bottomAlign.above.slice(0, room);
      body = [...above, ...Array.from({ length: room - above.length }, () => bottomAlign!.filler ?? ""), ...block];
    } else {
      body = body.slice(0, bodySpace);
      while (body.length < bodySpace) body.push("");
    }
    const frame = [...header, ...body, ...footer];
    while (frame.length < rows) frame.push("");
    const headerCount = header.length;
    const footerStart = headerCount + body.length;
    const output = frame.slice(0, rows).map((line, index) => {
      const fitted = fit(sanitizeLine(line), cols);
      if (index < headerCount) return background(fitted, headerTone);
      if (index >= footerStart) {
        const footerIndex = index - footerStart;
        return background(fitted, footerIndex < legendRows ? theme.bodyBg : footerBandTone || theme.footerBg);
      }
      // Every page body uses the theme body color, so the surface is controllable.
      return background(fitted, theme.bodyBg);
    });
    process.stdout.write(SYNC_ON + WRAP_OFF + HOME + output.join("\n") + CLEAR_BELOW + WRAP_ON + SYNC_OFF);
  };

  /* ------------------------------------------------------------ issue modal helpers */

  const startIssuePicker = () => {
    issuePick = "newrun";
    issuePickSel = 0;
    issuePickText = "";
  };

  const pickerIssues = () => {
    const cache = readIssueCache(layout(newRunRepo));
    if (!cache) return [];
    return orderIssueTree(cache.issues, issuePickText);
  };

  const newRunIssueAccess = (): IssueAccess => {
    const newRunLayout = layout(newRunRepo);
    const policy = effectivePolicy(newRunRepo);
    const machine = (() => {
      try { return loadMachineConfig(newRunLayout); } catch { return undefined; }
    })();
    return (
      resolveAgentConfig({
        role: newrun.agent,
        agentPolicy: policy?.agents[newrun.agent],
        machineOverrides: machine?.agents[newrun.agent],
      }).issueAccess ?? agentDef(newRunLayout, newrun.agent).issueAccess
    );
  };

  const chooseIssue = (issue: Issue) => {
    newrun.issue = issue.ref;
    issuePick = null;
    const planningAgent = newrun.agent === "planner" || newrun.agent === "review";
    let outcome: string;
    if (issue.reserved) {
      if (planningAgent) outcome = "planning/review attaches to its reserved Task 0";
      else if (newrun.agent === "general" && issue.kind !== "task") {
        outcome = "general attaches to its reserved Task 0";
      } else if (newrun.agent === "sudo" && issue.kind === "task") {
        outcome = "runs attach here";
      } else {
        outcome = "reserved Planning & Review anchor; choose a deliverable Task";
      }
    } else if (issue.kind === "task") {
      outcome = "runs attach here";
    } else if (planningAgent) {
      outcome = "planning/review attaches to its reserved Task 0";
    } else if (newrun.agent === "general") {
      outcome = "general attaches to its reserved Task 0";
    } else if (newRunIssueAccess() === "create") {
      outcome = "a child Task will be created";
    } else {
      outcome = "choose a Task or an agent with issue creation access";
    }
    notify(`linked #${issue.ref.number}; ${outcome}`);
  };

  const newRunWeights = () => {
    const policy = effectivePolicy(newRunRepo);
    const ap = policy?.agents[newrun.agent];
    return ap ? axisWeights(newrun.agent, ap) : undefined;
  };

  const pickerModels = (): ModelPickerEntry[] => {
    const catalogue = loadCatalogue(layout(newRunRepo).catalogueFile);
    if (!catalogue) return [];
    const configured = new Set(
      providerStatuses(createModelsCollection())
        .filter((status) => status.configured)
        .map((status) => status.id),
    );
    const policy = effectivePolicy(newRunRepo);
    const ap = policy?.agents[newrun.agent];
    const machine = (() => {
      try {
        return loadMachineConfig(layout(newRunRepo));
      } catch {
        return undefined;
      }
    })();
    if (!ap || !machine) return [];
    const availability = loadAvailability(l.home);
    const funded = fundedProviderIds(machine.providers);
    const weights = newRunWeights();
    const rows = filterModels(catalogue.models, {
      providers: configured,
      codingOnly: true,
      text: modelPickText,
      weights,
      sort: "fit",
    });
    const input = {
      agent: newrun.agent,
      policy: ap,
      machine,
      catalogue: rows,
      configuredProviders: configured,
      fundedProviders: funded,
      contextChars: (newRunPreviewCache?.context.chars ?? 0) + newrun.prompt.length + 2_000,
      tier: newrun.tier,
      availability,
    };
    return rows
      .map((row): ModelPickerEntry => {
        const status = modelStatus(row, input);
        return {
          row,
          fit: modelWeightedFit(row, weights),
          eligible: status.eligible,
          ...(status.eligible ? {} : { reason: status.reason }),
        };
      })
      .sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        if (a.eligible) return b.fit - a.fit || a.row.key.localeCompare(b.row.key);
        const rank = modelReasonRank(a.reason) - modelReasonRank(b.reason);
        return rank || b.fit - a.fit || a.row.key.localeCompare(b.row.key);
      });
  };

  const startModelPicker = () => {
    modelPick = "newrun";
    modelPickText = "";
    modelPickEntries = pickerModels();
    const index = newrun.model
      ? modelPickEntries.findIndex((entry) => entry.row.key === newrun.model)
      : -1;
    modelPickSel = index >= 0 ? index + 1 : 0;
  };

  /* ------------------------------------------------------------- input */

  const handleKey = (data: string) => {
    if (data === "\x03") {
      cleanup();
      process.exit(0);
    }

    // Text-entry modes take precedence over global navigation.
    if (screen === "answer") {
      if (data === "\x1b") { screen = "run"; answerText = ""; draw(); return; }
      if (data === "\r" || data === "\n") {
        if (answerText.trim() && selectedRunId) {
          const detail = runDetailData();
          if (detail) {
            try {
              appendInbox(detail.dir, { questionId: answerQuestionId, kind: "answer", text: answerText, source: "tui" });
              notify("answer recorded");
            } catch { notify("could not record answer"); }
          }
        }
        screen = "run";
        answerText = "";
        draw();
        return;
      }
      if (data === "\x7f" || data === "\b") { answerText = answerText.slice(0, -1); draw(); return; }
      if (!data.startsWith("\x1b")) { answerText += printable(data); draw(); return; }
      draw();
      return;
    }

    if (screen === "correct") {
      if (data === "\x1b") { screen = "run"; correctText = ""; draw(); return; }
      if (data === "i") { interrupt(runDetailData()?.summary); screen = "run"; draw(); return; }
      if (data === "\r" || data === "\n") { submitCorrection(); draw(); return; }
      if (data === "\x7f" || data === "\b") { correctText = correctText.slice(0, -1); draw(); return; }
      if (!data.startsWith("\x1b")) { correctText += printable(data); draw(); return; }
      draw();
      return;
    }

    if (screen === "newrun") {
      if (modelPick === "newrun") {
        const list = modelPickEntries;
        if (data === "\x1b") { modelPick = null; draw(); return; }
        if (data === "\x1b[A" || data === "k") { modelPickSel = Math.max(0, modelPickSel - 1); draw(); return; }
        if (data === "\x1b[B" || data === "j") {
          modelPickSel = Math.min(list.length, modelPickSel + 1);
          draw();
          return;
        }
        if (data === "\r" || data === "\n") {
          if (modelPickSel === 0) {
            newrun.model = undefined;
          } else {
            const entry = list[modelPickSel - 1];
            if (!entry) {
              draw();
              return;
            }
            if (!entry.eligible) {
              notify(`model not eligible: ${modelReasonText(entry, loadAvailability(l.home))}`);
              draw();
              return;
            }
            newrun.model = entry.row.key;
          }
          modelPick = null;
          notify(newrun.model ? `model ${newrun.model}` : "model auto");
          draw();
          return;
        }
        if (data === "\x7f" || data === "\b") {
          modelPickText = modelPickText.slice(0, -1);
          modelPickEntries = pickerModels();
          modelPickSel = 0;
          draw();
          return;
        }
        if (!data.startsWith("\x1b")) {
          modelPickText += printable(data);
          modelPickEntries = pickerModels();
          modelPickSel = 0;
          draw();
          return;
        }
        draw();
        return;
      }
      if (issuePick === "newrun") {
        if (data === "\x1b") { issuePick = null; draw(); return; }
        if (data === "\x1b[A" || data === "k") { issuePickSel = Math.max(0, issuePickSel - 1); draw(); return; }
        if (data === "\x1b[B" || data === "j") { const list = pickerIssues(); issuePickSel = Math.min(Math.max(0, list.length - 1), issuePickSel + 1); draw(); return; }
        if (data === "\r" || data === "\n") { const list = pickerIssues(); const picked = list[issuePickSel]; if (picked) chooseIssue(picked.issue); draw(); return; }
        if (data === "\x7f" || data === "\b") { issuePickText = issuePickText.slice(0, -1); issuePickSel = 0; draw(); return; }
        if (!data.startsWith("\x1b")) { issuePickText += printable(data); issuePickSel = 0; draw(); return; }
        draw();
        return;
      }
      if (newRunSettings) {
        if (data === "\x1b" || data === "s") { newRunSettings = false; draw(); return; }
        if (data === "\x1b[A" || data === "k") { newRunSettingsSel = Math.max(0, newRunSettingsSel - 1); draw(); return; }
        if (data === "\x1b[B" || data === "j") {
          newRunSettingsSel = Math.min(NEW_RUN_SETTING_FIELDS.length - 1, newRunSettingsSel + 1);
          draw();
          return;
        }
        if (data === "\r" || data === "\n" || data === " ") {
          cycleNewRunSetting(NEW_RUN_SETTING_FIELDS[newRunSettingsSel]!);
          draw();
          return;
        }
        draw();
        return;
      }
      if (newRunInsert) {
        if (data === "\x1b") { newRunInsert = false; draw(); return; }
        if (data === "\r" || data === "\n") {
          newrun.prompt += "\n";
        } else if (data === "\x7f" || data === "\b") {
          newrun.prompt = newrun.prompt.slice(0, -1);
        } else if (!data.startsWith("\x1b")) {
          newrun.prompt += printable(data);
          if (newrun.prompt.length > 12_000) newrun.prompt = newrun.prompt.slice(0, 12_000);
        }
        draw();
        return;
      }
      if (newRunColon) {
        newRunColon = false;
        if (data === "!") submitNewRun();
        draw();
        return;
      }
      if (data === ":") { newRunColon = true; draw(); return; }
      if (data === "\x1b") { screen = "list"; draw(); return; }
      if (data === "h" || data === "\x1b[D") {
        newRunContextTab = Math.max(0, newRunContextTab - 1);
        newRunContextItem = 0;
        draw();
        return;
      }
      if (data === "l" || data === "\x1b[C") {
        newRunContextTab = Math.min(NEW_RUN_CONTEXT_TABS.length - 1, newRunContextTab + 1);
        newRunContextItem = 0;
        draw();
        return;
      }
      if (data === "j") { newRunContextItem += 1; draw(); return; }
      if (data === "k") { newRunContextItem = Math.max(0, newRunContextItem - 1); draw(); return; }
      if (data === " ") {
        const key = newRunContextItemKeys[newRunContextItem];
        const available = newRunContextItemAvailable[newRunContextItem] === true;
        if (key && available) {
          if (key.startsWith("knowledge:")) {
            if (newRunContextIncluded.has(key)) newRunContextIncluded.delete(key);
            else {
              newRunContextIncluded.add(key);
              newRunContextExcluded.delete(key);
            }
          }
        } else if (key && !key.startsWith("core-tool:")) {
          if (newRunContextExcluded.has(key)) newRunContextExcluded.delete(key);
          else {
            newRunContextExcluded.add(key);
            newRunContextIncluded.delete(key);
          }
        }
        draw();
        return;
      }
      if (data === "x") {
        if (newRunContextSectionKey) {
          if (newRunContextExcluded.has(newRunContextSectionKey)) newRunContextExcluded.delete(newRunContextSectionKey);
          else newRunContextExcluded.add(newRunContextSectionKey);
        }
        draw();
        return;
      }
      if (data === "a") { cycleAgent(); draw(); return; }
      if (data === "t") { newrun.tier = newrun.tier === "paid" ? "free" : "paid"; draw(); return; }
      if (data === "i" && newRunContextSectionKey === "section:issues") { startIssuePicker(); draw(); return; }
      if (data === "m") { startModelPicker(); draw(); return; }
      if (data === "s") { newRunSettings = true; newRunSettingsSel = 0; draw(); return; }
      if (data === "e" || data === "p") { newRunInsert = true; draw(); return; }
      if (data === "X" && newrun.issue) { newrun.issue = undefined; draw(); return; }
      draw();
      return;
    }

    if (searchMode) {
      if (data === "\x1b") { searchMode = false; searchText = ""; draw(); return; }
      if (data === "\r" || data === "\n") { applySearch(); draw(); return; }
      if (data === "\x7f" || data === "\b") { searchText = searchText.slice(0, -1); draw(); return; }
      if (!data.startsWith("\x1b")) { searchText += printable(data); draw(); return; }
      draw();
      return;
    }

    // Page switching.
    const tabIndex = Number(data);
    if (data.length === 1 && tabIndex >= 1 && tabIndex <= TABS.length) {
      page = TABS[tabIndex - 1]!.id;
      screen = "list";
      searchText = "";
      draw();
      return;
    }
    if (data === "\t") {
      const index = TABS.findIndex((tab) => tab.id === page);
      page = TABS[(index + 1) % TABS.length]!.id;
      screen = "list";
      searchText = "";
      draw();
      return;
    }
    if (data === "q") {
      if (screen !== "list") { screen = "list"; draw(); return; }
      if (page !== "runs") { page = "runs"; draw(); return; }
      cleanup();
      process.exit(0);
    }
    if (data === "\x1b") {
      if (screen !== "list") { screen = "list"; draw(); return; }
      if (page !== "runs") { page = "runs"; draw(); return; }
      cleanup();
      process.exit(0);
    }

    /* --------------------------------------------------------- runs keys */
    if (page === "runs" && screen === "list") {
      const allRuns = listAllRuns(l.home);
      issueCachesByRepo = collectIssueCaches(allRuns);
      const filtered = runsFilter === "all" || runsFilter === "attention" ? allRuns : filterRuns(allRuns, runsFilter);
      const index = buildRunIndex({
        runs: filtered,
        issuesByRepo: issueCachesByRepo,
        group: runsGroup,
        collapsed,
        text: runsText,
        attentionOnly: runsAttention || runsFilter === "attention",
        preferredRepo: l.repoRoot,
      });
      const repoForRow = (row: RunRow | undefined): string => {
        if (!row) return l.repoRoot;
        if (row.kind === "repo") return row.repoRoot;
        if (row.kind === "run") return repoOf(row.run);
        if (row.kind === "issue") return issueRepoOf(row.issue.ref) ?? l.repoRoot;
        for (let i = index.rows.indexOf(row); i >= 0; i--) {
          const candidate = index.rows[i]!;
          if (candidate.kind === "repo") return candidate.repoRoot;
        }
        return l.repoRoot;
      };
      if (data === "\x1b[A" || data === "k") { runsSel = Math.max(0, runsSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { runsSel = Math.min(Math.max(0, index.selectable.length - 1), runsSel + 1); draw(); return; }
      if (data === "G") { runsSel = Math.max(0, index.selectable.length - 1); draw(); return; }
      const toggleFold = (row: RunRow | undefined): boolean => {
        // A run is a leaf; space on it folds the parent issue/section/repo.
        const target = row?.kind === "run" && row.parent
          ? index.rows.find((candidate) => candidate.id === row.parent)
          : row;
        if (target?.kind !== "issue" && target?.kind !== "section" && target?.kind !== "repo") return false;
        if (!target.collapsible) return false;
        if (collapsed.has(target.id)) collapsed.delete(target.id);
        else collapsed.add(target.id);
        const targetIndex = index.rows.findIndex((candidate) => candidate.id === target.id);
        if (targetIndex >= 0) runsSel = targetIndex;
        return true;
      };
      if (data === "\r" || data === "\n") {
        const row = index.selectable[runsSel];
        if (row?.kind === "section" || row?.kind === "repo") { toggleFold(row); draw(); return; }
        if (row?.kind === "issue") { selectedIssueKey = refKey(row.issue.ref); issueRunSel = 0; issueScroll = 0; screen = "issue"; }
        else if (row?.kind === "run") { selectedRunId = row.run.id; runSection = "overview"; runScroll = 0; screen = "run"; }
        draw();
        return;
      }
      if (data === " ") {
        toggleFold(index.selectable[runsSel]);
        draw();
        return;
      }
      if (data === "n") {
        const row = index.selectable[runsSel];
        const issue = row?.kind === "issue" ? row.issue.ref : row?.kind === "run" ? row.run.issue : undefined;
        startNewRun(issue, repoForRow(row));
        draw();
        return;
      }
      if (data === "N") { startNewRun(undefined, l.repoRoot); draw(); return; }
      if (data === "!") { runsAttention = !runsAttention; runsSel = 0; draw(); return; }
      if (data === "g") {
        runsGroup = RUN_GROUPS[(RUN_GROUPS.indexOf(runsGroup) + 1) % RUN_GROUPS.length]!;
        runsSel = 0;
        runsScroll = 0;
        draw();
        return;
      }
      if (data === "f") {
        const filters: RunListFilter[] = ["all", "active", "awaiting", "paused", "completed", "attention"];
        runsFilter = filters[(filters.indexOf(runsFilter) + 1) % filters.length]!;
        runsAttention = runsFilter === "attention";
        runsSel = 0;
        draw();
        return;
      }
      if (data === "/") { searchMode = true; searchText = searchSeed(); draw(); return; }
      if (data === "r") { void refreshIssues("all"); draw(); return; }
      draw();
      return;
    }

    /* -------------------------------------------------------- issue keys */
    if (page === "runs" && screen === "issue") {
      const issue = selectedIssue();
      if (!issue) { screen = "list"; draw(); return; }
      const issueRoot = issueRepoOf(issue.ref) ?? l.repoRoot;
      const issueRuns = sortRuns(listAllRuns(l.home).filter((run) => refKey(run.issue) === refKey(issue.ref)), "activity");
      if (data === "\x1b[A" || data === "k") { issueRunSel = Math.max(0, issueRunSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { issueRunSel = Math.min(Math.max(0, issueRuns.length - 1), issueRunSel + 1); draw(); return; }
      if (data === "\r" || data === "\n") { const run = issueRuns[issueRunSel]; if (run) { selectedRunId = run.id; runSection = "overview"; screen = "run"; } draw(); return; }
      if (data === "n") { startNewRun(issue.ref, issueRoot); draw(); return; }
      if (data === "p") { approveSelected(issue, undefined, issueRoot); draw(); return; }
      if (data === "o") { openUrl(issue.url); draw(); return; }
      draw();
      return;
    }

    /* --------------------------------------------------------- run keys */
    if (page === "runs" && screen === "run") {
      const detail = runDetailData();
      if (!detail) { screen = "list"; draw(); return; }
      const n = detail.events.length;
      const stepTimeline = (direction: -1 | 1): void => {
        timelineFollow = false;
        const next = stepTimelineSelection(detail.events, eventSel, direction, timelineVerbose);
        if (next !== eventSel) {
          eventSel = next;
          eventBodyScroll = 0;
        }
      };
      if (data === "j" || data === "\x1b[B") {
        if (runSection === "timeline") stepTimeline(1);
        else if (runSection === "processes") { processFollow = false; processSel++; }
        else if (runSection === "thinking") { thinkingFollow = false; thinkingScroll++; }
        else if (runSection === "related") childSel++;
        else runScroll++;
        draw();
        return;
      }
      if (data === "k" || data === "\x1b[A") {
        if (runSection === "timeline") stepTimeline(-1);
        else if (runSection === "processes") { processFollow = false; processSel = Math.max(0, processSel - 1); }
        else if (runSection === "thinking") { thinkingFollow = false; thinkingScroll = Math.max(0, thinkingScroll - 1); }
        else if (runSection === "related") childSel = Math.max(0, childSel - 1);
        else runScroll = Math.max(0, runScroll - 1);
        draw();
        return;
      }
      const moveSection = (delta: number) => {
        const index = RUN_SECTIONS.indexOf(runSection);
        runSection = RUN_SECTIONS[(index + delta + RUN_SECTIONS.length) % RUN_SECTIONS.length]!;
        runScroll = 0;
        processSel = 0;
        processFollow = false;
        eventScroll = 0;
        eventBodyScroll = 0;
        if (runSection === "timeline") {
          timelineFollow = true;
          const last = lastTimelineIndex(detail.events, timelineVerbose);
          if (last >= 0) eventSel = last;
        }
        thinkingFollow = true;
        draw();
      };
      if (data === "h" || data === "\x1b[D") { moveSection(-1); return; }
      if (data === "l" || data === "\x1b[C") { moveSection(1); return; }
      if (data === "]" || data === "[") { moveSection(data === "]" ? 1 : -1); return; }
      const toggleEvent = () => {
        if (runSection !== "timeline") return;
        timelineFollow = false;
        while (eventSel < n && !isTimelineEvent(detail.events[eventSel], timelineVerbose)) eventSel += 1;
        if (eventSel >= n) return;
        eventBodyScroll = 0;
        const key = `${detail.summary.id}:${eventSel}`;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      };
      if (data === " ") { toggleEvent(); draw(); return; }
      if (data === "f") { forkRun(detail); draw(); return; }
      if (runSection === "timeline" && data === "F") {
        timelineFollow = !timelineFollow;
        if (timelineFollow) {
          const last = lastTimelineIndex(detail.events, timelineVerbose);
          if (last >= 0) eventSel = last;
          eventBodyScroll = 0;
        }
        notify(timelineFollow ? "following latest event" : "follow off");
        draw();
        return;
      }
      if (runSection === "timeline" && data === "v") {
        timelineVerbose = !timelineVerbose;
        const last = lastTimelineIndex(detail.events, timelineVerbose);
        if (last >= 0) eventSel = last;
        eventBodyScroll = 0;
        notify(timelineVerbose ? "showing all events" : "showing key events");
        draw();
        return;
      }
      if (data === "\x1b[6~" || data === "\x1b[5~") {
        const direction = data === "\x1b[6~" ? 1 : -1;
        if (runSection === "timeline") {
          timelineFollow = false;
          eventBodyScroll = Math.max(0, eventBodyScroll + direction * 10);
        } else if (runSection === "thinking") {
          thinkingFollow = false;
          thinkingScroll = Math.max(0, thinkingScroll + direction * 10);
        } else {
          runScroll = Math.max(0, runScroll + direction * 10);
        }
        draw();
        return;
      }
      if (runSection === "processes" && data === "F") {
        processFollow = !processFollow;
        if (processFollow) processSel = Math.max(0, reconcileProcessRecords(detail.dir).length - 1);
        notify(processFollow ? "following latest process" : "follow off");
        draw();
        return;
      }
      if (runSection === "processes" && data === "o") {
        const record = reconcileProcessRecords(detail.dir)[processSel];
        if (!record) notify("no process selected");
        else openEditor(record.stdoutLog);
        draw();
        return;
      }
      if (runSection === "processes" && data === "x") {
        const record = reconcileProcessRecords(detail.dir)[processSel];
        if (!record) notify("no process selected");
        else {
          void (async () => {
            try {
              const outcome = await terminateProcessRecord(record);
              notify(outcome === "kill" ? `SIGKILL ${record.id}` : `SIGTERM ${record.id}`);
            } catch (error) {
              notify((error as Error).message);
            }
            draw();
          })();
        }
        draw();
        return;
      }
      if (runSection === "processes" && data === "X") {
        void (async () => {
          const outcome = await terminateAllProcesses(reconcileProcessRecords(detail.dir));
          notify(
            outcome.terminated || outcome.killed
              ? `terminated ${outcome.terminated}${outcome.killed ? `, killed ${outcome.killed}` : ""}`
              : "no live processes",
          );
          draw();
        })();
        draw();
        return;
      }
      if (data === "a") { answerRun(detail.summary); draw(); return; }
      if (data === "i") { interrupt(detail.summary); draw(); return; }
      if (data === "c") { startCorrect(detail.summary); draw(); return; }
      if (data === "p") { approveSelected(issueByRef(detail.summary.issue), detail.summary, detail.summary.repoRoot); draw(); return; }
      if (data === "o") { openUrl(issueByRef(detail.summary.issue)?.url ?? detail.summary.prUrl); draw(); return; }
      if (data === "\r" || data === "\n") {
        if (runSection === "timeline") toggleEvent();
        else if (runSection === "processes") {
          const record = reconcileProcessRecords(detail.dir)[processSel];
          if (!record) notify("no process selected");
          else openEditor(record.stdoutLog);
        }
        else if (runSection === "related") {
          const child = relatedRuns(listAllRuns(l.home), detail.summary)[childSel];
          if (child) { selectedRunId = child.id; runSection = "overview"; screen = "run"; }
        }
        draw();
        return;
      }
      if (data === "g") {
        thinkingFollow = true;
        if (runSection === "timeline") {
          timelineFollow = true;
          const last = lastTimelineIndex(detail.events, timelineVerbose);
          if (last >= 0) eventSel = last;
          eventBodyScroll = 0;
        }
        draw();
        return;
      }
      draw();
      return;
    }

    /* ------------------------------------------------------- model keys */
    if (page === "models" && screen === "model") {
      if (data === "\x1b[A" || data === "k") { modelScroll = Math.max(0, modelScroll - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { modelScroll++; draw(); return; }
      if (data === "t") {
        const row = loadCatalogue(l.catalogueFile)?.models.find((entry) => entry.key === selectedModelKey);
        if (row) {
          probingModels.add(row.key);
          void (async () => {
            try {
              const machine = loadMachineConfig(l);
              const state = loadAvailability(l.home);
              const result = await probeTarget(targetFor(row), machine.availability, state);
              applyProbeResult(state, result);
              saveAvailability(l.home, state);
              notify(`${row.key}: ${result.status}${result.message ? ` (${result.message})` : ""}`);
            } finally {
              probingModels.delete(row.key);
              draw();
            }
          })();
        }
        draw();
        return;
      }
      if (data === "p") { notify(selectedModelKey ?? ""); draw(); return; }
      if (data === "o") { notify(selectedModelKey ?? ""); draw(); return; }
      draw();
      return;
    }

    /* ------------------------------------------------------- models list */
    if (page === "models") {
      if (data === "\x1b[A" || data === "k") { modelSel = Math.max(0, modelSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") {
        modelSel = Math.min(Math.max(0, modelVisible.length - 1), modelSel + 1);
        draw();
        return;
      }
      if (data === "\r" || data === "\n") {
        const row = modelVisible[modelSel];
        if (row) { selectedModelKey = row.key; modelScroll = 0; screen = "model"; }
        draw();
        return;
      }
      if (data === "a") { modelsAll = !modelsAll; modelSel = 0; draw(); return; }
      if (data === "f") {
        modelsFree = !modelsFree;
        // Free offers usually live on providers without paid credentials. Show
        // the whole catalogue while filtering by price, then the user can
        // press a to narrow back to configured providers.
        if (modelsFree) modelsAll = true;
        modelSel = 0;
        draw();
        return;
      }
      if (data === "c") { modelsCoding = !modelsCoding; modelSel = 0; draw(); return; }
      if (data === "g") {
        const values: Array<"provider" | "family" | "none"> = ["provider", "family", "none"];
        modelGroup = values[(values.indexOf(modelGroup) + 1) % values.length]!;
        modelSel = 0;
        draw();
        return;
      }
      if (data === "s") {
        const values: ModelSort[] = ["capability", "fit", "reasoning", "code", "agentic", "general", "context", "price-in", "price-out", "name"];
        modelSort = values[(values.indexOf(modelSort) + 1) % values.length]!;
        modelSel = 0;
        draw();
        return;
      }
      if (data === "/") { searchMode = true; searchText = searchSeed(); draw(); return; }
      draw();
      return;
    }

    /* ------------------------------------------------------- spend keys */
    if (page === "spend") {
      if (data === "\x1b[A" || data === "k") { spendScroll = Math.max(0, spendScroll - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { spendScroll++; draw(); return; }
      if (data === "g") {
        const values: Array<"provider" | "model" | "day" | "agent"> = ["provider", "model", "day", "agent"];
        spendBy = values[(values.indexOf(spendBy) + 1) % values.length]!;
        spendScroll = 0;
        draw();
        return;
      }
      if (data === "d") {
        const values = [7, 30, 90, 0];
        spendDaysWindow = values[(values.indexOf(spendDaysWindow) + 1) % values.length]!;
        spendScroll = 0;
        draw();
        return;
      }
      if (data === "r") { draw(); return; }
      draw();
      return;
    }

    /* -------------------------------------------------- orchestrate keys */
    if (page === "orchestrate") {
      if (data === "\x1b[A" || data === "k") { orchestrateSel = Math.max(0, orchestrateSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { orchestrateSel++; draw(); return; }
      if (data === "s") {
        const candidates = orchestrateCandidates();
        const index = candidates.findIndex(
          (candidate) =>
            candidate.scope === orchestrateScope &&
            ((!candidate.ref && !orchestrateRef) ||
              (candidate.ref &&
                orchestrateRef &&
                candidate.ref.repo === orchestrateRef.repo &&
                candidate.ref.number === orchestrateRef.number)),
        );
        const next = candidates[(index + 1 + candidates.length) % candidates.length] ?? { scope: "project" as const };
        orchestrateScope = next.scope;
        orchestrateRef = next.ref;
        orchestrateSel = 0;
        orchestrateScroll = 0;
        draw();
        return;
      }
      if (data === "r") { void refreshIssues("current"); draw(); return; }
      const selectedTask = () => {
        const cached = readIssueCache(l)?.issues ?? [];
        const runs = listAllRuns(l.home).filter((run) => run.repoRoot === l.repoRoot);
        return planSchedule({
          issues: cached,
          scope: orchestrateScope,
          ...(orchestrateRef ? { scopeRef: orchestrateRef } : {}),
          runs,
        }).tasks[orchestrateSel];
      };
      if (data === "x") {
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        const args = ["orchestrate", "start", "--scope", orchestrateScope];
        if (orchestrateScope === "epic" && orchestrateRef) args.push("--epic", String(orchestrateRef.number));
        if (orchestrateScope === "feature" && orchestrateRef) args.push("--feature", String(orchestrateRef.number));
        const child = spawn(process.execPath, [cliPath, ...args], {
          cwd: l.repoRoot,
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.unref();
        notify(`started orchestration for ${orchestrateScope}`);
        draw();
        return;
      }
      if (data === "a" || data === "A") {
        const task = selectedTask();
        const states = listOrchestrations(l);
        const state =
          states.find(
            (candidate) =>
              candidate.scope === orchestrateScope &&
              ((!orchestrateRef && !candidate.scopeRef) ||
                (orchestrateRef &&
                  candidate.scopeRef?.repo === orchestrateRef.repo &&
                  candidate.scopeRef.number === orchestrateRef.number)),
          ) ?? states[0];
        if (!task) notify("no task selected");
        else if (!state) notify("no orchestration state");
        else {
          const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
          const args = ["orchestrate", "approve", "--orchestration", state.id, "--task", String(task.issue.ref.number)];
          if (data === "A") args.push("--result");
          const child = spawn(process.execPath, [cliPath, ...args], {
            cwd: l.repoRoot,
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          notify(`${data === "A" ? "result" : "packet"} approval for #${task.issue.ref.number}`);
        }
        draw();
        return;
      }
      if (data === "\r" || data === "\n") {
        const task = selectedTask();
        if (task) {
          selectedIssueKey = refKey(task.issue.ref);
          page = "runs";
          screen = "issue";
        }
        draw();
        return;
      }
      draw();
      return;
    }

    /* ---------------------------------------------------- settings keys */
    if (page === "settings") {
      if (data === "\x1b[A" || data === "k") { settingsSel = Math.max(0, settingsSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { settingsSel++; draw(); return; }
      draw();
      return;
    }

    draw();
  };

  stdin.on("data", (chunk: string) => {
    // Terminal key repeat can deliver several keys in one read. Text entry
    // accepts the whole chunk (so pastes stay intact); navigation replays each
    // key so held j/k never get dropped.
    const textEntry =
      screen === "answer" ||
      screen === "correct" ||
      searchMode ||
      (screen === "newrun" && newRunInsert);
    if (textEntry && !chunk.includes("\x1b")) handleKey(chunk);
    else for (const key of splitKeys(chunk)) handleKey(key);
  });

  // Issue picker overlay is drawn after the page body by replacing the body
  // bottom; keeping it in the draw path above avoids another navigation mode.
  const drawWithPicker = () => {
    const original = draw;
    void original;
    draw();
  };
  void drawWithPicker;

  void refreshIssues();
  let availabilityProbeAt = Date.now();
  setInterval(() => {
    if (Date.now() - issueRefreshAt > 30_000) void refreshIssues();
    if (Date.now() - availabilityProbeAt > 60_000) {
      availabilityProbeAt = Date.now();
      void (async () => {
        try {
          const machine = loadMachineConfig(l);
          const catalogue = loadCatalogue(l.catalogueFile);
          if (!catalogue) return;
          const state = loadAvailability(l.home);
          const configured = new Set(
            providerStatuses(createModelsCollection())
              .filter((status) => status.configured)
              .map((status) => status.id),
          );
          const results = await probeCoolingModels({
            rows: catalogue.models,
            state,
            config: machine.availability,
            configuredProviders: configured,
          });
          if (results.length > 0) {
            saveAvailability(l.home, state);
            if (!newRunInsert) draw();
          }
        } catch {
          // background availability refresh must never break the TUI
        }
      })();
    }
    // The composer repaints on input; background refreshes would only steal
    // frames from typing.
    if (!newRunInsert) draw();
  }, 1_000);
  process.stdout.on("resize", draw);
  draw();
  await new Promise(() => { /* run until exit */ });
}

/* ---------------------------------------------------------------- helpers */

function policyWeightsFor(agent: string): Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined {
  try {
    const l = layout();
    const policy = loadPolicy(l);
    const ap = policy.agents[agent];
    return ap ? axisWeights(agent, ap) : undefined;
  } catch {
    return undefined;
  }
}

function modelWeightedFit(
  row: CatalogueRow,
  weights: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined,
): number {
  if (!weights) return row.scores.capability;
  const base = { reasoning: weights.reasoning ?? 0.25, code: weights.code ?? 0.25, agentic: weights.agentic ?? 0.25, general: weights.general ?? 0.25 };
  const sum = base.reasoning + base.code + base.agentic + base.general;
  if (sum <= 0) return row.scores.capability;
  return (
    row.scores.reasoning * (base.reasoning / sum) +
    row.scores.code * (base.code / sum) +
    row.scores.agentic * (base.agentic / sum) +
    row.scores.general * (base.general / sum)
  );
}

function presetConfigText(config: AgentConfig): string {
  return (
    `delegate ${config.delegate ? "on" : "off"} · verify ${config.verification}` +
    ` · issues ${config.issues} · ask ${config.ask ? "on" : "off"}` +
    ` · approval ${config.approval} · ambiguity ${config.ambiguity}` +
    `${config.artifactScripts ? " · artifacts on" : ""}`
  );
}

function axisFloorText(axes: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined): string {
  return CAPABILITY_AXES.map((axis) => `${axis[0]!.toUpperCase()}${(axes?.[axis] ?? 0).toFixed(1)}`).join(" ");
}

function policyFloorText(ap: AgentPolicy | undefined, tier: "free" | "paid"): string {
  if (!ap) return "no policy";
  const fit = (tier === "free" ? ap.freeMinFit ?? ap.minFit : ap.minFit) ?? 0;
  const axes = tier === "free" ? { ...(ap.minAxes ?? {}), ...(ap.freeMinAxes ?? {}) } : ap.minAxes;
  const turns = ap.maxTurns === undefined ? "default" : String(ap.maxTurns);
  const budget = ap.budgetTokens === undefined ? "" : ` · budget ${ap.budgetTokens}`;
  return `min fit ${fit.toFixed(1)} · axes ${axisFloorText(axes)} · max turns ${turns}${budget}`;
}

function settingExplanation(
  field: NewRunSettingField,
  state: NewRunState,
  ap: AgentPolicy | undefined,
  def: AgentDef,
): string {
  switch (field) {
    case "preset": {
      const preset = PRESETS[state.preset];
      return (
        `${NEW_RUN_PRESET_INFO[state.preset] ?? "Unknown preset."} ` +
        `Defaults: ${preset ? presetConfigText(preset) : "unknown"}. ` +
        `Agent default preset: ${def.preset}. Policy: ${policyFloorText(ap, state.tier)}.`
      );
    }
    case "verification":
      return "direct runs the role's own checks. verified adds focused tests for acceptance. redundant adds an independent Review run.";
    case "issues":
      return "required fails the run when issue tracking is unavailable. optional uses it when available. disabled removes the issue tool.";
    case "ask":
      return "on lets the agent ask one precise question when a wrong change is likely. off makes it decide from context.";
    case "approval":
      return "human requires human approval for issue close and PR merge. agent lets the agent approve its own result.";
    case "ambiguity":
      return "strict asks on any material gap. precise resolves low-impact gaps and asks when a choice changes the work. adaptive infers intent. autonomous decides without asking.";
    case "minFit":
      return "Hard floor for the role-weighted model fit. role uses the policy floor. 0 disables the floor.";
    case "floors":
      return "role uses the policy axis floors. strict adds 0.5 to each role axis floor. off removes axis floors.";
  }
}
