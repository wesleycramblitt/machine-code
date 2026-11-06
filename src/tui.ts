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
import { isActiveStatus, listAllRuns, listProjects, readRun, type RunEvent, type RunSummary } from "./state/runs.js";
import { summarizeRun, readStateView } from "./state/outcome.js";
import { appendInbox, latestUnansweredQuestion, readInbox } from "./state/question.js";
import { addTombstones, readIssueCache, removeTombstones, writeIssueCache } from "./issues/cache.js";
import type { Issue, IssueRef } from "./issues/provider.js";
import { headerCounts, issueGlyphKind, issueRowDetail, sortRuns } from "./tui/status.js";
import {
  RUN_GROUPS,
  RUN_GROUP_LABELS,
  buildRunIndex,
  focusRowIds,
  orderIssueTree,
  repoLabel,
  repoOf,
  type RunGroup,
  type RunRow,
} from "./tui/runs.js";
import { scrollLines, selectableLines } from "./tui/scroll.js";
import { describeTimelineEvent, describeToolArgs, isTimelineEvent, lastTimelineIndex, stepTimelineSelection, waitingForRun } from "./tui/timeline.js";
import { buildSettings, settingsFileFor, type SettingRow } from "./tui/settings.js";
import { forkSettingsFromRun, type ForkedRunSettings } from "./tui/fork.js";
import { loadMachineConfig, loadPolicy, CAPABILITY_AXES, SELECTION_TIERS, DEFAULT_THEME, type AgentPolicy, type MachineConfig, type Policy, type ThemeConfig } from "./config.js";
import { axisWeights, effectiveCallCost, estimateTokens, isMetaRouter, modelStatus, pick } from "./select.js";
import { readSpendSummary, spendBar, spendDays } from "./spend.js";
import { loadAvailability, saveAvailability, type AvailabilityState } from "./availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "./availability/probe.js";
import { latestProcessRecords } from "./processes/registry.js";
import { planSchedule, type ScheduledTask } from "./orchestrator/scheduler.js";
import { featureBranchFor } from "./worktree.js";
import { listOrchestrations, orchestrationStopRequested, readLease, requestOrchestrationStop } from "./orchestrator/state.js";
import { skillListItems, toolListItems, tokensForChars } from "./tui/tools.js";
import { toolSchemaChars } from "./tools/schema.js";
import { readLogTail } from "./processes/logs.js";
import { reconcileProcessRecords } from "./processes/reconcile.js";
import { terminateAllProcesses, terminateProcessRecord } from "./processes/supervisor.js";
import { AGENT_META, AGENT_NAMES, agentDef, roleSkillPresets, type IssueAccess } from "./agents.js";
import { resolveAgent, resolveAgentConfig } from "./agents/config.js";
import { issueAccessFromCapabilities } from "./policy/capabilities.js";
import { isGenericTaskRequest, issueRequestVerb, issueRunRequest } from "./issues/work.js";
import { createModelsCollection, providerStatuses } from "./models.js";
import { fundedProviderIds } from "./data.js";
import { loadCatalogue } from "./catalogue/load.js";
import { filterModels, groupModels, siblingOffers, type ModelSort } from "./catalogue/query.js";
import type { CatalogueDocument, CatalogueRow } from "./catalogue/types.js";
import { previewContext, artifactPreview, discoverKnowledgeFiles, type ContextPreview } from "./context/preview.js";
import { contextBudget } from "./context/budget.js";
import { skillMetas, defaultSkillsFor, resolveSkillMode, type SkillMode } from "./context/references.js";
import { listReferenceEntries } from "./references/store.js";
import { changesFor, contextUsage, readContextManifest, relatedRuns, thinkingChunks, touchedPaths, type ChangeSummary, type ThinkingChunk } from "./report/run.js";
import { artifactPath, listArtifacts, type ArtifactDef } from "./artifacts/registry.js";
import { loadSemanticOrDeterministic, readSemanticDirty, renderSemanticIndex } from "./map/semantic.js";
import { readCachedMap, renderMapIndex, symbolCount } from "./map/deterministic.js";
import { serverAvailable } from "./lsp/index.js";
import type { FeatureStatus } from "./tasks/lifecycle.js";

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

/** Vim-style half-page scrolls. PageUp/PageDown are not bound anywhere. */
const CTRL_D = "\x04";
const CTRL_U = "\x15";
const HALF_PAGE = 10;

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

type Page = "runs" | "models" | "spend" | "settings";
type Screen = "list" | "issue" | "run" | "newrun" | "answer" | "correct" | "model" | "pipeline" | "delete";
type PipelineScope = { kind: "epic" | "feature"; ref: IssueRef };
type RunSection = "overview" | "timeline" | "processes" | "thinking" | "changes" | "related" | "context";
/** Runs list repo scope: every known repo, or the TUI cwd only. */
type RunsRepoScope = "all" | "cwd";

const TABS: Array<{ id: Page; label: string; key: string }> = [
  { id: "runs", label: "Runs", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "spend", label: "Spend", key: "3" },
  { id: "settings", label: "Settings", key: "4" },
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

interface ContextPanelItem {
  text: string;
  chars: number;
  exists: boolean;
  key: string;
  fixed?: boolean;
  available?: boolean;
  counted?: boolean;
}
const NEW_RUN_CONTEXT_TABS = ["Issues", "Files", "Knowledge", "References", "Skills", "Tools", "Scripts", "Plans", "Codebase", "Prompt"] as const;

type NewRunState = ForkedRunSettings & {
  /** Isolation worktree. Shown only for build/sudo; other agents ignore it. */
  worktree: boolean;
};

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

function modelPriceText(row: CatalogueRow): string {
  if (row.free || (row.pricing.input === 0 && row.pricing.output === 0)) return "";
  return ` ${D}$${row.pricing.input}/$${row.pricing.output}${R}`;
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

/** Per-event accent color for timeline dots and overview snippets. */
function eventTone(type: string, isError = false): string {
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
    case "issue_created":
    case "issue_linked": return G;
    case "retry":
    case "control":
    case "turn_cap":
    case "budget_exhausted": return Y;
    case "run_end":
    case "error_classified":
    case "malformed_tool_call":
    case "loop_blocked": return RED;
    default: return D;
  }
}

/** Compact codebase-index health tokens for bottom footers. */
function mapStatusTokens(root: string): string[] {
  const mapCached = existsSync(join(root, ".machine_code", "local", "cache", "map.json"));
  const semantic = loadSemanticOrDeterministic(root);
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

/** Dimmed hierarchy text: darker than D, still readable on the body surface. */
const DIM = "\x1b[38;2;96;102;112m";

/** Replace every foreground color and attribute with one dark gray. */
function dim(value: string): string {
  return `${DIM}${value.replace(/\x1b\[[0-9;]*m/g, (seq) => {
    if (seq === R) return `${R}${DIM}`;
    if (seq === BG || seq.startsWith("\x1b[48;")) return seq;
    return DIM;
  })}${R}`;
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

/** Subtle zebra stripe for timeline rows (slightly lighter than body #0a0a0a). */
const ZEBRA_BG = "\x1b[48;2;15;15;17m";

/** True for write/edit tool events (both start and completion records). */
function isEditToolEvent(event: RunEvent): boolean {
  if (event.type !== "tool_call" && event.type !== "tool_call_start") return false;
  const tool = String((event as { tool?: unknown }).tool ?? "");
  return tool === "write" || tool === "edit";
}

function editEventArgs(event: RunEvent): Record<string, unknown> {
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
function editSummaryLines(event: RunEvent, width: number, maxLines = 30): string[] {
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
function recentEditEvents(events: readonly RunEvent[], limit = 5): RunEvent[] {
  const out: RunEvent[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    if (!isEditToolEvent(event)) continue;
    out.push(event);
  }
  return out.slice(-Math.max(1, limit));
}

/* ------------------------------------------------------------------ app */

export async function runTui(): Promise<void> {
  const l = layout();
  mkdirSync(l.localDir, { recursive: true });

  let page: Page = "runs";
  let screen: Screen = "list";
  /** Repo scope for the runs list. `f` toggles all repos vs the TUI cwd. */
  let runsRepoScope: RunsRepoScope = "all";
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
  /** Collapsed model groups (provider/family key). Headers are cursor stops, so space reopens them. */
  const modelCollapsed = new Set<string>();
  /** Cursor stops in render order: group headers plus visible model rows. */
  let modelDisplay: Array<{ kind: "header"; key: string } | { kind: "row"; key: string; row: CatalogueRow }> = [];
  let selectedModelKey: string | null = null;
  /** Catalogue + provider cache: the 1MB models.json stays parsed across frames. */
  let catalogueCache: { mtime: number; doc: CatalogueDocument | null } | null = null;
  let statusesCache: { at: number; statuses: ReturnType<typeof providerStatuses> } | null = null;

  let spendDaysWindow = 30;
  let spendBy: "provider" | "model" | "day" | "agent" = "provider";
  let spendScroll = 0;

  let settingsSel = 0;
  let settingsScroll = 0;

  let selectedIssueKey: string | null = null;
  let selectedRunId: string | null = null;
  let deleteTarget: Issue | undefined;
  let deleteRunTarget: RunSummary | undefined;
  let deleteReturn: Screen = "list";
  let deleteInFlight = false;
  const deletingIssues = new Set<string>();
  const deletingRuns = new Set<string>();
  let issueRefreshQueued = false;
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
  /** Follow the newest timeline event; j/k or ^D/^U turns it off. */
  let timelineFollow = true;
  /** Show routine internals in the timeline. */
  let timelineVerbose = false;
  let thinkingScroll = 0;
  let thinkingFollow = true;
  let childSel = 0;
  let pipelineScope: PipelineScope | undefined;
  let pipelineSel = 0;
  let pipelineScroll = 0;
  /** `:` starts the two-key `:!` tick command on the pipeline screen. */
  let pipelineColon = false;
  /** Cached featureStatus per feature ref; refreshed async, rendered sync. */
  const pipelineFeatureStates = new Map<string, FeatureStatus>();
  let pipelineFeatureStatesAt = 0;
  /** Tasks in the exact order rendered on the orchestration screen (group order). */
  let pipelineTasks: ScheduledTask[] = [];
  /** Orchestration settings, edited on the orchestration screen like new-run settings. */
  let orchTier: "free" | "paid" = "paid";
  let orchMinFit: number | undefined = undefined;
  let orchFloors: "role" | "strict" | "off" = "role";
  let orchMaxParallel = 2;
  let orchMaxMinutes: number | undefined = undefined;
  let orchMaxSpend: number | undefined = undefined;
  let orchCheckpoint = false;
  let orchModel: string | undefined = undefined;
  /** Catalogue/policy cache for the per-task model preview. */
  let orchPreviewCache: {
    key: string;
    at: number;
    catalogue: CatalogueDocument | null;
    policy: Policy | undefined;
    machine: MachineConfig | undefined;
    configured: Set<string>;
    availability: AvailabilityState;
  } | null = null;
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
    worktree: true,
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
  /** Picker sort: role fit (default) or estimated per-call price. Eligible rows always first. */
  let modelPickSort: "fit" | "price" = "fit";
  let modelPickEntries: ModelPickerEntry[] = [];
  /** New-run prompt is modal: navigation keys are disabled while true. */
  let newRunInsert = false;
  /** `:` starts the two-key `:!` start command. */
  let newRunColon = false;
  let newRunContextTab = 0;
  let newRunContextItem = 0;
  let newRunContextItemKeys: string[] = [];
  let newRunContextItemAvailable: boolean[] = [];
  let newRunContextSectionKey = "";
  /** `/` filters the active context tab's rows by substring. */
  let newRunContextFilter = "";
  let newRunContextFiltering = false;
  const newRunContextExcluded = new Set<string>();
  const newRunContextIncluded = new Set<string>();
  /** Explicit per-skill mode choices (include | on-demand | exclude). */
  const newRunSkillModes = new Map<string, SkillMode>();
  /** Modes as rendered this frame (single source for space-cycling). */
  const newRunSkillShown = new Map<string, SkillMode>();
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
  let answerOptions: string[] = [];
  let answerScroll = 0;
  let answerPage = 10;
  let answerOverflow = false;
  let correctText = "";
  let searchMode = false;
  let searchText = "";
  let toast = "";
  let toastAt = 0;
  let pendingRunAt = 0;
  /** Fast repaints while waiting for a fresh run record, so new runs open in ~250ms not ~1s. */
  let pendingFastTimer: ReturnType<typeof setInterval> | null = null;
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

  const descendantRefs = (issue: Issue): IssueRef[] => {
    const out: IssueRef[] = [];
    const walk = (parent: Issue): void => {
      for (const ref of parent.children) {
        const child = issueByRef(ref);
        if (!child) continue;
        out.push(child.ref);
        walk(child);
      }
    };
    walk(issue);
    return out;
  };

  const descendantCount = (issue: Issue): number => descendantRefs(issue).length;

  /** Objective text for an issue, using the verb for the current agent. */
  const issuePrompt = (issue: Issue | undefined, agent: string): string =>
    issue ? issueRunRequest(issue, issueRequestVerb(agent)) : "";

  const refreshIssues = async (scope: "current" | "all" = "current") => {
    if (issueRefreshing) {
      issueRefreshQueued = true;
      return;
    }
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
          const issues = (await bundle.provider.list({ state: "all", limit: 300 }))
            .filter((issue) => !deletingIssues.has(refKey(issue.ref)));
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
      if (issueRefreshQueued) {
        issueRefreshQueued = false;
        void refreshIssues(scope);
      }
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
      preset: "unrestricted",
      verification: "verified",
      issues: "optional",
      ask: true,
      approval: "human",
      ambiguity: "precise",
      tier,
      minFit: undefined,
      floors: "role",
      worktree: true,
      prompt: "",
    };
  };

  newrun = defaultNewRun();

  /** Roles that isolate in a worktree and expose the verify submode. */
  const agentIsolates = (agent: string): boolean => agent === "build" || agent === "sudo";

  const resetNewRunUi = () => {
    newRunInsert = false;
    newRunColon = false;
    newRunContextTab = 0;
    newRunContextItem = 0;
    newRunContextFilter = "";
    newRunContextFiltering = false;
    newRunSkillModes.clear();
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

  const startNewRun = (issue?: IssueRef, repoRoot = l.repoRoot, issueObj?: Issue) => {
    const previous = newrun;
    newRunRepo = repoRoot;
    const knownIssue = issueObj ?? issueByRef(issue);
    // A Feature is implementation work: start with Build. An Epic is
    // planning work: start with Planner. Untracked runs keep the last agent.
    const preferredAgent = knownIssue
      ? knownIssue.kind === "feature"
        ? "build"
        : "planner"
      : issue
        ? "build"
        : previous.agent;
    newrun = {
      ...defaultNewRun(),
      ...(previous.tier ? { tier: previous.tier } : {}),
      ...(preferredAgent ? { agent: preferredAgent } : {}),
      ...(issue ? { issue } : {}),
    };
    // Verification and isolation are role-shaped: build/sudo verify, and a
    // fresh build isolates while sudo starts on the main tree.
    newrun.verification = agentIsolates(newrun.agent) ? "verified" : "direct";
    newrun.worktree = newrun.agent !== "sudo";
    // A task-attached run starts with a concrete objective. The prompt stays
    // editable, but the human no longer has to type one.
    if (knownIssue) newrun.prompt = issuePrompt(knownIssue, newrun.agent);
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
    newrun = {
      ...forkSettingsFromRun({
        summary,
        events: detail.events,
        catalogue: loadCatalogue(repoLayout.catalogueFile),
        defaults,
        configuredProviders: configured,
      }),
      worktree: newrun.worktree,
    };
    // A generic inherited request ("Build the task.") hides the real objective.
    // When the run is attached to an issue, derive the request from it instead.
    const forkIssue = newrun.issue ? issueByRef(newrun.issue) : undefined;
    if (forkIssue && (!newrun.prompt.trim() || isGenericTaskRequest(newrun.prompt))) {
      newrun.prompt = issuePrompt(forkIssue, agent);
    }
    resetNewRunUi();
    newRunParentId = summary.id;
    screen = "newrun";
    notify(`forked settings from ${summary.id.slice(-8)}; edit the request and start`);
  };

  const cycleAgent = () => {
    const previousAgent = newrun.agent;
    const issue = issueByRef(newrun.issue);
    const previousPrompt = issuePrompt(issue, previousAgent);
    const index = NEW_RUN_AGENTS.indexOf(previousAgent);
    newrun.agent = NEW_RUN_AGENTS[(index + 1) % NEW_RUN_AGENTS.length] ?? previousAgent;
    // Verification and isolation follow the role: only build/sudo verify, and
    // sudo starts on the main tree until its worktree toggle is flipped.
    newrun.verification = agentIsolates(newrun.agent) ? "verified" : "direct";
    newrun.worktree = newrun.agent !== "sudo";
    // Keep an auto-derived objective in sync with the agent verb. A prompt the
    // human edited stays untouched.
    if (issue && (!newrun.prompt.trim() || newrun.prompt === previousPrompt)) {
      newrun.prompt = issuePrompt(issue, newrun.agent);
    }
  };

  /** Build-only verification mode, shown as submode[s] beside the agent row. */
  const cycleSubmode = () => {
    const values: NewRunState["verification"][] = ["direct", "verified"];
    newrun.verification = values[(values.indexOf(newrun.verification) + 1) % values.length]!;
  };

  const cycleAmbiguity = () => {
    const values: NewRunState["ambiguity"][] = ["strict", "precise", "adaptive", "autonomous"];
    newrun.ambiguity = values[(values.indexOf(newrun.ambiguity) + 1) % values.length]!;
  };

  const cycleMinFit = () => {
    const values: Array<number | null | undefined> = [undefined, 6, 6.5, 7, 7.5, 8, 8.5, 0];
    newrun.minFit = values[(values.findIndex((value) => value === newrun.minFit) + 1) % values.length];
  };

  const cycleFloors = () => {
    const floors: NewRunState["floors"][] = ["role", "strict", "off"];
    newrun.floors = floors[(floors.indexOf(newrun.floors) + 1) % floors.length]!;
  };

  const effectivePolicy = (repoRoot = l.repoRoot): Policy | undefined => {
    try { return loadPolicy(layout(repoRoot)); } catch { return undefined; }
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
    const skillModesKey = [...newRunSkillModes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(",");
    const includedFilesKey = [...newRunContextIncluded].filter((key) => key.startsWith("file:")).sort().join(",");
    const previewKey = `${newRunRepo}\0${refKey(newrun.issue)}\0${newrun.agent}\0${newrun.verification}\0${newrun.worktree ? "wt" : "main"}\0${skillModesKey}\0${includedFilesKey}`;
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
          files: [...newRunContextIncluded]
            .filter((key) => key.startsWith("file:"))
            .map((key) => key.slice("file:".length)),
          defaultSkills: defaultSkillsFor({ agent: newrun.agent, verification: newrun.verification }),
          skillPresets: roleSkillPresets(newrun.agent),
          skillOverrides: Object.fromEntries(newRunSkillModes),
        }),
        policy: effectivePolicy(newRunRepo),
        machine,
        catalogue: loadCatalogue(newRunLayout.catalogueFile),
        configured: new Set(statuses.filter((status) => status.configured).map((status) => status.id)),
        availability: loadAvailability(l.home),
      };
    }
    const base = newRunPreviewCache;
    const previewIssue = issueByRef(newrun.issue);
    const previewPrompt =
      newrun.prompt.trim() ||
      (previewIssue ? issuePrompt(previewIssue, newrun.agent) : "");
    const context: ContextPreview = { ...base.context, promptChars: previewPrompt.length };
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
        verification: newrun.verification === "redundant" ? "verified" : newrun.verification,
        worktree: newrun.worktree,
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
    if (newrun.prompt.trim().length === 0 && !newrun.issue) {
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
    if (
      !planningAgent &&
      newrun.agent !== "general" &&
      selectedIssue &&
      selectedIssue.kind !== "feature" &&
      issueAccess !== "create"
    ) {
      notify(`${newrun.agent} attaches to a Feature. Choose a Feature or an agent with issue creation access.`);
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
      "--worktree", newrun.worktree ? "true" : "false",
      "--approval", newrun.approval,
      "--ambiguity", newrun.ambiguity,
      ...(newRunParentId ? ["--parent", newRunParentId] : []),
    ];
    const previewPolicy = policy?.agents[newrun.agent];
    if (modelState.model && previewPolicy) {
      const budget = contextBudget(modelState.model.context, previewPolicy.expectedOutputTokens);
      args.push("--context-budget", String(budget.inputChars));
    }
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
      if (!planningAgent && issueAccess === "create" && selectedIssue && selectedIssue.kind !== "feature") args.push("--auto-issue");
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
    const includedReferences = [...newRunContextIncluded]
      .filter((key) => key.startsWith("reference:"))
      .map((key) => key.slice("reference:".length));
    if (includedKnowledge.length > 0 || includedReferences.length > 0) {
      args.push("--context-include", JSON.stringify({
        ...(includedKnowledge.length > 0 ? { knowledge: includedKnowledge } : {}),
        ...(includedReferences.length > 0 ? { references: includedReferences } : {}),
      }));
    }
    if (newRunSkillModes.size > 0) {
      args.push("--skill-modes", JSON.stringify(Object.fromEntries(newRunSkillModes)));
    }
    if (newrun.prompt.trim().length > 0) args.push(newrun.prompt);
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
      // The 1s background tick is too coarse for run handoff. Repaint fast
      // until the record resolves so the run-details screen opens promptly.
      if (pendingFastTimer) clearInterval(pendingFastTimer);
      pendingFastTimer = setInterval(() => {
        if (pendingRunAt === 0) {
          if (pendingFastTimer) clearInterval(pendingFastTimer);
          pendingFastTimer = null;
          return;
        }
        if (Date.now() - pendingRunAt > 15_000) {
          if (pendingFastTimer) clearInterval(pendingFastTimer);
          pendingFastTimer = null;
          return;
        }
        draw();
      }, 250);
    }
  };

  const pendingForRun = (run: RunSummary | undefined) => {
    if (!run) return null;
    const detail = findRunDetail(run.id);
    if (!detail) return null;
    return latestUnansweredQuestion(
      detail.events.filter((event) => event.type === "question") as Array<{
        questionId?: string;
        text?: string;
        options?: string[];
      }>,
      readInbox(detail.dir),
    );
  };

  const answerRun = (run: RunRow | RunSummary | undefined) => {
    const summary = "run" in (run ?? {}) ? (run as RunRow & { run: RunSummary }).run : (run as RunSummary | undefined);
    if (!summary) return;
    const detail = findRunDetail(summary.id);
    if (!detail) { notify("run record not found"); return; }
    const pending = pendingForRun(summary);
    if (!pending?.questionId) { notify("no pending question"); return; }
    selectedRunId = detail.summary.id;
    answerQuestionId = pending.questionId;
    answerOptions = pending.options ?? [];
    answerText = "";
    answerScroll = 0;
    screen = "answer";
  };

  const interrupt = (summary: RunSummary | undefined) => {
    if (!summary) return;
    const active = ["created", "running", "awaiting_input", "paused", "interrupted"];
    if (!active.includes(summary.status)) { notify(`run is ${summary.status}; nothing to stop`); return; }
    const action = summary.status === "running" ? "interrupt" : "cancel";
    const dir = join(summary.repoRoot, ".machine_code", "local", "runs", summary.id);
    let seq = 1;
    try {
      const ack = JSON.parse(readFileSync(join(dir, "control.ack"), "utf8")) as { seq?: number };
      if (typeof ack.seq === "number") seq = ack.seq + 1;
    } catch { /* no ack */ }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "control"), JSON.stringify({ seq, action, from: process.pid }) + "\n", "utf8");
      notify(action === "cancel" ? "cancel requested" : "interrupt requested");
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
    const feature = issue?.kind === "feature"
      ? issue
      : issueByRef(run?.issue);
    if (feature && !run) { notify(`no run to approve for #${feature.ref.number}`); return; }
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const args = feature
      ? ["feature", "approve", String(feature.ref.number)]
      : ["approve", String(run?.prNumber && run.prState === "open" ? run.prNumber : issue?.ref.number ?? "")];
    if (args[1] === "approve" && !args[2]) { notify("nothing to approve"); return; }
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: feature ? (issueRepoOf(feature.ref) ?? repoRoot) : repoRoot,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    notify(feature ? `feature approval queued for #${feature.ref.number}` : `approval requested for ${args[2]}`);
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
      (page === "runs" && (screen === "list" || screen === "issue" || screen === "run" || screen === "pipeline"));
    const allRuns = needRunData ? listAllRuns(l.home).filter((run) => !deletingRuns.has(run.id)) : [];
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
    const orchStates = needRunData ? listOrchestrations(l) : [];
    const activeOrchestrations = orchStates.filter((state) => {
      const lease = readLease(l, state.id);
      return Boolean(lease && lease.until > Date.now());
    }).length;
    // Orchestration in-progress by scope: active means no stopReason. Rebuilt
    // once per frame so issue rows stay cheap.
    const orchActiveRefs = new Set<string>();
    for (const state of orchStates) {
      if (state.stopReason || !state.scopeRef) continue;
      orchActiveRefs.add(refKey(state.scopeRef));
    };
    const runIndicators = [
      `${C}●${R} ${counts.active} running`,
      `${Y}?${R} ${counts.awaiting} awaiting`,
      `${Y}⏸${R} ${counts.paused} paused`,
      ...(activeOrchestrations > 0 ? [`${G}●${R} ${activeOrchestrations} orchestration`] : []),
    ];
    const statusTokens = [`${Y}PR${R} ${counts.openPrs} open`];

    let catalogue: CatalogueDocument | null = null;
    let statuses: ReturnType<typeof providerStatuses> = [];
    if (page === "models") {
      try {
        const mtime = statSync(l.catalogueFile).mtimeMs;
        if (!catalogueCache || catalogueCache.mtime !== mtime) {
          catalogueCache = { mtime, doc: loadCatalogue(l.catalogueFile) };
        }
        catalogue = catalogueCache.doc;
      } catch {
        catalogue = loadCatalogue(l.catalogueFile);
      }
      if (!statusesCache || Date.now() - statusesCache.at > 5_000) {
        statusesCache = { at: Date.now(), statuses: providerStatuses(createModelsCollection()) };
      }
      statuses = statusesCache.statuses;
    }
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
      (page === "runs" && (screen === "newrun" || screen === "answer" || screen === "correct" || screen === "pipeline")) ||
      (page === "models" && screen === "model");
    // Tabs stay visible on every other screen. Runs and models replace the
    // blank separator with a live summary line; other pages keep the blank.
    const backTitle =
      page === "runs" && screen === "newrun"
        ? `  ${B}${theme.headerFg}New Run${R}`
        : runDetailHeader
          ? `  ${B}${theme.headerFg}Run Details${R}`
          : page === "runs" && screen === "pipeline"
            ? `  ${B}${theme.headerFg}Orchestration${R}`
            : page === "models" && screen === "model"
              ? `  ${B}${theme.headerFg}Model Details${R}`
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
      ? [backLine, backSubLine]
      : [...wrapTokenList(tabTokens, cols, " "), ...headerSubLines];
    // The header shares the body surface; only the Back label keeps its own tone.
    const headerTone = theme.bodyBg;
    // Prompt editing moves its controls into the body but keeps the model line.
    const hideFooter = screen === "newrun" && newRunInsert;
    const bodyH = Math.max(1, rows - header.length - footerReserve);

    const scopeRuns = runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
    const filteredRuns = runsListScreen ? scopeRuns : [];
    const runIndex = buildRunIndex({
      runs: filteredRuns,
      issuesByRepo: runsListScreen ? issueCachesByRepo : new Map(),
      group: runsGroup,
      collapsed,
      text: runsText,
      attentionOnly: runsAttention,
      preferredRepo: l.repoRoot,
    });
    if (runsSel >= runIndex.selectable.length) runsSel = Math.max(0, runIndex.selectable.length - 1);
    const selectedRow = runIndex.selectable[runsSel];
    const focus = focusRowIds(runIndex.rows, selectedRow);

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
          const orchMark = orchActiveRefs.has(refKey(row.issue.ref)) ? `${C}◌${R} ` : "";
          const left = `${indent}${row.collapsible ? (row.collapsed ? "▸" : "▾") : " "} ${orchMark}${issueIcon(row.issue)} ${BL}#${row.issue.ref.number}${R} ${D}${row.issue.kind}${R} ${B}${W}${row.issue.title}${R}`;
          const parts: string[] = [];
          if (detail !== "identity") {
            if (roll.pct !== undefined) {
              const width = detail === "full" ? 6 : 4;
              parts.push(`${progress(roll.pct, width)} ${String(roll.pct).padStart(3)}%`);
            }
            if ((detail === "full" || detail === "medium") && roll.tasksTotal > 0) {
              parts.push(`${D}${roll.tasksClosed}/${roll.tasksTotal} features${R}`);
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
        if (focus && !focus.has(row.id) && (row.kind === "issue" || row.kind === "run")) {
          for (let i = 0; i < rendered.length; i++) rendered[i] = dim(rendered[i]!);
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
      const selectedListRow = runIndex.selectable[runsSel];
      const selectedPending =
        selectedListRow?.kind === "run" && selectedListRow.run.status === "awaiting_input"
          ? pendingForRun(selectedListRow.run)
          : null;
      const answerAction = selectedPending ? [command("a", "Answer", undefined, Y)] : [];
      actions = narrow
        ? joinCommands([
            command("n", "New", undefined, C),
            command("p", "Orchestrate", undefined, Y),
            command("Enter", "Open", undefined, G),
            ...answerAction,
            command("space", "Fold", undefined, Y),
            command("j/k", "Move", undefined, M),
            command("/", "Search", undefined, BL),
          ])
        : joinCommands([
            command("n", "New run", undefined, C),
            command("p", "Orchestrate", undefined, Y),
            command("Enter", "Open", undefined, G),
            ...answerAction,
            command("space", "Fold", undefined, Y),
            command("j/k", "Move", undefined, M),
            command("/", "Search", undefined, BL),
          ]);
      extraActions = joinCommands([
        command("g", "Group", RUN_GROUP_LABELS[runsGroup], C),
        command("f", "Repos", runsRepoScope === "all" ? "all" : "cwd", M),
        command("D", "Delete", undefined, RED),
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
      lines.push(` ${issueIcon(issue)} ${BL}#${issue.ref.number}${R} ${B}${W}${issue.title}${R} ${D}${issue.kind} · ${issue.state}${R}`);
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
      // Approve does real work: task approve merges the PR, records
      // acceptance, and closes/cleans up; otherwise it approves the open PR.
      const approveRun = issueRuns[Math.min(issueRunSel, Math.max(0, issueRuns.length - 1))];
      const approveFeature = issue.kind === "feature" ? issue : issueByRef(approveRun?.issue);
      const approveLabel =
        approveFeature && approveRun
          ? `Finish #${approveFeature.ref.number}`
          : approveRun?.prNumber && approveRun.prState === "open"
            ? `Merge PR#${approveRun.prNumber}`
            : "Approve";
      actions = joinCommands([
        command("n", "New run", undefined, C),
        command("Enter", "Open", undefined, G),
        command("j/k", "Select", undefined, M),
        command("p", approveLabel, undefined, Y),
        command("P", "Orchestrate", undefined, C),
        command("D", "Delete", undefined, RED),
        command("o", "Open URL", undefined, BL),
        command("Esc", "Back", undefined, GR),
      ]);
      secondary = `${D}${issue.kind} #${issue.ref.number} · ${issueRuns.length} run(s) · ${preview.chars.toLocaleString()} context chars${toast ? ` · ${Y}${toast}${R}` : ""}${R}`;
    }

    /* ----------------------------------------------------------- delete */
    else if (screen === "delete") {
      if (deleteRunTarget) {
        const run = deleteRunTarget;
        const lines = [
          "",
          ` ${RED}${B}Delete run ${run.id}${R}`,
          "",
          ` ${D}Status:${R} ${run.status}   ${D}Agent:${R} ${run.agent}${run.mode ? `/${run.mode}` : ""}`,
          ` ${D}Request:${R} ${run.request.replace(/\s+/g, " ").slice(0, 100)}`,
          "",
          ...(isActiveStatus(run.status)
            ? [` ${Y}This run is active. It will be cancelled and stopped first.${R}`, ""]
            : []),
          ` ${D}This permanently deletes:${R}`,
          `   ${Y}•${R} the run record, events, transcript, and reports`,
          `   ${Y}•${R} its worktree when no other run shares it`,
          `   ${Y}•${R} its branch when no other run shares it and no open PR owns it`,
          "",
          ` ${RED}This cannot be undone.${R}`,
        ];
        body = clipBody(lines);
        actions = joinCommands([
          command("D", "Confirm delete", undefined, RED),
          command("Esc", "Cancel", undefined, GR),
        ]);
        secondary = `${D}run ${run.id}${R}`;
      } else {
        const target = deleteTarget;
        if (!target) {
          screen = deleteReturn;
          return draw();
        }
        const descendants = descendantCount(target);
        const targetRuns = allRuns.filter((run) => refKey(run.taskIssue ?? run.issue) === refKey(target.ref));
        const worktrees = new Set(targetRuns.map((run) => run.worktree).filter(Boolean));
        const lines = [
          "",
          ` ${RED}${B}Delete #${target.ref.number}${R} ${W}${target.title}${R}`,
          "",
          ` ${D}This permanently deletes the issue and its associated resources:${R}`,
          `   ${Y}•${R} close open PR(s)`,
          `   ${Y}•${R} remove ${worktrees.size} worktree(s)`,
          `   ${Y}•${R} delete local and remote ${target.kind === "feature" ? "Feature" : "scope"} branches`,
          `   ${Y}•${R} delete ${targetRuns.length} associated run record(s)`,
          `   ${Y}•${R} delete the issue${descendants > 0 ? ` and ${descendants} descendant issue(s)` : ""}`,
          "",
          ` ${D}${targetRuns.length} associated run(s) · ${descendants} descendant issue(s)${R}`,
          "",
          ` ${RED}This cannot be undone.${R}`,
        ];
        body = clipBody(lines);
        actions = joinCommands([
          command("D", "Confirm delete", undefined, RED),
          command("Esc", "Cancel", undefined, GR),
        ]);
        secondary = `${D}#${target.ref.number} ${target.kind}${R}`;
      }
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
          verification: newrun.verification === "redundant" ? "verified" : newrun.verification,
          worktree: newrun.worktree,
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
        if (issueObj.kind === "feature") {
          return "runs attach here";
        }
        if (planningAgent) return "planning attaches to the epic";
        if (issueAccess === "create") {
          return "will auto-create a Feature";
        }
        return "choose a Feature or an agent with issue creation access";
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
      const cachedMap = readCachedMap(newRunRepo);
      const fileItems: ContextPanelItem[] = itemsFor(["file"]);
      const knownFiles = new Set(fileItems.map((item) => item.key));
      for (const file of cachedMap?.files ?? []) {
        const key = `file:${file.path}`;
        if (knownFiles.has(key)) continue;
        fileItems.push({
          text: `${file.path} · available`,
          chars: file.bytes,
          exists: true,
          key,
          available: true,
          counted: false,
        });
      }
      const knowledgeItems: ContextPanelItem[] = itemsFor(["knowledge"]);
      // Attached references first (issue-cited), then every store bundle as
      // an available row the user can search and opt into with space.
      const referenceItems: ContextPanelItem[] = itemsFor(["reference"]);
      const attachedCitations = new Set(ctx.artifacts.references);
      const attachedPaths = new Set(
        ctx.sources
          .filter((source) => source.kind === "reference")
          .map((source) => source.ref.split("#")[0]),
      );
      for (const entry of listReferenceEntries(newRunLayout)) {
        if (attachedCitations.has(entry.citation)) continue;
        const rel = entry.path.split("#")[0];
        if (attachedPaths.has(rel) || attachedPaths.has(entry.citation)) continue;
        referenceItems.push({
          text: `${entry.citation} · available`,
          chars: Math.min(entry.bytes, 8 * 1024),
          exists: entry.exists,
          key: `reference:${entry.citation}`,
          available: true,
          counted: false,
        });
      }
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
      const skillDefaults = defaultSkillsFor({ agent: newrun.agent, verification: newrun.verification });
      const skillPresets = roleSkillPresets(newrun.agent);
      const skillOverrides = Object.fromEntries(newRunSkillModes);
      const skillModeOf = (name: string): SkillMode => {
        if (newRunContextExcluded.has(`skill:${name}`)) return "exclude";
        return resolveSkillMode(name, {
          presets: skillPresets,
          defaults: skillDefaults,
          declared: ctx.artifacts.skills,
          overrides: skillOverrides,
        });
      };
      const skillItems: ContextPanelItem[] = aggregateSkill
        ? skillListItems(skillMetas(newRunLayout), aggregateSkill.chars)
        : [];
      const bodyChars = new Map<string, number>();
      for (const source of skillSources) {
        if (source === aggregateSkill) continue;
        bodyChars.set(source.ref, (bodyChars.get(source.ref) ?? 0) + source.chars);
      }
      // Three modes per skill: include (description + body, marked ✓ body),
      // on-demand (description only, pulled with the skill tool), exclude (✕).
      // Space cycles include → on-demand → exclude. Active modes sort first.
      newRunSkillShown.clear();
      for (const item of skillItems) {
        const name = item.key.slice("skill:".length);
        const mode = skillModeOf(name);
        newRunSkillShown.set(name, mode);
        if (mode === "include") {
          item.chars += bodyChars.get(name) ?? 0;
          item.text += " · body";
        } else if (mode === "on-demand") {
          item.text += " · on-demand";
        }
        bodyChars.delete(name);
      }
      for (const [name, chars] of bodyChars) {
        const mode = skillModeOf(name);
        newRunSkillShown.set(name, mode);
        if (mode === "exclude") continue;
        skillItems.push({
          text: mode === "include" ? `${name} · body` : `${name} · on-demand`,
          chars: mode === "include" ? chars : 0,
          exists: true,
          key: `skill:${name}`,
        });
      }
      // Defaults the agent wants but no SKILL.md provides: visible as missing
      // instead of silently absent.
      const knownSkillNames = new Set(skillItems.map((item) => item.key.slice("skill:".length)));
      for (const name of skillDefaults) {
        if (knownSkillNames.has(name)) continue;
        knownSkillNames.add(name);
        newRunSkillShown.set(name, skillModeOf(name));
        skillItems.push({ text: `${name} · default · missing`, chars: 0, exists: false, key: `skill:${name}` });
      }
      const SKILL_MODE_RANK: Record<SkillMode, number> = { include: 0, "on-demand": 1, exclude: 2 };
      skillItems.sort((a, b) => {
        // Missing bodies always sink below installed skills of any mode.
        const aRank = a.exists ? SKILL_MODE_RANK[newRunSkillShown.get(a.key.slice("skill:".length)) ?? "on-demand"] : 3;
        const bRank = b.exists ? SKILL_MODE_RANK[newRunSkillShown.get(b.key.slice("skill:".length)) ?? "on-demand"] : 3;
        return aRank - bRank;
      });
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
        if (newrun.floors === "off") return "off";
        return newrun.floors;
      })();
      const minimumsText = trunc(
        `${D}${command("f", "fit", fitText, C)}  ${command("F", "floors", floorsText, M)}${R}`,
        Math.max(10, cols - 1),
      );
      const minimumsInfo = ` ${" ".repeat(Math.max(0, cols - visible(minimumsText) - 1))}${minimumsText}`;
      const issueSources = ctx.sources.filter((source) => source.kind === "issue");
      const issueItems: ContextPanelItem[] = [];
      for (let index = 0; index < issueChain.length; index++) {
        const issue = issueChain[index]!;
        const source = issueSources[index];
        const contextKind = index === 0 ? "feature" : "epic";
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
      const semantic = loadSemanticOrDeterministic(newRunRepo);
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
              ? `semantic index · ${Object.values(semantic.modules).filter((entry) => !entry.file).length} modules${semanticDirty.length ? ` · ${semanticDirty.length} dirty` : ""}`
              : "semantic index · builds when available"
            : "semantic index · disabled",
          chars: semanticChars,
          exists: semanticEnabled && Boolean(semantic),
          key: "semantic:index",
        },
      ];
      // The resolved agent prompt is context too: every line the run will
      // send, listed read-only. Fixed rows are always in context and cannot
      // be switched off, mirroring the core-tool rows.
      const promptItems: ContextPanelItem[] = resolvedAgent.prompt
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => ({
          text: line,
          chars: line.length,
          exists: true,
          key: `prompt:${index}`,
          fixed: true,
          counted: false,
        }));
      const sections = [
        { label: "Issues", tone: Y, sectionKey: "section:issues", items: issueItems },
        { label: "Files", tone: C, sectionKey: "section:files", items: fileItems },
        { label: "Knowledge", tone: contextTone("knowledge"), sectionKey: "section:knowledge", items: knowledgeItems },
        { label: "References", tone: contextTone("reference"), sectionKey: "section:references", items: referenceItems },
        { label: "Skills", tone: contextTone("skill"), sectionKey: "section:skills", items: skillItems },
        { label: "Tools", tone: contextTone("tool"), sectionKey: "section:tools", items: toolItems },
        { label: "Scripts", tone: contextTone("script"), sectionKey: "section:scripts", items: scriptItems },
        { label: "Plans", tone: contextTone("plan"), sectionKey: "section:plans", items: itemsFor(["plan", "project"]) },
        { label: "Codebase", tone: BL, sectionKey: "section:codebase", items: codebaseItems },
        { label: "Prompt", tone: W, sectionKey: "section:prompt", items: promptItems },
      ];
      if (newRunContextTab >= sections.length) newRunContextTab = 0;
      const isIncludedAvailable = (item: unknown): boolean => {
        const row = item as ContextPanelItem;
        return (
          row.available === true &&
          (row.key.startsWith("file:") || row.key.startsWith("knowledge:") || row.key.startsWith("reference:")) &&
          newRunContextIncluded.has(row.key)
        );
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
      const previewPolicy = preview.policy?.agents[newrun.agent];
      const modelChars = preview.model && previewPolicy
        ? contextBudget(preview.model.context, previewPolicy.expectedOutputTokens).inputChars
        : undefined;
      const usedChars = contextTokens * 4;
      const contextWarning = modelChars === undefined
        ? ""
        : usedChars >= modelChars
          ? ` ${RED}over model input budget${R}`
          : usedChars >= modelChars * 0.8
            ? ` ${Y}${Math.round((usedChars / modelChars) * 100)}% of model input budget${R}`
            : "";
      footerCtx = `${C}ctx${R} ${W}${(contextTokens / 1000).toFixed(1)}K${R}${contextWarning}`;
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
      // `/` narrows the active tab by substring; attached rows stay sorted
      // first by construction (references/skills), so filtering keeps them.
      const contextFilter = newRunContextFilter.trim().toLowerCase();
      const shownItems = contextFilter
        ? activeSection.items.filter((item) => item.text.toLowerCase().includes(contextFilter))
        : activeSection.items;
      newRunContextItemKeys = shownItems.map((item) => item.key);
      newRunContextItemAvailable = shownItems.map(
        (item) => (item as { available?: boolean }).available === true,
      );
      newRunContextItem = Math.min(newRunContextItem, Math.max(0, shownItems.length - 1));
      const sectionOff = newRunContextExcluded.has(activeSection.sectionKey);
      const availableItems = shownItems.filter((item) => isShownAvailable(item));
      const contextItems = shownItems.filter((item) => !isShownAvailable(item));
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
        Math.min(newRunContextItem - Math.floor(itemRoom / 2), Math.max(0, shownItems.length - itemRoom)),
      );
      const visibleItems = shownItems.slice(itemStart, itemStart + itemRoom);
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
      const remainingItems = shownItems.length - (itemStart + visibleItems.length);
      if (remainingItems > 0) itemLines.push(panelLine(`  ${D}… ${remainingItems} more${R}`));
      if (newRunContextFiltering || newRunContextFilter) {
        itemLines.push(panelLine(`  ${D}filter: ${newRunContextFilter || "(type)"}${newRunContextFiltering ? "▌" : ""}${R}`));
      }
      const compact = (key: string, label: string, tone: string): string =>
        `${B}${tone}${key}${R} ${D}${label}${R}`;
      const contextCommands = panelLine(
        joinCommands([
          compact("h/l", "tabs", Y),
          compact("j/k", "sel", M),
          compact("/", "filter", BL),
          activeSection.sectionKey === "section:skills"
            ? `${B}${G}space${R} ${D}include→on-demand→exclude${R}`
            : `${B}${G}space${R} ${G}✓${R}${D}/${R}${RED}✕${R}`,
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
      const promptText = newrun.prompt || (newRunInsert ? "" : newrun.issue ? "Press :! to run the selected task" : "Press p to type the task");
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
            newrun.prompt.trim() || newrun.issue ? commandBadge("Start", ":!", START_BG, WHITE) : "",
          ]);
      const promptControls = newRunInsert
        ? promptActions
        : joinCommands([
            command("a", "Agent", displayAgent, agentTone(newrun.agent)),
            ...(agentIsolates(newrun.agent)
              ? [
                  command("s", "Submode", newrun.verification === "verified" ? "Verify" : "Direct", C),
                  command("w", "Worktree", newrun.worktree ? "on" : "off", newrun.worktree ? G : D),
                ]
              : []),
            command("g", "Ambiguity", newrun.ambiguity, M),
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
          const line = ` ${chosen ? `${C}▸` : " "} ${status} ${C}${row.key}${R} ${D}fit ${entry.fit.toFixed(2)}${R}${modelPriceText(row)}${free}${reason}`;
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
          ` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Select model${R} ${D}(type to filter; Tab sorts ${modelPickSort === "price" ? "price" : "fit"}; Enter selects)${R}`,
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
          command("Tab", `Sort: ${modelPickSort}`, undefined, Y),
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
          const line = ` ${indent}${selectedIssue ? C + "▸" : " "} ${BL}#${issue.ref.number}${R} ${D}${issue.kind}${R} ${W}${issue.title}${R}`;
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
        // Agent, submode, ambiguity, tier, issue, and prompt controls live
        // beside the prompt or in the Issues panel; the bottom footer has no
        // command row.
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
        command("^D/^U", "Page", undefined, M),
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
      // Cursor stops on headers and rows alike: collapsing every group can
      // never strand the cursor, and space on a header reopens it.
      const stops: typeof modelDisplay = [];
      for (const group of groups) {
        stops.push({ kind: "header", key: group.key });
        if (!modelCollapsed.has(group.key)) {
          for (const row of group.rows) stops.push({ kind: "row", key: group.key, row });
        }
      }
      modelDisplay = stops;
      if (modelSel >= stops.length) modelSel = Math.max(0, stops.length - 1);
      const modelsAvail = loadAvailability(l.home);
      const now = Date.now();
      let selectedLine = 0;
      for (let s = 0; s < stops.length; s++) {
        const stop = stops[s]!;
        const isSelected = s === modelSel;
        if (isSelected) selectedLine = lines.length;
        if (stop.kind === "header") {
          const group = groups.find((candidate) => candidate.key === stop.key)!;
          const isCollapsed = modelCollapsed.has(group.key);
          const marker = isCollapsed ? "▸" : "▾";
          lines.push(
            selected(background(fit(` ${B}${theme.sectionFg}${marker} ${group.key}${R} ${D}(${group.rows.length})${R}`, cols), theme.sectionBg), isSelected),
          );
          continue;
        }
        const row = stop.row;
        {
          const free = row.free || (row.pricing.input === 0 && row.pricing.output === 0) ? ` ${G}free${R}` : "";
          const cooling = (() => {
            if (probingModels.has(row.key)) return ` ${C}…${R}`;
            const phase = modelsAvail.models[row.key];
            if (!phase?.cooldownUntil || phase.cooldownUntil <= now) return "";
            const minutes = Math.max(1, Math.ceil((phase.cooldownUntil - now) / 60_000));
            return ` ${Y}⏱${minutes >= 60 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`}${R}`;
          })();
          const axes = narrow ? "" : ` ${D}R${row.scores.reasoning.toFixed(1)} C${row.scores.code.toFixed(1)} A${row.scores.agentic.toFixed(1)} G${row.scores.general.toFixed(1)}${R}`;
          const left = `   ${row.coding === false ? `${GR}○${R}` : `${G}●${R}`} ${BL}${trunc(row.name, narrow ? 20 : 30)}${R}${free}${cooling}`;
          const right = `${D}${fmtContext(row.context)}${R} ${D}cap${R} ${row.scores.capability.toFixed(1)}${axes} ${Y}$${row.pricing.input}${R}/${Y}$${row.pricing.output}${R}`;
          lines.push(selected(` ${narrow ? trunc(left, Math.max(18, cols - 18)) + " " + right : pad(left, Math.max(26, cols - visible(right) - 2)) + right}`, isSelected));
        }
      }
      if (lines.length === 0) lines.push(` ${D}No matching models.${R}`);
      const w = selectableLines(lines, Math.min(selectedLine, Math.max(0, lines.length - 1)), modelScroll, bodyH);
      modelScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("Enter", "Details", undefined, G),
        command("space", "Fold", undefined, Y),
        command("/", "Search", undefined, BL),
        command("a", "Providers", modelsAll ? "all" : "configured", C),
        command("f", "Free", modelsFree ? "only" : "all", modelsFree ? G : GR),
        command("c", "Coding", modelsCoding ? "only" : "all", modelsCoding ? G : GR),
        command("g", "Group", modelGroup, BL),
        command("s", "Sort", modelSort, C),
        command("j/k", "Move", undefined, GR),
        command("^D/^U", "Page", undefined, GR),
      ]);
      secondary = `${D}space folds groups · Enter opens details${R}`;
    }

    /* ---------------------------------------------------------- pipeline */
    else if (page === "runs" && screen === "pipeline") {
      const scope = pipelineScope;
      const lines: string[] = [];
      if (!scope) {
        lines.push("", ` ${Y}Select an Epic or Feature in the Runs list, then press o.${R}`);
        body = clipBody(lines);
        actions = joinCommands([
          command("Esc", "Back", undefined, GR),
        ]);
        secondary = "no orchestration scope";
      } else {
        const scopedIssue = issueByRef(scope.ref);
        const scopeTitle = scopedIssue ? `#${scope.ref.number} ${scopedIssue.title}` : `#${scope.ref.number}`;
        // The scope can come from any repo in an all-repos view; schedule
        // from the scope's own issues and runs, not the TUI cwd.
        const scopeRepo = issueRepoOf(scope.ref) ?? l.repoRoot;
        const scopeLayout = scopeRepo === l.repoRoot ? l : layout(scopeRepo);
        const scopeIssues = issueCachesByRepo.get(scopeRepo) ?? [];
        const runs = allRuns.filter((run) => run.repoRoot === scopeRepo);
        const schedule = planSchedule({ issues: scopeIssues, scope: scope.kind, scopeRef: scope.ref, runs, maxParallel: orchMaxParallel });
        const tasks = schedule.tasks;
        const ready = tasks.filter((task) => task.ready).length;
        const blocked = tasks.length - ready;
        const minFitLabel = orchMinFit === undefined ? "auto" : String(orchMinFit);
        lines.push(
          ` ${B}${W}Orchestration${R} ${D}${scope.kind} ${scopeTitle}${R}  ` +
            `${G}${ready} ready${R}  ${Y}${blocked} blocked${R}`,
        );
        lines.push(` ${D}${scopeRepo}${R}`);
        lines.push(
          ` ${D}tier${R} ${tierTone(orchTier)}${orchTier}${R}` +
            ` ${D}minFit${R} ${W}${minFitLabel}${R}` +
            ` ${D}floors${R} ${W}${orchFloors}${R}` +
            ` ${D}processes${R} ${W}${orchMaxParallel}${R}` +
            ` ${D}checkpoint${R} ${W}${orchCheckpoint ? "after-task" : "off"}${R}` +
            ` ${D}model${R} ${C}${orchModel ?? "auto"}${R}` +
            `${orchMaxMinutes !== undefined ? ` ${D}maxMin${R} ${W}${orchMaxMinutes}${R}` : ""}` +
            `${orchMaxSpend !== undefined ? ` ${D}maxSpend${R} ${W}$${orchMaxSpend}${R}` : ""}`,
        );
        const states = listOrchestrations(scopeLayout);
        const ledger =
          states.find(
            (candidate) =>
              candidate.scopeRef &&
              (refKey(candidate.scopeRef) === refKey(scope.ref) ||
                (scopedIssue?.parent && refKey(candidate.scopeRef) === refKey(scopedIssue.parent))),
          ) ??
          states.find((candidate) => candidate.scope === "project");
        if (ledger) {
          const lease = readLease(scopeLayout, ledger.id);
          const running = Boolean(lease && lease.until > Date.now());
          const stopFile = orchestrationStopRequested(scopeLayout, ledger.id);
          lines.push(
            ` ${C}${ledger.id}${R}  ${D}${ledger.checkpoint ?? "preflight"}${R}  ` +
              `${running ? `${G}● RUNNING${R} ${D}${lease!.owner}${R}` : `${D}idle${R}`}  ` +
              `${D}packets ${ledger.approvedPackets?.length ?? 0} · results ${ledger.approvedResults?.length ?? 0}${R}` +
              `${stopFile ? `  ${Y}stop requested${R}` : ""}` +
              `${ledger.stopReason ? `  ${RED}${ledger.stopReason}${R}` : ""}`,
          );
        }
        if (scopeIssues.length === 0) {
          lines.push("", ` ${Y}No cached issues for ${scopeRepo}.${R} ${D}Press r to refresh.${R}`);
        } else if (tasks.length === 0) {
          lines.push("", ` ${D}No ready or blocked Features found under this ${scope.kind}.${R}`);
          lines.push(` ${D}The schedule ran over ${scopeIssues.length} cached issue(s) in ${scopeRepo}.${R}`);
          if (schedule.errors.length === 0) {
            lines.push(` ${D}Features appear once they have a ready plan and open blockers. Press r to refresh the cache.${R}`);
          }
        } else {
          // Rows are Features. featureStatus is async, so refresh it in the
          // background (throttled) and render from the cache with a
          // latest-run fallback in the meantime.
          const ordered = tasks;
          if (Date.now() - pipelineFeatureStatesAt > 5_000) {
            pipelineFeatureStatesAt = Date.now();
            const refreshLayout = scopeLayout;
            const refreshFeatures = ordered.map((task) => task.issue);
            void (async () => {
              try {
                const { featureStatus } = await import("./tasks/lifecycle.js");
                for (const feature of refreshFeatures) {
                  try {
                    pipelineFeatureStates.set(refKey(feature.ref), await featureStatus(refreshLayout, feature));
                  } catch {
                    // keep the cached or fallback status
                  }
                }
                draw();
              } catch {
                // lifecycle unavailable; the fallback below still renders
              }
            })();
          }
          const featureRunsOf = (ref: IssueRef): RunSummary[] =>
            allRuns
              .filter((run) => refKey(run.issue ?? run.taskIssue) === refKey(ref))
              .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
          const featureWord = (
            feature: Issue,
            runsDesc: readonly RunSummary[],
          ): { text: string; tone: string; dim: boolean } => {
            const cached = pipelineFeatureStates.get(refKey(feature.ref));
            const latest = runsDesc[0];
            const active =
              latest !== undefined &&
              (latest.status === "running" || latest.status === "awaiting_input" || latest.status === "created");
            const stage = cached?.stage;
            if (stage === "needs-human-review") return { text: "Needs Human Review", tone: Y, dim: false };
            if (active && (latest.agent === "review" || latest.phase === "review")) {
              return { text: "Reviewing", tone: M, dim: false };
            }
            if (active) return { text: "Building", tone: C, dim: false };
            if (stage === "reviewing") return { text: "Reviewing", tone: M, dim: false };
            if (stage === "building") return { text: "Building", tone: C, dim: false };
            if (stage === "blocked") return { text: "Blocked", tone: Y, dim: false };
            if (stage === "closed" || feature.state === "closed") return { text: "Closed", tone: D, dim: true };
            if (stage === "ready") return { text: "Ready", tone: D, dim: true };
            return { text: "Planning", tone: D, dim: true };
          };
          pipelineSel = Math.max(0, Math.min(pipelineSel, ordered.length - 1));
          pipelineTasks = ordered;
          // Full detail for the selected feature only; rows stay scannable.
          const sel = ordered[pipelineSel];
          if (sel) {
            const feature = sel.issue;
            const runsDesc = featureRunsOf(feature.ref);
            const word = featureWord(feature, runsDesc);
            const selLatest = runsDesc[0];
            const selBuild = runsDesc.find((run) => run.agent === "build" || run.phase === "build") ?? selLatest;
            const selPlan = sel.plan ? `${sel.plan.status}/${sel.plan.verification}` : "missing plan";
            const selModel = sel.ready ? orchModelForTask(feature.title.length, sel.plan?.verification) : "—";
            const branch = selBuild?.branch ?? selLatest?.branch ?? featureBranchFor(feature.ref.number, feature.title);
            const worktree = selBuild?.worktree ?? selLatest?.worktree ?? "none";
            lines.push("", ` ${B}${word.dim ? D : word.tone}${word.text}${R} ${D}#${feature.ref.number}${R} ${W}${trunc(feature.title, Math.max(16, cols - 24))}${R}`);
            lines.push(`   ${D}plan${R}  ${C}${selPlan}${R}`);
            lines.push(`   ${D}model${R} ${C}${trunc(selModel, 40)}${R}`);
            if (sel.reason) {
              for (const reasonLine of wrapText(sel.reason, Math.max(20, cols - 14)).slice(0, 3)) {
                lines.push(`   ${D}wait${R}  ${Y}${reasonLine}${R}`);
              }
            }
            lines.push(
              `   ${D}run${R}   ${selLatest ? `${icon(selLatest.status)} ${selLatest.id.slice(-8)} · ${selLatest.status} · ${selLatest.agent}` : "none"}` +
                `${selLatest?.prNumber ? `  ${D}PR${R} #${selLatest.prNumber} ${selLatest.prState ?? ""}` : ""}`,
            );
            lines.push(`   ${D}worktree${R} ${W}${trunc(worktree, Math.max(16, cols - 16))}${R}`);
            lines.push(`   ${D}branch${R}   ${W}${branch}${R}  ${D}approval${R} ${W}${feature.approval ?? "human"}${R}`);
            lines.push(`   ${D}review${R}    ${W}machine_code feature checkout ${feature.ref.number}${R}`);
            const next = selLatest?.status === "completed"
              ? `machine_code feature approve ${feature.ref.number}`
              : sel.plan?.status === "ready"
                ? `machine_code feature start ${feature.ref.number}`
                : `machine_code run --agent planner --issue ${feature.ref.number}`;
            lines.push(`   ${D}next${R}    ${next}`);
          }
          const rows: Array<{ line: string; task?: number }> = [];
          for (let taskIndex = 0; taskIndex < ordered.length; taskIndex++) {
            const task = ordered[taskIndex]!;
            const feature = task.issue;
            const runsDesc = featureRunsOf(feature.ref);
            const word = featureWord(feature, runsDesc);
            const wordText = `${word.dim ? D : word.tone}${word.text}${R}`;
            const latest = runsDesc[0];
            const build = runsDesc.find((run) => run.agent === "build" || run.phase === "build") ?? latest;
            const worktree = build?.worktree ?? latest?.worktree ?? "—";
            const branch = build?.branch ?? latest?.branch ?? featureBranchFor(feature.ref.number, feature.title);
            const approval = feature.approval ?? "human";
            rows.push({
              line: selected(
                `  ${pad(wordText, 18)} ${D}#${feature.ref.number}${R} ${W}${trunc(feature.title, Math.max(12, cols - 78))}${R}  ${D}${trunc(worktree, 28)}${R}  ${D}${branch}${R}  ${D}${approval}${R}`,
                taskIndex === pipelineSel,
              ),
              task: taskIndex,
            });
          }
          const selectedRow = rows.findIndex((row) => row.task === pipelineSel);
          const available = Math.max(1, bodyH - lines.length - 1);
          if (selectedRow < pipelineScroll) pipelineScroll = selectedRow;
          if (selectedRow >= pipelineScroll + available) pipelineScroll = selectedRow - available + 1;
          pipelineScroll = Math.max(0, Math.min(pipelineScroll, Math.max(0, rows.length - available)));
          lines.push(...rows.slice(pipelineScroll, pipelineScroll + available).map((row) => row.line));
        }
        {
          const dispatch = tasks.filter((task) => task.ready).map((task) => `#${task.issue.ref.number}`);
          if (dispatch.length > 0) lines.push("", ` ${D}dispatch ${R}${dispatch.join(", ")}`);
        }
        for (const error of schedule.errors) lines.push(` ${RED}${error}${R}`);
        body = clipBody(lines);
        actions = joinCommands([
          command(":!", "Tick", undefined, G),
          command("i", "Stop", undefined, RED),
          command("x", "Resume", undefined, G),
          command("w", "Worktree", undefined, C),
          command("Enter", "Open feature", undefined, G),
          command("Esc", "Back", undefined, GR),
        ]);
        extraActions = joinCommands([
          command("t", "Tier", orchTier, orchTier === "paid" ? Y : G),
          command("m", "MinFit", orchMinFit === undefined ? "auto" : String(orchMinFit), C),
          command("f", "Floors", orchFloors, M),
          command("P", "Processes", String(orchMaxParallel), C),
          command("c", "Checkpoint", orchCheckpoint ? "after-task" : "off", orchCheckpoint ? Y : GR),
          command("M", "Model", orchModel ?? "auto", BL),
          command("a", "Approve packet", undefined, Y),
          command("A", "Finish feature", undefined, Y),
          command("j/k", "Move", undefined, M),
          command("r", "Refresh", undefined, C),
        ]);
        secondary = `${D}${scope.kind} #${scope.ref.number}${R}`;
      }
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
        command("^D/^U", "Page", undefined, M),
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
        // What the run is currently waiting on. The 1s redraw tick animates
        // the dots, so a live wait visibly advances instead of looking frozen.
        const waiting = waitingForRun(s, ev, { hasPendingQuestion: Boolean(pending) });
        const waitingDots = ".".repeat(1 + (Math.floor(Date.now() / 500) % 3));
        const waitingLine = (): string | null => {
          if (!waiting) return null;
          const elapsed = ago(waiting.since);
          const age = elapsed === "—" ? "" : ` ${D}(${elapsed})${R}`;
          const label = trunc(waiting.label, Math.max(12, cols - 32));
          switch (waiting.kind) {
            case "input":
              return ` ${Y}?${R} ${B}awaiting your answer${R} ${D}press ${B}${Y}a${R}${D} to reply${R}`;
            case "paused":
              return ` ${Y}⏸${R} ${B}${waiting.label}${R}${age}`;
            case "model":
              return ` ${BL}◌${R} ${B}waiting on ${label}${R}${waiting.streaming ? ` ${G}streaming${R}` : ""}${C}${waitingDots}${R}${age}`;
            case "tool":
              return ` ${Y}◌${R} ${B}waiting on ${label}${R}${Y}${waitingDots}${R}${age}`;
            case "process":
              return ` ${C}◌${R} ${B}waiting on ${label}${R}${C}${waitingDots}${R}${age}`;
            case "child":
              return ` ${M}◌${R} ${B}waiting on ${label}${R}${M}${waitingDots}${R}${age}`;
            case "starting":
              return ` ${C}◌${R} ${B}starting${R}${C}${waitingDots}${R}${age}`;
            case "working":
              return ` ${C}◌${R} ${B}working${R}${C}${waitingDots}${R}${age}`;
          }
        };
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
          hint("P", "orchestrate", C),
          hint("D", "delete", RED),
          ...(pending ? [hint("a", "answer", Y)] : []),
          ...(["running", "awaiting_input", "paused"].includes(s.status)
            ? [hint("i", s.status === "running" ? "interrupt" : "cancel", RED)]
            : []),
          ...(runSection === "timeline"
            ? [
                hint("j/k", "events"),
                hint("space", "expand", G),
                hint("^D/^U", "scroll", Y),
                hint("F", `follow ${timelineFollow ? "ON" : "OFF"}`, Y),
                hint("v", timelineVerbose ? "all" : "key events"),
              ]
            : runSection === "processes"
              ? [
                  hint("j/k", "select"),
                  hint("^D/^U", "page", Y),
                  hint("F", "follow", Y),
                  hint("o", "log", G),
                  hint("x", "kill", RED),
                  hint("X", "kill all", RED),
                ]
              : runSection === "overview" || runSection === "changes" || runSection === "context"
                ? [hint("j/k", "scroll"), hint("^D/^U", "page", Y)]
                : runSection === "related"
                  ? [hint("j/k", "select"), hint("^D/^U", "page", Y)]
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
        const wl = waitingLine();
        if (wl) lines.push(wl);
        lines.push("", ...sectionBar, "");
        if (runSection === "overview") {
          // Lean overview: header already carries status/agent/cost. Show the
          // outcome plus one snippet per detail section (thinking, edits,
          // activity, changes) instead of duplicating their full bodies.
          if (s.error || s.status === "failed" || s.status === "blocked") {
            lines.push(` ${B}${statusColor(s.status)}Status${R}`);
            const statusText = s.error ?? s.status.toUpperCase();
            const statusTone = RED;
            for (const line of wrapText(statusText, cols - 4).slice(0, short ? 3 : 6)) {
              lines.push(`  ${statusTone}${line}${R}`);
            }
          }
          if (pending?.text) lines.push(` ${Y}? ASK${R} ${W}${trunc(pending.text, cols - 8)}${R}`);
          lines.push(` ${B}${G}Summary${R}`);
          for (const rawLine of outcomeText.split("\n")) {
            for (const line of wrapText(rawLine, cols - 4)) lines.push(`  ${W}${line}${R}`);
          }
          lines.push(` ${B}${BL}Request${R}`);
          for (const line of wrapText(s.request, cols - 4).slice(0, 3)) lines.push(`  ${W}${line}${R}`);
          const lastThinking = thinking.length > 0 ? thinking[thinking.length - 1] : undefined;
          if (lastThinking) {
            lines.push("", ` ${B}${Y}Thinking snippet${R} ${D}latest · full text in Thinking${R}`);
            for (const line of wrapText(lastThinking.text, cols - 4).slice(-3)) lines.push(`  ${D}${line}${R}`);
          }
          const snippetEdits = recentEditEvents(ev, 3);
          if (snippetEdits.length > 0) {
            lines.push("", ` ${B}${G}Edit snippet${R} ${D}latest ${snippetEdits.length} · full diffs in Thinking${R}`);
            for (const editEvent of snippetEdits) {
              const summary = editSummaryLines(editEvent, cols - 6);
              lines.push(`  ${G}✎${R} ${W}${trunc(summary[0] ?? "edit", Math.max(16, cols - 8))}${R}`);
            }
          }
          if (recentActivity.length) {
            const activityLive =
              waiting && waiting.kind !== "input" && waiting.kind !== "paused"
                ? ` ${C}◌ waiting on ${trunc(waiting.label, Math.max(12, cols - 48))}${waitingDots}${R}`
                : s.status === "running"
                  ? ` ${G}live${R}`
                  : "";
            lines.push("", ` ${B}${C}Activity snippet${R}${activityLive} ${D}full log in Timeline${R}`);
            for (const event of recentActivity.slice(-4)) {
              const time = String(event.t ?? "").slice(11, 19);
              lines.push(`  ${D}${time}${R} ${trunc(describeTimelineEvent(event), Math.max(12, cols - 12))}`);
            }
          }
          lines.push("", ` ${B}${G}Changes${R} ${touched.length ? `${G}${touched.length}${R} ${D}path(s)${R}` : `${D}none yet${R}`}` +
            (relatedList.length ? `  ${D}related${R}  ${M}${relatedList.length}${R}` : "") +
            `  ${D}parent${R}  ${s.parentRunId ? `${D}${s.parentRunId.slice(-8)}${R}` : `${D}none${R}`}`);
          if (context) {
            lines.push(`  ${D}context${R} ${C}${context.chars.toLocaleString()} chars / ${context.sources.length} sources${R}`);
          }
          const w = scrollLines(lines, runScroll, bodyH);
          runScroll = w.scroll;
          body = clipBody(w.lines);
        } else if (runSection === "timeline") {
          const eventLines: string[] = [];
          const starts: number[] = [];
          /** Visible events in render order, for zebra striping. */
          const visibleOrder: number[] = [];
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
            visibleOrder.push(i);
            const isSelected = i === eventSel;
            const prefix = isSelected ? `${C}▸${R}` : " ";
            const time = String(event.t ?? "").slice(11, 19);
            // Selection never expands: block heights stay stable while moving,
            // so the cursor does not jump. Space toggles expansion manually.
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
                while (inputLines.length > 0 && inputLines[inputLines.length - 1]!.trim() === "") inputLines.pop();
                // The head is the repeating system prompt; the tail is the
                // unique send for this call, so the preview shows the tail.
                const shown = expandedEvent ? inputLines : inputLines.slice(-4);
                if (!expandedEvent && inputLines.length > 4) {
                  eventLines.push(`    ${D}… ${inputLines.length - 4} head lines hidden (space to expand)${R}`);
                }
                for (const line of shown) {
                  for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
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
                const shown = expandedEvent ? outputLines : outputLines.slice(0, 4);
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
                const shown = expandedEvent ? reasoningLines : reasoningLines.slice(0, 4);
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
              const startArgs = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
              const human = describeToolArgs(String(event.tool ?? ""), startArgs ?? undefined);
              eventLines.push(`${prefix} ${GR}${time}${R} ${Y}⚡${R} ${B}${String(event.tool)}${R}${human ? ` ${D}${trunc(human, Math.max(12, cols - 24))}${R}` : ` ${D}calling…${R}`}`);
              if (expandedEvent && event.args) {
                const argsText = stripAnsi(JSON.stringify(event.args));
                for (const line of wrapText(argsText, cols - 6)) eventLines.push(`    ${D}${line}${R}`);
              }
            } else if (type === "tool_call") {
              const toolName = String(event.tool ?? "");
              const isEdit = toolName === "write" || toolName === "edit";
              const callArgs = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
              const human = describeToolArgs(toolName, callArgs);
              eventLines.push(`${prefix} ${GR}${time}${R} ${isEdit ? `${G}✎${R}` : `${Y}⚡${R}`} ${B}${toolName}${R} ${event.isError ? `${RED}ERR${R}` : `${G}ok${R}`}${typeof event.durationMs === "number" ? ` ${D}${event.durationMs}ms${R}` : ""}${human ? ` ${D}${trunc(human, Math.max(12, cols - 32))}${R}` : ""}`);
              if (expandedEvent && callArgs) {
                for (const line of wrapText(JSON.stringify(callArgs), cols - 6)) eventLines.push(`    ${D}${line}${R}`);
              }
              if (isEdit && !expandedEvent) {
                // The diff is the meat of an edit; the raw result ("ok") is not.
                for (const line of editSummaryLines(event, cols - 6, 5).slice(1)) {
                  const tone = line.startsWith("+") ? G : line.startsWith("-") ? RED : D;
                  eventLines.push(`    ${tone}${trunc(line, Math.max(16, cols - 8))}${R}`);
                }
              }
              const result = event.result;
              if (result !== undefined && (expandedEvent || !isEdit)) {
                const text = stripAnsi(typeof result === "string" ? result : JSON.stringify(result));
                if (expandedEvent) {
                  for (const line of text.split("\n")) {
                    for (const wrapped of wrapText(line, cols - 6)) eventLines.push(`    ${G}→${R} ${wrapped}`);
                  }
                } else {
                  const preview = text.split("\n").filter((line) => line.trim().length > 0).slice(0, 3);
                  for (const line of preview) eventLines.push(`    ${G}→${R} ${trunc(line, Math.max(20, cols - 8))}`);
                  if (text.split("\n").length > 3) eventLines.push(`    ${D}… (${text.split("\n").length - 3} more; space to expand)${R}`);
                }
              }
            } else if (type === "gates") {
              const results = Array.isArray(event.results) ? (event.results as Array<{ passed?: boolean; command?: string }>) : [];
              eventLines.push(`${prefix} ${GR}${time}${R} ${B}⊞ gates${R} ${event.passed ? `${G}PASS${R}` : `${RED}FAIL${R}`}`);
              if (!expandedEvent && !event.passed) {
                // A failing gate's command is the actionable part.
                for (const gate of results.filter((gate) => !gate.passed).slice(0, 2)) {
                  eventLines.push(`    ${RED}✗${R} ${trunc(String(gate.command ?? ""), Math.max(16, cols - 10))}`);
                }
              }
              if (expandedEvent && Array.isArray(event.results)) {
                for (const gate of results) eventLines.push(`    ${gate.passed ? `${G}✓` : `${RED}✗`}${R} ${gate.command}`);
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
            else if (type === "loop_blocked") {
              const reason =
                event.reason === "no-progress"
                  ? `no progress after ${String(event.noProgressCalls ?? "?")} research call(s)`
                  : event.reason === "next-required"
                    ? "no next action recorded"
                    : event.reason === "plan-required"
                      ? "no concrete build plan recorded"
                      : String(event.tool ?? "");
              eventLines.push(`${prefix} ${GR}${time}${R} ${RED}loop blocked${R} ${D}${reason}${R}`);
            }
            else if (type === "context_assembled") eventLines.push(`${prefix} ${GR}${time}${R} ${BL}context${R} ${D}${fmtTokens(Number(event.chars ?? 0))} chars${R}`);
            else eventLines.push(`${prefix} ${GR}${time}${R} ${D}${type}${R}`);
          }
          eventSel = Math.max(0, Math.min(ev.length - 1, eventSel));
          while (eventSel < ev.length - 1 && !isTimelineEvent(ev[eventSel], timelineVerbose)) eventSel += 1;
          while (eventSel > 0 && !isTimelineEvent(ev[eventSel], timelineVerbose)) eventSel -= 1;
          // Full-width stripes and selection. Padding must sit INSIDE the
          // tone wrap: the frame paints body background over everything past
          // the wrap's final reset, so unwrapped padding would punch
          // body-colored holes at every line end.
          for (let order = 0; order < visibleOrder.length; order++) {
            const evIdx = visibleOrder[order]!;
            const nextIdx = visibleOrder[order + 1];
            const blockStart = starts[evIdx] ?? 0;
            const blockEnd = nextIdx !== undefined ? (starts[nextIdx] ?? eventLines.length) : eventLines.length;
            if (evIdx === eventSel) {
              if (blockStart < blockEnd) {
                eventLines[blockStart] = selected(fit(eventLines[blockStart]!, cols), true);
              }
              continue;
            }
            if (order % 2 === 0) continue;
            for (let line = blockStart; line < blockEnd; line++) {
              eventLines[line] = background(fit(eventLines[line]!, cols), ZEBRA_BG);
            }
          }
          const timeWait =
            waiting && timelineFollow && waiting.kind !== "input" && waiting.kind !== "paused" ? waitingLine() : null;
          const visibleCount = Math.max(1, bodyH - 4 - (timeWait ? 1 : 0));
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
            // ^D/^U move the line offset inside the block.
            const maxBodyScroll = Math.max(0, end - start - visibleCount);
            eventBodyScroll = Math.max(0, Math.min(eventBodyScroll, maxBodyScroll));
            eventScroll = start + eventBodyScroll;
          }
          eventScroll = Math.max(0, Math.min(eventScroll, Math.max(0, eventLines.length - visibleCount)));
          lines.push(...eventLines.slice(eventScroll, eventScroll + visibleCount));
          if (timeWait) lines.push(timeWait);
          body = clipBody(lines);
        } else if (runSection === "thinking") {
          // Human-readable output: assistant text interleaved with edit/write
          // calls rendered as -/+ diff snippets (not raw JSON). Timeline keeps
          // the full details; this section stays skimmable.
          const thinkingLines: string[] = [];
          type ThinkingEntry =
            | { at: string; kind: "thinking" | "text"; call?: number; complete: boolean; text: string }
            | { at: string; kind: "edit"; event: RunEvent };
          const entries: ThinkingEntry[] = [];
          for (const chunk of thinking) {
            entries.push({ at: chunk.at, kind: chunk.kind, call: chunk.call, complete: chunk.complete, text: chunk.text });
          }
          for (const event of ev) {
            if (event.type !== "tool_call" || !isEditToolEvent(event)) continue;
            entries.push({ at: String(event.t ?? ""), kind: "edit", event });
          }
          entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
          for (const entry of entries) {
            if (entry.kind === "edit") {
              const summary = editSummaryLines(entry.event, cols - 6);
              const failed = Boolean((entry.event as { isError?: unknown }).isError);
              thinkingLines.push(
                ` ${GR}${String(entry.at).slice(11, 19)}${R} ${G}✎ edit${R}${failed ? ` ${RED}ERR${R}` : ""} ${W}${trunc(summary[0] ?? "edit", Math.max(16, cols - 24))}${R}`,
              );
              for (const line of summary.slice(1)) {
                const tone = line.startsWith("+") ? G : line.startsWith("-") ? RED : D;
                thinkingLines.push(`   ${tone}${trunc(line, Math.max(16, cols - 8))}${R}`);
              }
              thinkingLines.push("");
              continue;
            }
            const label = entry.kind === "thinking" ? `${M}thinking${R}` : `${C}response${R}`;
            const live = entry.complete ? "" : `${Y} live${R}`;
            thinkingLines.push(` ${GR}${String(entry.at).slice(11, 19)}${R} ${D}call ${entry.call ?? "?"}${R} ${label}${live}`);
            for (const line of wrapText(entry.text, Math.max(20, cols - 6))) thinkingLines.push(` ${entry.kind === "thinking" ? D : W}${line}${R}`);
            thinkingLines.push("");
          }
          if (thinkingLines.length === 0) thinkingLines.push(` ${D}No assistant text recorded yet.${R}`);
          // In follow mode the eye is on the bottom line, so pin the wait
          // there too — the header copy covers the top of the viewport.
          const thinkWait =
            waiting && thinkingFollow && waiting.kind !== "input" && waiting.kind !== "paused" ? waitingLine() : null;
          const viewport = bodyH - lines.length - (thinkWait ? 1 : 0);
          if (thinkingFollow) thinkingScroll = Math.max(0, thinkingLines.length - viewport);
          thinkingScroll = Math.max(0, Math.min(thinkingScroll, Math.max(0, thinkingLines.length - viewport)));
          lines.push(...thinkingLines.slice(thinkingScroll, thinkingScroll + viewport));
          if (thinkWait) lines.push(thinkWait);
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
            for (const warning of context.warnings) lines.push(`  ${Y}warning${R} ${W}${warning}${R}`);
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
            detail.events.filter((event) => event.type === "question") as Array<{
              questionId?: string;
              text?: string;
              options?: string[];
            }>,
            readInbox(detail.dir),
          )
        : null;
      const options = answerOptions.length > 0 ? answerOptions : pending?.options ?? [];
      const width = Math.max(20, cols - 8);
      const question = pending?.text ?? "(question text not recorded)";
      const questionLines = wrapText(question, width);
      const top: string[] = [];
      questionLines.forEach((line, index) => {
        top.push(index === 0 ? ` ${Y}?${R} ${W}${line}${R}` : `   ${W}${line}${R}`);
      });
      top.push("");
      if (options.length > 0) {
        top.push(` ${B}${C}Options${R}`);
        for (let i = 0; i < options.length && i < 9; i++) {
          const optionLines = wrapText(options[i]!, width - 4);
          optionLines.forEach((line, index) => {
            top.push(index === 0
              ? ` ${B}${M}${i + 1}${R} ${W}${line}${R}`
              : `   ${W}${line}${R}`);
          });
        }
        top.push("");
      }
      // Give the question/options as much room as possible. Shrink the answer
      // box before hiding question lines.
      const inputLinesFor = (height: number) => 3 + height;
      let boxHeight = Math.max(1, Math.min(8, bodyH - 6));
      let availableTop = Math.max(1, bodyH - inputLinesFor(boxHeight));
      if (top.length > availableTop) {
        const needed = bodyH - top.length - 3;
        boxHeight = Math.max(1, Math.min(boxHeight, needed));
        availableTop = Math.max(1, bodyH - inputLinesFor(boxHeight));
      }
      const wrapped = wrapText(answerText || "(type the answer, then press Enter)", width - 2);
      const inputLines = [
        ` ${B}${C}Answer${R}`,
        ` ${D}┌${"─".repeat(width)}┐${R}`,
        ...Array.from({ length: boxHeight }, (_, i) =>
          ` ${D}│${R} ${W}${fit(wrapped[i] ?? "", width - 2)}${R} ${D}│${R}`),
        ` ${D}└${"─".repeat(width)}┘${R}`,
      ];
      const view = scrollLines(top, answerScroll, availableTop);
      answerScroll = view.scroll;
      answerPage = Math.max(1, availableTop - 1);
      answerOverflow = top.length > availableTop;
      body = clipBody([...view.lines, ...inputLines]);
      actions = joinCommands([
        ...(options.length > 0 ? [command("1-9", "Choose", undefined, M)] : []),
        ...(answerOverflow ? [command("^D/^U", "Scroll", undefined, M)] : []),
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
    const previousIssue = issueByRef(newrun.issue);
    const previousPrompt = issuePrompt(previousIssue, newrun.agent);
    const hadIssue = Boolean(newrun.issue);
    newrun.issue = issue.ref;
    // A blank composer that was opened with `N` still starts as general. Once
    // a Feature is attached, default to the agent that does the work.
    if (!hadIssue && newrun.agent === "general") {
      newrun.agent = issue.kind === "feature" ? "build" : "planner";
      newrun.verification = agentIsolates(newrun.agent) ? "verified" : "direct";
      newrun.worktree = newrun.agent !== "sudo";
    }
    if (!newrun.prompt.trim() || newrun.prompt === previousPrompt) {
      newrun.prompt = issuePrompt(issue, newrun.agent);
    }
    issuePick = null;
    const planningAgent = newrun.agent === "planner" || newrun.agent === "review";
    let outcome: string;
    if (issue.kind === "feature") {
      outcome = "runs attach here";
    } else if (planningAgent) {
      outcome = "planning attaches to the epic";
    } else if (newRunIssueAccess() === "create") {
      outcome = "a child Feature will be created";
    } else {
      outcome = "choose a Feature or an agent with issue creation access";
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
    const contextChars = (newRunPreviewCache?.context.chars ?? 0) + newrun.prompt.length + 2_000;
    const input = {
      agent: newrun.agent,
      policy: ap,
      machine,
      catalogue: rows,
      configuredProviders: configured,
      fundedProviders: funded,
      contextChars,
      tier: newrun.tier,
      availability,
    };
    const estimate = estimateTokens(contextChars, ap.expectedOutputTokens);
    const priceOf = (row: CatalogueRow): number =>
      effectiveCallCost(row, estimate.inputTokens, estimate.outputTokens, machine);
    const sortMode = modelPickSort;
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
        if (sortMode === "price") {
          const cost = priceOf(a.row) - priceOf(b.row);
          if (cost !== 0) return cost;
          return b.fit - a.fit || a.row.key.localeCompare(b.row.key);
        }
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

  /* --------------------------------------- orchestration screen helpers */

  /** Cached catalogue/policy/machine for the per-task model preview. */
  const orchPreviewBase = (): {
    catalogue: CatalogueDocument | null;
    policy: Policy | undefined;
    machine: MachineConfig | undefined;
    configured: Set<string>;
    availability: AvailabilityState;
  } => {
    const key = `${orchTier}\0${orchMinFit ?? ""}\0${orchFloors}\0${orchModel ?? ""}`;
    if (!orchPreviewCache || orchPreviewCache.key !== key || Date.now() - orchPreviewCache.at > 5_000) {
      const repoLayout = layout(l.repoRoot);
      const statuses = providerStatuses(createModelsCollection());
      const machine = (() => {
        try { return loadMachineConfig(repoLayout); } catch { return undefined; }
      })();
      orchPreviewCache = {
        key,
        at: Date.now(),
        catalogue: loadCatalogue(repoLayout.catalogueFile),
        policy: effectivePolicy(l.repoRoot),
        machine,
        configured: new Set(statuses.filter((status) => status.configured).map((status) => status.id)),
        availability: loadAvailability(l.home),
      };
    }
    return orchPreviewCache;
  };

  /** Model the build agent would select for a task under current orch settings. */
  const orchModelForTask = (titleChars: number, planVerification?: string): string => {
    const base = orchPreviewBase();
    if (!base.policy || !base.machine || !base.catalogue) return "—";
    const ap = base.policy.agents.build;
    if (!ap) return "—";
    const effective = { ...ap, minAxes: { ...(ap.minAxes ?? {}) } };
    if (orchMinFit !== undefined) effective.minFit = orchMinFit;
    if (orchFloors === "off") {
      effective.minFit = 0;
      for (const axis of CAPABILITY_AXES) effective.minAxes[axis] = 0;
    }
    if (orchFloors === "strict") {
      for (const axis of CAPABILITY_AXES) {
        const current = effective.minAxes[axis] ?? ap.minFit;
        effective.minAxes[axis] = Math.min(10, Math.round((current + 0.5) * 10) / 10);
      }
    }
    const machine = { ...base.machine, selection: { ...base.machine.selection, tier: orchTier } };
    const result = pick({
      agent: "build",
      policy: effective,
      machine,
      catalogue: base.catalogue.models,
      configuredProviders: base.configured,
      availability: base.availability,
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: 16_000 + titleChars * 4,
      tier: orchTier,
      ...(orchModel ? { requireModel: orchModel } : {}),
    });
    if ("error" in result) return "—";
    return result.selected.key;
  };

  /* ------------------------------------------------------------- input */

  const handleKey = (data: string) => {
    if (data === "\x03") {
      cleanup();
      process.exit(0);
    }

    // Text-entry modes take precedence over global navigation.
    if (screen === "delete") {
      if (data === "\x1b") { deleteTarget = undefined; deleteRunTarget = undefined; screen = deleteReturn; draw(); return; }
      if (data === "D" && deleteRunTarget) {
        const run = deleteRunTarget;
        deletingRuns.add(run.id);
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        const child = spawn(
          process.execPath,
          [cliPath, "runs", "delete", run.id, "--yes"],
          {
            cwd: l.repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("close", (code) => {
          const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
          try {
            writeFileSync(join(l.localDir, "delete.log"), `${new Date().toISOString()} run ${run.id}\n${output}\n`, "utf8");
          } catch {
            // best-effort diagnostics
          }
          if (code === 0) {
            notify(`deleted run ${run.id}`);
          } else {
            deletingRuns.delete(run.id);
            const last = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
            notify(`delete failed for run ${run.id}: ${trunc(last, 80)}`);
          }
          draw();
        });
        notify(`deleting run ${run.id}`);
        deleteRunTarget = undefined;
        selectedRunId = null;
        screen = "list";
        page = "runs";
        draw();
        return;
      }
      if (data === "D") {
        const target = deleteTarget;
        if (!target) { screen = deleteReturn; draw(); return; }
        deleteInFlight = true;
        const deleteRefs = [target.ref, ...descendantRefs(target)];
        addTombstones(l, deleteRefs);
        for (const ref of deleteRefs) deletingIssues.add(refKey(ref));
        const cache = readIssueCache(l);
        if (cache) {
          const next = cache.issues.filter((issue) => !deletingIssues.has(refKey(issue.ref)));
          writeIssueCache(l, cache.repo, next);
          issueCachesByRepo.set(l.repoRoot, next);
        }
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        const child = spawn(
          process.execPath,
          [cliPath, "issue", "delete", String(target.ref.number), "--cascade", "--yes"],
          {
            cwd: l.repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("close", (code) => {
          const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
          try {
            writeFileSync(join(l.localDir, "delete.log"), `${new Date().toISOString()} #${target.ref.number}\n${output}\n`, "utf8");
          } catch {
            // best-effort diagnostics
          }
          deleteInFlight = false;
          if (code === 0) {
            notify(`deleted #${target.ref.number}`);
          } else {
            deletingIssues.clear();
            removeTombstones(l, deleteRefs);
            const last = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
            notify(`delete failed for #${target.ref.number}: ${trunc(last, 80)}`);
          }
          void refreshIssues("current").then(() => draw());
        });
        notify(`deleting #${target.ref.number} and associated resources`);
        deleteTarget = undefined;
        selectedIssueKey = null;
        screen = "list";
        page = "runs";
        draw();
        return;
      }
      draw();
      return;
    }

    if (screen === "answer") {
      if (data === "\x1b") { screen = "run"; answerText = ""; answerOptions = []; answerScroll = 0; draw(); return; }
      if (data === CTRL_U) { answerScroll = Math.max(0, answerScroll - Math.max(1, Math.floor(answerPage / 2))); draw(); return; }
      if (data === CTRL_D) { answerScroll += Math.max(1, Math.floor(answerPage / 2)); draw(); return; }
      if (/^[1-9]$/.test(data) && answerOptions.length > 0 && answerText.length === 0) {
        const option = answerOptions[Number(data) - 1];
        if (option) { answerText = option; draw(); return; }
      }
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
        answerOptions = [];
        answerScroll = 0;
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
        if (data === "\t") {
          modelPickSort = modelPickSort === "price" ? "fit" : "price";
          modelPickEntries = pickerModels();
          modelPickSel = 0;
          draw();
          return;
        }
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
      if (newRunContextFiltering) {
        if (data === "\x1b") { newRunContextFiltering = false; newRunContextFilter = ""; newRunContextItem = 0; draw(); return; }
        if (data === "\r" || data === "\n") { newRunContextFiltering = false; newRunContextItem = 0; draw(); return; }
        if (data === "\x7f" || data === "\b") { newRunContextFilter = newRunContextFilter.slice(0, -1); newRunContextItem = 0; draw(); return; }
        if (!data.startsWith("\x1b")) { newRunContextFilter += printable(data); newRunContextItem = 0; draw(); return; }
        draw();
        return;
      }
      if (data === "/") { newRunContextFiltering = true; draw(); return; }
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
      if (data === CTRL_U) { newRunContextItem = Math.max(0, newRunContextItem - 5); draw(); return; }
      if (data === CTRL_D) { newRunContextItem += 5; draw(); return; }
      if (data === " ") {
        const key = newRunContextItemKeys[newRunContextItem];
        const available = newRunContextItemAvailable[newRunContextItem] === true;
        if (key && key.startsWith("skill:")) {
          // Three modes cycle: include (body inlined) → on-demand
          // (description only, pulled with the skill tool) → exclude.
          const name = key.slice("skill:".length);
          const current = newRunSkillShown.get(name) ?? "on-demand";
          const next: SkillMode = current === "include" ? "on-demand" : current === "on-demand" ? "exclude" : "include";
          newRunSkillModes.set(name, next);
          if (next === "exclude") newRunContextExcluded.add(key);
          else newRunContextExcluded.delete(key);
        } else if (key && available) {
          if (key.startsWith("file:") || key.startsWith("knowledge:") || key.startsWith("reference:")) {
            if (newRunContextIncluded.has(key)) newRunContextIncluded.delete(key);
            else {
              newRunContextIncluded.add(key);
              newRunContextExcluded.delete(key);
            }
          }
        } else if (key && !key.startsWith("core-tool:") && !key.startsWith("prompt:")) {
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
      if (data === "s") {
        if (!agentIsolates(newrun.agent)) { notify("submode is build/sudo-only"); draw(); return; }
        cycleSubmode(); draw(); return;
      }
      if (data === "w") {
        if (!agentIsolates(newrun.agent)) { notify("worktree is build/sudo-only"); draw(); return; }
        newrun.worktree = !newrun.worktree; draw(); return;
      }
      if (data === "g") { cycleAmbiguity(); draw(); return; }
      if (data === "f") { cycleMinFit(); draw(); return; }
      if (data === "F") { cycleFloors(); draw(); return; }
      if (data === "i" && newRunContextSectionKey === "section:issues") { startIssuePicker(); draw(); return; }
      if (data === "m") { startModelPicker(); draw(); return; }
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
      const allRuns = listAllRuns(l.home).filter((run) => !deletingRuns.has(run.id));
      issueCachesByRepo = collectIssueCaches(allRuns);
      const scopeFiltered = runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
      const index = buildRunIndex({
        runs: scopeFiltered,
        issuesByRepo: issueCachesByRepo,
        group: runsGroup,
        collapsed,
        text: runsText,
        attentionOnly: runsAttention,
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
      if (data === "a") {
        const row = index.selectable[runsSel];
        if (row?.kind !== "run") { notify("select a run to answer"); draw(); return; }
        answerRun(row.run);
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
        startNewRun(issue, repoForRow(row), row?.kind === "issue" ? row.issue : undefined);
        draw();
        return;
      }
      if (data === "N") { startNewRun(undefined, l.repoRoot); draw(); return; }
      if (data === "p" || data === "D") {
        const row = index.selectable[runsSel];
        if (data === "D" && row?.kind === "run") {
          deleteRunTarget = row.run;
          deleteTarget = undefined;
          deleteReturn = "list";
          screen = "delete";
          draw();
          return;
        }
        const issue = row?.kind === "issue"
          ? row.issue
          : row?.kind === "run"
            ? issueByRef(row.run.issue)
            : undefined;
        if (!issue) { notify("select an Epic or Feature first"); draw(); return; }
        if (data === "D") {
          deleteTarget = issue;
          deleteRunTarget = undefined;
          deleteReturn = "list";
          screen = "delete";
          draw();
          return;
        }
        pipelineScope = { kind: issue.kind, ref: issue.ref };
        pipelineSel = 0;
        pipelineScroll = 0;
        screen = "pipeline";
        draw();
        return;
      }
      if (data === "o") {
        const row = index.selectable[runsSel];
        const issue = row?.kind === "issue"
          ? row.issue
          : row?.kind === "run"
            ? issueByRef(row.run.issue)
            : undefined;
        if (!issue || (issue.kind !== "epic" && issue.kind !== "feature")) {
          notify("select an Epic or Feature first");
          draw();
          return;
        }
        pipelineScope = { kind: issue.kind, ref: issue.ref };
        pipelineSel = 0;
        pipelineScroll = 0;
        pipelineColon = false;
        screen = "pipeline";
        draw();
        return;
      }
      if (data === "!") { runsAttention = !runsAttention; runsSel = 0; draw(); return; }
      if (data === "g") {
        runsGroup = RUN_GROUPS[(RUN_GROUPS.indexOf(runsGroup) + 1) % RUN_GROUPS.length]!;
        runsSel = 0;
        runsScroll = 0;
        draw();
        return;
      }
      if (data === "f") {
        runsRepoScope = runsRepoScope === "all" ? "cwd" : "all";
        runsSel = 0;
        runsScroll = 0;
        notify(runsRepoScope === "cwd" ? "showing cwd runs only" : "showing runs from all repos");
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
      if (data === "n") { startNewRun(issue.ref, issueRoot, issue); draw(); return; }
      if (data === "p") { approveSelected(issue, issueRuns[issueRunSel] ?? issueRuns[0], issueRoot); draw(); return; }
      if (data === "P") {
        pipelineScope = { kind: issue.kind, ref: issue.ref };
        pipelineSel = 0;
        pipelineScroll = 0;
        screen = "pipeline";
        draw();
        return;
      }
      if (data === "D") {
        deleteTarget = issue;
        deleteReturn = "issue";
        screen = "delete";
        draw();
        return;
      }
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
      if (data === CTRL_D || data === CTRL_U) {
        const direction = data === CTRL_D ? 1 : -1;
        if (runSection === "timeline") {
          timelineFollow = false;
          eventBodyScroll = Math.max(0, eventBodyScroll + direction * HALF_PAGE);
        } else if (runSection === "thinking") {
          thinkingFollow = false;
          thinkingScroll = Math.max(0, thinkingScroll + direction * HALF_PAGE);
        } else if (runSection === "processes") {
          processFollow = false;
          processSel = Math.max(0, processSel + direction * 5);
        } else if (runSection === "related") {
          childSel = Math.max(0, childSel + direction * 5);
        } else {
          runScroll = Math.max(0, runScroll + direction * HALF_PAGE);
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
      if (data === "P") {
        const issue = issueByRef(detail.summary.issue);
        if (issue) {
          pipelineScope = { kind: issue.kind, ref: issue.ref };
          pipelineSel = 0;
          pipelineScroll = 0;
          screen = "pipeline";
          draw();
          return;
        }
      }
      if (data === "D") {
        deleteRunTarget = detail.summary;
        deleteTarget = undefined;
        deleteReturn = "run";
        screen = "delete";
        draw();
        return;
      }
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
      if (data === CTRL_U) { modelScroll = Math.max(0, modelScroll - HALF_PAGE); draw(); return; }
      if (data === CTRL_D) { modelScroll += HALF_PAGE; draw(); return; }
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
        modelSel = Math.min(Math.max(0, modelDisplay.length - 1), modelSel + 1);
        draw();
        return;
      }
      if (data === CTRL_U) { modelSel = Math.max(0, modelSel - HALF_PAGE); draw(); return; }
      if (data === CTRL_D) {
        modelSel = Math.min(Math.max(0, modelDisplay.length - 1), modelSel + HALF_PAGE);
        draw();
        return;
      }
      if (data === " ") {
        const stop = modelDisplay[modelSel];
        if (stop) {
          const key = stop.key;
          if (modelCollapsed.has(key)) modelCollapsed.delete(key);
          else {
            modelCollapsed.add(key);
            // Collapsing from a row would strand the cursor; land on the header.
            if (stop.kind === "row") {
              const headerIndex = modelDisplay.findIndex((candidate) => candidate.kind === "header" && candidate.key === key);
              if (headerIndex >= 0) modelSel = headerIndex;
            }
          }
        }
        draw();
        return;
      }
      if (data === "\r" || data === "\n") {
        const stop = modelDisplay[modelSel];
        if (stop?.kind === "header") {
          if (modelCollapsed.has(stop.key)) modelCollapsed.delete(stop.key);
          else modelCollapsed.add(stop.key);
        } else if (stop) { selectedModelKey = stop.row.key; modelScroll = 0; screen = "model"; }
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
        modelCollapsed.clear();
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
      if (data === CTRL_U) { spendScroll = Math.max(0, spendScroll - HALF_PAGE); draw(); return; }
      if (data === CTRL_D) { spendScroll += HALF_PAGE; draw(); return; }
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

    /* ---------------------------------------------- orchestration keys */
    if (page === "runs" && screen === "pipeline") {
      if (data === "\x1b[A" || data === "k") { pipelineSel = Math.max(0, pipelineSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { pipelineSel++; draw(); return; }
      if (data === ":") { pipelineColon = true; draw(); return; }
      if (pipelineColon && data !== "!") pipelineColon = false;
      if (data === "r") { void refreshIssues("all"); draw(); return; }
      if (data === "t") { orchTier = orchTier === "paid" ? "free" : "paid"; orchPreviewCache = null; draw(); return; }
      if (data === "m") {
        const values: Array<number | undefined> = [undefined, 6, 6.5, 7, 7.5, 8, 0];
        orchMinFit = values[(values.findIndex((value) => value === orchMinFit) + 1) % values.length];
        orchPreviewCache = null;
        draw();
        return;
      }
      if (data === "f") {
        const values: Array<"role" | "strict" | "off"> = ["role", "strict", "off"];
        orchFloors = values[(values.indexOf(orchFloors) + 1) % values.length]!;
        orchPreviewCache = null;
        draw();
        return;
      }
      if (data === "P") {
        const values = [1, 2, 4, 8];
        orchMaxParallel = values[(values.indexOf(orchMaxParallel) + 1) % values.length] ?? 2;
        draw();
        return;
      }
      if (data === "c") { orchCheckpoint = !orchCheckpoint; draw(); return; }
      if (data === "M") {
        // Pin the model previewed for the selected feature, or release the pin.
        const task = pipelineTasks[pipelineSel];
        if (task) {
          const model = orchModelForTask(task.issue.title.length, task.plan?.verification);
          orchModel = orchModel && model === orchModel ? undefined : (model === "—" ? orchModel : model);
          orchPreviewCache = null;
          notify(orchModel ? `model pinned ${orchModel}` : "model auto");
        }
        draw();
        return;
      }
      // The scope may live in another repo; resolve its layout and issues.
      const scopeCtx = (): { repo: string; layout: Layout } => {
        const repo = (pipelineScope && issueRepoOf(pipelineScope.ref)) ?? l.repoRoot;
        return { repo, layout: repo === l.repoRoot ? l : layout(repo) };
      };
      const selected = () => {
        const task = pipelineTasks[pipelineSel];
        return task ? { issue: task.issue, plan: task.plan } : undefined;
      };
      const scopeLedger = () => {
        const scope = pipelineScope;
        if (!scope) return undefined;
        const states = listOrchestrations(scopeCtx().layout);
        return states.find(
          (candidate) =>
            candidate.scope === scope.kind &&
            candidate.scopeRef &&
            refKey(candidate.scopeRef) === refKey(scope.ref),
        );
      };
      if (data === "s") {
        const state = scopeLedger();
        if (!state) { notify("no orchestration to stop"); draw(); return; }
        const ctx = scopeCtx();
        const lease = readLease(ctx.layout, state.id);
        if (!lease || lease.until <= Date.now()) { notify(`${state.id} is not running`); draw(); return; }
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        const child = spawn(process.execPath, [cliPath, "orchestrate", "stop", "--orchestration", state.id], {
          cwd: ctx.repo,
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.unref();
        notify(`stop requested for ${state.id}`);
        draw();
        return;
      }
      if (data === "i") {
        const state = scopeLedger();
        if (!state) { notify("no orchestration to stop"); draw(); return; }
        const ctx = scopeCtx();
        requestOrchestrationStop(ctx.layout, state.id);
        notify(`stop requested for ${state.id}`);
        draw();
        return;
      }
      if (data === "x" || (data === "!" && pipelineColon)) {
        const tick = data === "!";
        pipelineColon = false;
        const scope = pipelineScope;
        if (!scope) { notify("no orchestration scope"); draw(); return; }
        const ctx = scopeCtx();
        let stoppedReason: string | undefined;
        {
          const state = listOrchestrations(ctx.layout).find(
            (candidate) =>
              candidate.scope === scope.kind &&
              candidate.scopeRef &&
              refKey(candidate.scopeRef) === refKey(scope.ref),
          );
          const lease = state ? readLease(ctx.layout, state.id) : undefined;
          if (state && lease && lease.until > Date.now() && !tick) {
            notify(`already running ${state.id} (${lease.owner}, pid ${lease.pid})`);
            draw();
            return;
          }
          // A stopped orchestration refuses to tick until resumed. x means go,
          // so resume it in place and keep its approvals and checkpoints.
          stoppedReason = state && (!lease || lease.until <= Date.now()) ? state.stopReason : undefined;
        }
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        const args = [
          "orchestrate",
          tick ? "tick" : "start",
          "--scope",
          scope.kind,
          scope.kind === "epic" ? "--epic" : "--feature",
          String(scope.ref.number),
          ...(stoppedReason ? ["--resume"] : []),
          "--tier", orchTier,
          ...(orchMinFit !== undefined ? ["--min-fit", String(orchMinFit)] : []),
          ...(orchFloors === "off"
            ? ["--min-axes", "reasoning=0,code=0,agentic=0,general=0"]
            : orchFloors === "strict"
              ? ["--min-axes", "strict"]
              : []),
          "--max-parallel", String(orchMaxParallel),
          ...(orchMaxMinutes !== undefined ? ["--max-minutes", String(orchMaxMinutes)] : []),
          ...(orchMaxSpend !== undefined ? ["--max-spend-usd", String(orchMaxSpend)] : []),
          ...(orchCheckpoint ? ["--checkpoint", "after-task"] : []),
          ...(orchModel ? ["--model", orchModel] : []),
        ];
        const child = spawn(process.execPath, [cliPath, ...args], {
          cwd: scopeCtx().repo,
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.unref();
        notify(
          stoppedReason
            ? `resumed ${scope.kind} #${scope.ref.number} (was stopped: ${stoppedReason.slice(0, 100)})`
            : tick
              ? `ticked ${scope.kind} #${scope.ref.number}`
              : `started ${scope.kind} #${scope.ref.number}`,
        );
        draw();
        return;
      }
      if (data === "a" || data === "A") {
        const task = selected();
        const scope = pipelineScope;
        const ctx = scopeCtx();
        const states = listOrchestrations(ctx.layout);
        const state = states.find(
          (candidate) =>
            scope &&
            candidate.scopeRef &&
            (refKey(candidate.scopeRef) === refKey(scope.ref) ||
              (task?.issue.parent && refKey(candidate.scopeRef) === refKey(task.issue.parent))),
        ) ?? states.find((candidate) => candidate.scope === "project");
        if (!task) notify("no feature selected");
        else if (data === "A") {
          const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
          const child = spawn(process.execPath, [cliPath, "feature", "approve", String(task.issue.ref.number)], {
            cwd: scopeCtx().repo,
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          notify(`feature approval queued for #${task.issue.ref.number} (merge, close, cleanup)`);
        } else if (!state) notify("no orchestration state");
        else {
          const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
          const args = ["orchestrate", "approve", "--orchestration", state.id, "--feature", String(task.issue.ref.number)];
          const child = spawn(process.execPath, [cliPath, ...args], {
            cwd: scopeCtx().repo,
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          notify(`packet approval for #${task.issue.ref.number}`);
        }
        draw();
        return;
      }
      if (data === "w") {
        const checkoutTask = selected();
        if (!checkoutTask) { notify("no feature selected"); draw(); return; }
        const checkoutCli = fileURLToPath(new URL("./cli.js", import.meta.url));
        const checkoutOut = spawnSync(
          process.execPath,
          [checkoutCli, "feature", "checkout", String(checkoutTask.issue.ref.number)],
          { cwd: scopeCtx().repo, encoding: "utf8", timeout: 60_000 },
        );
        const checkoutText = `${checkoutOut.stdout ?? ""}${checkoutOut.stderr ?? ""}`.trim();
        notify(checkoutOut.status === 0 ? checkoutText.split("\n").slice(0, 3).join(" · ") : `checkout failed: ${checkoutText.slice(0, 200)}`);
        draw();
        return;
      }
      if (data === "\r" || data === "\n") {
        const task = selected()?.issue ?? (pipelineScope ? issueByRef(pipelineScope.ref) : undefined);
        if (task) {
          selectedIssueKey = refKey(task.ref);
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
      if (data === CTRL_U) { settingsSel = Math.max(0, settingsSel - HALF_PAGE); draw(); return; }
      if (data === CTRL_D) { settingsSel += HALF_PAGE; draw(); return; }
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
    if (!deleteInFlight && Date.now() - issueRefreshAt > 30_000) void refreshIssues();
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

function axisFloorText(axes: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined): string {
  return CAPABILITY_AXES.map((axis) => `${axis[0]!.toUpperCase()}${(axes?.[axis] ?? 0).toFixed(1)}`).join(" ");
}

