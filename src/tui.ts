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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout, type Layout } from "./paths.js";
import { listAllRuns, listProjects, readRun, type RunEvent, type RunSummary } from "./state/runs.js";
import { appendInbox, latestUnansweredQuestion, readInbox } from "./state/question.js";
import { readIssueCache, writeIssueCache } from "./issues/cache.js";
import type { Issue, IssueRef } from "./issues/provider.js";
import { filterRuns, headerCounts, sortRuns, type RunFilter } from "./tui/status.js";
import {
  RUN_GROUPS,
  RUN_GROUP_LABELS,
  buildRunIndex,
  repoLabel,
  repoOf,
  type RunGroup,
  type RunRow,
} from "./tui/runs.js";
import { selectableLines } from "./tui/scroll.js";
import { buildSettings, settingsFileFor, type SettingRow } from "./tui/settings.js";
import { loadMachineConfig, loadPolicy, CAPABILITY_AXES, SELECTION_TIERS, DEFAULT_THEME, type MachineConfig, type Policy, type ThemeConfig } from "./config.js";
import { axisWeights, pick } from "./select.js";
import { readSpendSummary, spendBar, spendDays } from "./spend.js";
import { loadAvailability } from "./availability.js";
import { AGENT_META, AGENT_NAMES, agentDef } from "./agents.js";
import { createModelsCollection, providerStatuses } from "./models.js";
import { fundedProviderIds } from "./data.js";
import { loadCatalogue } from "./catalogue/load.js";
import { filterModels, groupModels, siblingOffers, type ModelSort } from "./catalogue/query.js";
import type { CatalogueRow } from "./catalogue/types.js";
import { previewContext, artifactPreview, type ContextPreview } from "./context/preview.js";
import { changesFor, childRuns, readContextManifest, thinkingChunks, touchedPaths, type ChangeSummary, type ThinkingChunk } from "./report/run.js";
import { listArtifacts, type ArtifactDef } from "./artifacts/registry.js";

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
const G = "\x1b[32m";
const Y = "\x1b[33m";
const RED = "\x1b[31m";
const M = "\x1b[35m";
const BL = "\x1b[34m";
const GR = "\x1b[90m";
const W = "\x1b[37m";
const BG = "\x1b[48;5;236m";
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

type Page = "runs" | "models" | "spend" | "settings";
type Screen = "list" | "issue" | "run" | "newrun" | "answer" | "correct" | "model" | "help";
type RunSection = "overview" | "timeline" | "thinking" | "changes" | "children" | "context";
type RunListFilter = RunFilter | "attention";

const TABS: Array<{ id: Page; label: string; key: string }> = [
  { id: "runs", label: "Runs", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "spend", label: "Spend", key: "3" },
  { id: "settings", label: "Settings", key: "4" },
];
const PAGE_IDS = new Set<Page>(TABS.map((tab) => tab.id));
const RUN_SECTIONS: RunSection[] = ["overview", "timeline", "thinking", "changes", "children", "context"];
const RUN_SECTION_LABEL: Record<RunSection, string> = {
  overview: "Overview",
  timeline: "Timeline",
  thinking: "Thinking",
  changes: "Changes",
  children: "Children",
  context: "Context",
};
const NEW_RUN_AGENTS = [...AGENT_NAMES];
const NEW_RUN_SETTING_FIELDS = [
  "mode",
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

interface NewRunState {
  agent: string;
  mode: string;
  preset: string;
  verification: "direct" | "verified" | "redundant";
  issues: "required" | "optional" | "disabled";
  ask: boolean;
  approval: "human" | "agent";
  ambiguity: "strict" | "precise" | "adaptive" | "autonomous";
  tier: "free" | "paid";
  /** undefined = use the role policy; null = explicit zero. */
  minFit: number | null | undefined;
  floors: "role" | "strict" | "off";
  issue?: IssueRef;
  prompt: string;
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

function healthIcon(health: string): string {
  switch (health) {
    case "done": return `${G}✓${R}`;
    case "attention": return `${RED}✗${R}`;
    case "blocked": return `${Y}⊘${R}`;
    case "awaiting-human": return `${Y}?${R}`;
    case "paused": return `${Y}⏸${R}`;
    case "review": return `${M}◎${R}`;
    case "stalled": return `${GR}◌${R}`;
    default: return `${G}●${R}`;
  }
}

function healthColor(health: string): string {
  if (health === "done") return G;
  if (health === "attention") return RED;
  if (["blocked", "awaiting-human", "paused", "review", "stalled"].includes(health)) return Y;
  return C;
}

function statusColor(status: string): string {
  if (status === "running") return C;
  if (status === "completed" || status === "done") return G;
  if (["awaiting_input", "paused", "blocked", "interrupted"].includes(status)) return Y;
  if (status === "failed") return RED;
  return GR;
}

function progress(value: number | undefined, width: number): string {
  if (value === undefined) return `${D}${"·".repeat(Math.max(1, width))}${R}`;
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return `${G}${"█".repeat(filled)}${D}${"░".repeat(Math.max(0, width - filled))}${R}`;
}

/**
 * One footer command: `Label[key]: Value`.
 * Label and key share a tone so adjacent commands stay visually distinct;
 * the value gets its own state color.
 */
function command(
  key: string,
  label: string,
  value?: string,
  tone: string = C,
  valueTone: string = W,
): string {
  const head = `${tone}${label}${R}${D}[${R}${B}${tone}${key}${R}${D}]${R}`;
  return value === undefined || value === "" ? head : `${head}${D}:${R} ${B}${valueTone}${value}${R}`;
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
  const cwd = l.repoRoot;
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
  let eventSel = 0;
  let eventScroll = 0;
  let thinkingScroll = 0;
  let thinkingFollow = true;
  let childSel = 0;
  const expanded = new Set<string>();
  let changesCache: ChangesCache | null = null;

  let newrun: NewRunState = {
    agent: "build",
    mode: "verified",
    preset: "implement",
    verification: "verified",
    issues: "optional",
    ask: true,
    approval: "human",
    ambiguity: "precise",
    tier: "paid",
    minFit: undefined,
    floors: "role",
    prompt: "",
  };
  let newRunRepo = l.repoRoot;
  let issuePick: "newrun" | null = null;
  let issuePickSel = 0;
  let issuePickText = "";
  /** New-run prompt is modal: navigation keys are disabled while true. */
  let newRunInsert = false;
  let newRunPendingJ = false;
  /** Advanced, rarely-touched new-run options live behind [s]. */
  let newRunSettings = false;
  let newRunSettingsSel = 0;
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
  let spendCacheAt = 0;
  let spendToday = 0;

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
    const policy = (() => { try { return loadPolicy(l); } catch { return undefined; } })();
    const agent = "build";
    const def = agentDef(l, agent);
    return {
      agent,
      mode: def.defaultMode ?? def.modes[0] ?? "",
      preset: def.preset,
      verification: "verified",
      issues: "optional",
      ask: true,
      approval: "human",
      ambiguity: "precise",
      tier: "paid",
      minFit: undefined,
      floors: "role",
      prompt: "",
    };
  };

  newrun = defaultNewRun();

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
    const def = agentDef(l, newrun.agent);
    newrun.mode = def.defaultMode ?? def.modes[0] ?? "";
    newrun.preset = def.preset;
    newRunInsert = false;
    newRunPendingJ = false;
    newRunSettings = false;
    newRunSettingsSel = 0;
    screen = "newrun";
  };

  const cycleAgent = () => {
    const index = NEW_RUN_AGENTS.indexOf(newrun.agent);
    newrun.agent = NEW_RUN_AGENTS[(index + 1) % NEW_RUN_AGENTS.length] ?? newrun.agent;
    const def = agentDef(l, newrun.agent);
    const modes = def.modes;
    newrun.mode = modes.includes(newrun.mode) ? newrun.mode : (def.defaultMode ?? modes[0] ?? "");
    newrun.preset = def.preset;
  };

  const cycleNewRunSetting = (field: NewRunSettingField) => {
    if (field === "mode") {
      const modes = AGENT_META[newrun.agent]?.modes ?? [];
      if (modes.length) newrun.mode = modes[(modes.indexOf(newrun.mode) + 1) % modes.length]!;
      else notify("this agent runs alone; no mode to choose");
      return;
    }
    if (field === "preset") {
      const presets = ["plan", "orchestrate", "implement", "review", "assistant", "unrestricted"];
      newrun.preset = presets[(presets.indexOf(newrun.preset) + 1) % presets.length]!;
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

  const modelPreview = (): {
    context: ContextPreview;
    model?: CatalogueRow;
    fit?: number;
    estimate?: { inputTokens: number; outputTokens: number };
    error?: string;
    policy?: Policy;
  } => {
    const newRunLayout = layout(newRunRepo);
    const policy = effectivePolicy(newRunRepo);
    const machine = (() => { try { return loadMachineConfig(newRunLayout); } catch { return undefined; } })();
    const catalogue = loadCatalogue(newRunLayout.catalogueFile);
    const cache = readIssueCache(newRunLayout);
    const context = previewContext(newRunLayout, cache?.issues ?? [], newrun.issue, newrun.prompt);
    if (!policy || !machine || !catalogue) return { context, error: "configuration/catalogue unavailable" };
    const ap = policy.agents[newrun.agent];
    if (!ap) return { context, error: `unknown agent ${newrun.agent}` };
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
    const statuses = providerStatuses(createModelsCollection());
    const configured = new Set(statuses.filter((status) => status.configured).map((status) => status.id));
    const result = pick({
      agent: newrun.agent,
      policy: effective,
      machine,
      catalogue: catalogue.models,
      configuredProviders: configured,
      availability: loadAvailability(l.home),
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: context.chars + context.promptChars,
      tier: newrun.tier,
    });
    if ("error" in result) return { context, error: result.error, policy };
    return {
      context,
      model: result.selected,
      fit: result.candidates.find((candidate) => candidate.key === result.selected.key)?.fit,
      estimate: result.estimate,
      policy,
    };
  };

  const buildNewRunArgs = (): string[] | null => {
    if (newrun.prompt.trim().length === 0) {
      notify("type a task before starting");
      return null;
    }
    const args = [
      "run",
      "--agent", newrun.agent,
      ...(newrun.mode ? ["--mode", newrun.mode] : []),
      "--tier", newrun.tier,
      "--preset", newrun.preset,
      "--verify", newrun.verification,
      "--issues", newrun.issues,
      "--ask", String(newrun.ask),
      "--approval", newrun.approval,
      "--ambiguity", newrun.ambiguity,
    ];
    if (newrun.floors === "off") {
      args.push("--min-fit", "0");
    } else if (newrun.minFit !== undefined) {
      args.push("--min-fit", String(newrun.minFit ?? 0));
    }
    if (newrun.floors === "off") {
      args.push("--min-axes", "reasoning=0,code=0,agentic=0,general=0");
    } else if (newrun.floors === "strict") {
      const policy = effectivePolicy(newRunRepo);
      const ap = policy?.agents[newrun.agent];
      const floors = CAPABILITY_AXES.map((axis) => {
        const current = ap?.minAxes?.[axis] ?? ap?.minFit ?? 6;
        return `${axis}=${Math.min(10, Math.round((current + 0.5) * 10) / 10)}`;
      });
      args.push("--min-axes", floors.join(","));
    }
    if (newrun.issue) {
      args.push("--issue", String(newrun.issue.number));
      if (newrun.agent === "build" || newrun.agent === "sudo") args.push("--auto-issue");
    }
    args.push(newrun.prompt);
    return args;
  };

  const submitNewRun = () => {
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
    const short = rows < 24;
    const footerReserve = cols < 50 ? 7 : cols < 70 ? 6 : cols < 90 ? 5 : cols < 110 ? 4 : 3;
    const allRuns = listAllRuns(l.home);
    const cache = readIssueCache(l);
    issueCachesByRepo = collectIssueCaches(allRuns);
    const issues = issueCachesByRepo.get(l.repoRoot) ?? cache?.issues ?? [];
    const counts = headerCounts(allRuns);
    const settingsMachine = (() => { try { return loadMachineConfig(l); } catch { return undefined; } })();
    const theme = resolveTheme(settingsMachine?.theme);
    if (Date.now() - spendCacheAt > 5_000) {
      spendToday = readSpendSummary(l.home, { days: 1 }).totalActual;
      spendCacheAt = Date.now();
    }
    const todaySpend = spendToday;
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
    // Tabs stay visible on every other screen, followed by one blank line.
    const header: string[] = backHeader
      ? [`${theme.backBg}${theme.backFg}${B} Back[Esc] ${R}`, ""]
      : [...wrapTokenList(tabTokens, cols, " "), ""];
    // Only the Back[Esc] label is red; the rest of the row keeps the header tone.
    const headerTone = theme.headerBg;
    const bodyH = Math.max(1, rows - header.length - (runDetailHeader ? 1 : footerReserve));

    const filteredRuns = runsFilter === "all" || runsFilter === "attention"
      ? allRuns
      : filterRuns(allRuns, runsFilter);
    const runIndex = buildRunIndex({
      runs: filteredRuns,
      issuesByRepo: issueCachesByRepo,
      group: runsGroup,
      collapsed,
      text: runsText,
      attentionOnly: runsAttention || runsFilter === "attention",
      preferredRepo: l.repoRoot,
    });
    if (runsSel >= runIndex.selectable.length) runsSel = Math.max(0, runIndex.selectable.length - 1);
    const selectedRow = runIndex.selectable[runsSel];

    const catalogue = loadCatalogue(l.catalogueFile);
    const statuses = providerStatuses(createModelsCollection());
    const activeProviders = new Set(statuses.map((status) => status.id));
    // Hide stale rows for providers that are disabled or no longer registered.
    const catalogueRows = (catalogue?.models ?? []).filter((row) => activeProviders.has(row.providerID));
    const configured = new Set(statuses.filter((status) => status.configured).map((status) => status.id));
    const modelRows = filterModels(catalogueRows, {
      text: modelText,
      providers: modelsAll ? undefined : configured,
      freeOnly: modelsFree,
      codingOnly: modelsCoding,
      sort: modelSort,
      weights: policyWeightsFor(newrun.agent),
    });
    if (modelSel >= modelRows.length) modelSel = Math.max(0, modelRows.length - 1);
    const selectedModel = modelRows[modelSel];

    const settingsPolicy = effectivePolicy();
    const settingsRows = buildSettings(l, settingsMachine, settingsPolicy);
    if (settingsSel >= settingsRows.length) settingsSel = Math.max(0, settingsRows.length - 1);

    let body: string[] = [];
    let actions = "";
    let secondary = "";
    /** True when `secondary` already carries its own styling (new-run model info). */
    let secondaryStyled = false;
    /** Run details show only the working directory in their footer. */
    let runFooter = "";

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
          const pct = roll.pct === undefined ? `${D}—${R}` : `${progress(roll.pct, narrow ? 4 : 6)} ${String(roll.pct).padStart(3)}%`;
          const badge = row.issue.reserved ? `${M}[P&R]${R} ` : "";
          const pr = roll.prState ? ` ${Y}PR ${roll.prState}${R}` : "";
          const runCount = narrow ? `${roll.runsTotal}r` : `${roll.runsTotal} run${roll.runsTotal === 1 ? "" : "s"}${roll.runsActive ? ` ${C}${roll.runsActive}●${R}` : ""}`;
          const left = `${indent}${row.collapsible ? (row.collapsed ? "▸" : "▾") : " "} ${healthIcon(roll.health)} ${BL}#${row.issue.ref.number}${R} ${D}${row.issue.kind}${R} ${badge}${B}${W}${row.issue.title}${R}`;
          const right = `${pct}  ${D}${roll.tasksClosed}/${roll.tasksTotal} tasks${R} ${runCount}${pr}  ${D}${fmtMoney(roll.cost)} · ${ago(roll.lastActivity)}${R}`;
          const text = ` ${narrow ? trunc(left, Math.max(18, cols - 16)) + " " + right : pad(left, Math.max(30, cols - visible(right) - 2)) + right}`;
          rendered.push(selected(text, isSelected));
        } else {
          const run = row.run;
          const ask = run.status === "awaiting_input" ? ` ${Y}ASK${R}` : "";
          const pr = run.prNumber ? ` ${D}PR#${run.prNumber} ${run.prState ?? ""}${R}` : "";
          const repoTag = runsGroup === "overall" ? ` ${D}[${repoLabel(run.repoRoot)}]${R}` : "";
          const right = `${D}${fmtTokens(run.usage.totalTokens)} tok · ${fmtMoney(run.cost.actual)} · ${ago(run.lastActivityAt)}${R}`;
          if (narrow) {
            const identity = `${indent}  ${icon(run.status)} ${D}${runIdFromEvent(run)}${R}${ask}${pr}`;
            rendered.push(selected(` ${trunc(identity, Math.max(12, cols - visible(right) - 2))} ${right}`, isSelected));
            const agent = `${M}${run.agent}${R}${run.mode ? `/${run.mode}` : ""}${repoTag}`;
            const request = run.request.replace(/\s+/g, " ").slice(0, 60);
            const detail = `${agent} ${D}${request}${R}`;
            rendered.push(selected(` ${indent}      ${trunc(detail, Math.max(12, cols - indent.length - 8))}`, isSelected));
          } else {
            const left = `${indent}  ${icon(run.status)} ${D}${runIdFromEvent(run)}${R} ${M}${run.agent}${R}${run.mode ? `/${run.mode}` : ""}${repoTag}${ask}${pr}`;
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
            command("?", "Help", undefined, GR),
          ])
        : joinCommands([
            command("n", "New run", undefined, C),
            command("Enter", "Open", undefined, G),
            command("space", "Fold", undefined, Y),
            command("j/k", "Move", undefined, M),
            command("/", "Search", undefined, BL),
            command("g", "Group", RUN_GROUP_LABELS[runsGroup], Y, C),
            command("f", "Filter", runsFilter, M, C),
            command("?", "Help", undefined, GR),
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
      lines.push(` ${healthIcon(issue.state === "closed" ? "done" : "on-track")} ${BL}#${issue.ref.number}${R} ${B}${W}${issue.title}${R} ${D}${issue.kind} · ${issue.state}${R}${issue.reserved ? ` ${M}[P&R]${R}` : ""}`);
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
        const line = `   ${icon(run.status)} ${D}${runIdFromEvent(run)}${R} ${M}${run.agent}${R}${run.mode ? `/${run.mode}` : ""}  ${D}${fmtTokens(run.usage.totalTokens)} tok · ${fmtMoney(run.cost.actual)} · ${ago(run.lastActivityAt)}${R}`;
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
      const preview = modelPreview();
      const ctx = preview.context;
      const ap = preview.policy?.agents[newrun.agent];
      const def = agentDef(l, newrun.agent);
      const issueChain = ctx.issueChain;
      const issueObj = newrun.issue ? issueByRef(newrun.issue) : undefined;
      const issueValue = newrun.issue ? `#${newrun.issue.number} ${issueObj?.kind ?? ""}`.trim() : "untracked";
      const displayAgent = newrun.agent ? `${newrun.agent[0]!.toUpperCase()}${newrun.agent.slice(1)}` : newrun.agent;
      const displayTier = newrun.tier === "free" ? "Free" : "Paid";
      const floorText = newrun.floors === "role" ? `role${ap ? ` (+${ap.minFit})` : ""}` : newrun.floors;
      const fitText = newrun.minFit === undefined ? `role${ap ? ` ${ap.minFit}` : ""}` : String(newrun.minFit);
      const estimateCost = preview.estimate
        ? fmtMoney(
            ((preview.estimate as { inputTokens: number }).inputTokens * (preview.model?.pricing.input ?? 0) +
              (preview.estimate as { outputTokens: number }).outputTokens * (preview.model?.pricing.output ?? 0)) /
              1_000_000,
          )
        : "?";
      const fitScore = preview.fit;
      const fitTone = fitScore === undefined ? D : fitScore >= 7.5 ? G : fitScore >= 6 ? Y : RED;
      const costTone = preview.model?.free ? G : Y;
      const modelInfo = preview.error
        ? `${M}Model${R} ${RED}${preview.error}${R}`
        : [
            `${M}Model${R} ${B}${C}${preview.model?.key ?? "?"}${R}`,
            fitScore === undefined ? "" : `${D}fit${R} ${fitTone}${fitScore.toFixed(2)}${R}`,
            `${D}cost${R} ${costTone}${estimateCost}${R}`,
            ...(preview.model
              ? [
                  `${M}${preview.model.kind}${R}`,
                  `${D}ctx${R} ${C}${fmtContext(preview.model.context)}${R}`,
                  `${D}in${R} ${Y}$${preview.model.pricing.input}/M${R}`,
                  `${D}out${R} ${Y}$${preview.model.pricing.output}/M${R}`,
                ]
              : []),
          ]
            .filter(Boolean)
            .join("  ");
      const contextTokens = Math.ceil((ctx.chars + ctx.promptChars) / 4);
      const contextLine = ` ${C}Context${R} ${W}${(contextTokens / 1000).toFixed(1)}K${R}`;
      const chainLine = ` ${BL}Hierarchy${R} ${D}${issueChain.length ? issueChain.map((issue) => `#${issue.ref.number} ${issue.kind}`).join(" ← ") : "untracked · no issue context"}${R}`;
      const summary = [
        contextLine,
        chainLine,
      ].filter(Boolean);
      if (ctx.warnings.length > 0) summary.push(` ${Y}${ctx.warnings[0]}${R}`);

      const boxWidth = Math.max(20, cols - 4);
      const inner = Math.max(12, boxWidth - 2);
      const promptText = newrun.prompt || (newRunInsert ? "" : "Press e to type the task");
      const promptLines = wrapText(promptText, Math.max(8, inner - 3));
      if (newRunInsert) {
        if (promptLines.length === 0) promptLines.push("▌");
        else promptLines[promptLines.length - 1] = `${promptLines[promptLines.length - 1]}▌`;
      }
      const availableForPrompt = Math.max(3, bodyH - summary.length - 6);
      const promptHeight = Math.max(3, Math.min(16, availableForPrompt, Math.floor(bodyH * 0.5)));
      const shownPrompt = promptLines.slice(-promptHeight);
      const promptBox = [
        ` ${D}┌${"─".repeat(inner)}┐${R}`,
        ...shownPrompt.map((line) => ` ${D}│${R} ${W}${fit(line, inner - 2)}${R} ${D}│${R}`),
        ...Array.from({ length: Math.max(0, promptHeight - shownPrompt.length) }, () => ` ${D}│${R} ${" ".repeat(inner - 2)} ${D}│${R}`),
        ` ${D}└${"─".repeat(inner)}┘${R}`,
      ];

      const sources: string[] = [];
      const sourceRoom = Math.max(0, bodyH - summary.length - promptBox.length - 2);
      if (sourceRoom > 1 && ctx.sources.length > 0) {
        sources.push(` ${B}${C}Will inherit${R} ${D}· ${ctx.sources.length} source(s)${R}`);
        const toneFor = (kind: string): string =>
          kind === "issue" || kind === "task" || kind === "feature" || kind === "epic" ? Y :
          kind === "tool" ? M : kind === "script" ? BL : kind === "skill" ? G : C;
        for (const source of ctx.sources.slice(0, Math.max(0, sourceRoom - 1))) {
          const tone = toneFor(source.kind);
          sources.push(`  ${source.exists ? G + "✓" : Y + "?"}${R} ${tone}${source.kind.padEnd(9)}${R} ${W}${trunc(source.ref, Math.max(12, cols - 30))}${R} ${D}${fmtTokens(source.chars)}${R}`);
        }
      }

      if (issuePick === "newrun") {
        const list = pickerIssues();
        if (issuePickSel >= list.length) issuePickSel = Math.max(0, list.length - 1);
        const picker: string[] = [` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Link an issue${R} ${D}(type to filter; Enter selects)${R}`, ""];
        for (let i = 0; i < list.length; i++) {
          const issue = list[i]!;
          const indent = issue.kind === "epic" ? "" : issue.kind === "feature" ? "  " : "    ";
          const line = ` ${indent}${issue.ref.number === newrun.issue?.number ? C + "▸" : " "} ${BL}#${issue.ref.number}${R} ${D}${issue.kind}${R} ${W}${issue.title}${R}`;
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
          mode: "Mode",
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
          mode: newrun.mode || "single",
          preset: newrun.preset,
          verification: newrun.verification,
          issues: newrun.issues,
          ask: newrun.ask ? "on" : "off",
          approval: newrun.approval,
          ambiguity: newrun.ambiguity,
          minFit: fitText,
          floors: floorText,
        };
        const lines: string[] = [
          ` ${B}${W}New-run settings${R} ${D}· ${def.blurb}${R}`,
          ` ${D}${cwd}${R}`,
          "",
        ];
        for (let i = 0; i < NEW_RUN_SETTING_FIELDS.length; i++) {
          const field = NEW_RUN_SETTING_FIELDS[i]!;
          const value = values[field];
          const tone = i % 2 === 0 ? C : M;
          const line = `  ${pad(labels[field], 12)} ${tone}${B}${value}${R}`;
          lines.push(selected(line, i === newRunSettingsSel));
        }
        lines.push("", ` ${D}Rarely changed options live here; the main screen stays compact.${R}`);
        body = clipBody(lines);
        actions = joinCommands([
          command("j/k", "Move", undefined, M),
          command("Enter", "Change", undefined, G),
        ]);
        secondary = `${D}${NEW_RUN_SETTING_FIELDS.length} option(s) · changes apply to this run only${R}`;
      } else {
        body = clipBody([...summary, "", ...promptBox, ...(sources.length ? ["", ...sources] : [])]);
        actions = newRunInsert
          ? joinCommands([
              command("Esc/jk", "Done", undefined, Y),
              command("Enter", "Newline", undefined, G),
              command("Backspace", "Delete", undefined, M),
            ])
          : joinCommands([
              command("a", "Agent", displayAgent, C, M),
              command("t", "Tier", displayTier, Y, newrun.tier === "free" ? G : Y),
              command("i", "Issue", issueValue, BL, newrun.issue ? C : GR),
              command("e", "Prompt", newRunInsert ? "editing" : "edit", G, newRunInsert ? Y : W),
              command("s", "Settings", undefined, M),
              command("Enter", "Start", undefined, G),
            ]);
        secondaryStyled = !newRunInsert;
        secondary = newRunInsert
          ? `${Y}Insert mode${R} ${D}· all key commands disabled · Esc or jk exits${R}${toast ? ` · ${Y}${toast}${R}` : ""}`
          : `${modelInfo}${toast ? `  ${D}· ${toast}${R}` : ""}`;
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
        ` ${B}${W}${model.name}${R} ${D}${model.key}${R}`,
        ` ${D}${model.providerID} · ${model.kind} · ${model.coding ? "coding" : "non-coding"} · ${model.modes.join(", ") || "plain chat"}${R}`,
        "",
        ` ${B}${C}Capability${R}`,
      ];
      for (const axis of CAPABILITY_AXES) {
        const score = model.scores[axis];
        lines.push(`   ${axis.padEnd(10)} ${progress(score * 10, Math.min(24, Math.max(8, Math.floor(cols / 4))))} ${score.toFixed(2)}`);
      }
      lines.push(`   ${"weighted".padEnd(10)} ${D}${weights ? "role " + newrun.agent : "neutral"}${R} ${modelWeightedFit(model, weights).toFixed(2)}`);
      lines.push("", ` ${B}${C}Offer${R}`);
      lines.push(`   context ${C}${fmtContext(model.context)}${R} · max out ${C}${fmtContext(model.maxOutput)}${R} · in ${Y}$${model.pricing.input}${R}/M · out ${Y}$${model.pricing.output}${R}/M${model.free ? ` ${G}free${R}` : ""}`);
      if (model.benchmarks) {
        lines.push(`   benchmarks ${D}${Object.entries(model.benchmarks).filter(([, value]) => typeof value === "number").slice(0, 6).map(([key, value]) => `${key} ${value}`).join("  ")}${R}`);
      }
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
            const avail = loadAvailability(l.home);
            const phase = avail.models[row.key];
            return phase?.cooldownUntil && phase.cooldownUntil > Date.now() ? ` ${Y}⏱${R}` : "";
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
        command("a", "Providers", modelsAll ? "all" : "configured", C, modelsAll ? Y : C),
        command("f", "Free", modelsFree ? "only" : "all", M, modelsFree ? G : GR),
        command("c", "Coding", modelsCoding ? "only" : "all", Y, modelsCoding ? G : GR),
        command("g", "Group", modelGroup, BL, C),
        command("s", "Sort", modelSort, GR, C),
        command("j/k", "Move", undefined, GR),
      ]);
      secondary = `${D}${modelRows.length} model(s)${modelText ? ` · “${modelText}”` : ""}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`;
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
          const perMillion = bucket.tokens > 0 ? bucket.actual / (bucket.tokens / 1_000_000) : 0;
          lines.push(`  ${pad(key, narrow ? 20 : 38)} ${spendBar(bucket.actual, max, narrow ? 4 : 10)} ${fmtMoney(bucket.actual)}  ${D}${String(bucket.calls).padStart(4)} calls · ${fmtTokens(bucket.tokens)} tok · ${fmtTokens(bucket.freeTokens)} free${perMillion > 0 ? ` · ${fmtMoney(perMillion)}/Mtok` : ""}${R}`);
        }
      }
      const w = selectableLines(lines, spendScroll, spendScroll, bodyH);
      spendScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("g", "Group", spendBy, C, G),
        command("d", "Range", spendDaysWindow === 0 ? "all" : `${spendDaysWindow}d`, Y, C),
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
      actions = joinCommands([
        command("j/k", "Select", undefined, M),
        command("e", "Edit file", undefined, G),
        command("o", "Reveal", undefined, BL),
        command("p", "Policy", undefined, Y),
        command("c", "Config", undefined, C),
        command("r", "Reload", undefined, GR),
      ]);
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
        const children = childRuns(allRuns, s.id);
        const thinking = thinkingChunks(ev);
        const touched = touchedPaths(ev);
        runFooter = `${s.worktree ?? s.repoRoot}  ${s.worktree ? "worktree" : "read-only"}`;
        const sectionBar = wrapTokenList(
          RUN_SECTIONS.map((section) =>
            section === runSection
              ? `${theme.sectionActiveBg}${theme.sectionActiveFg}${B} ${RUN_SECTION_LABEL[section]} ${R}`
              : `${theme.sectionFg}${RUN_SECTION_LABEL[section]}${R}`,
          ),
          cols - 2,
          " ",
        ).map((line) => background(fit(` ${line}`, cols), theme.sectionBg));
        const lines: string[] = [
          ` ${icon(s.status)} ${B}${BL}${s.id}${R}  ${statusColor(s.status)}${s.status.toUpperCase()}${R}  ${M}${s.agent}${R}${s.mode ? `/${s.mode}` : ""}  ${G}${s.modelCalls}${R} call(s)  ${C}${fmtTokens(s.usage.totalTokens)}${R} tok  ${Y}${fmtMoney(s.cost.actual)}${R}  ${D}${ago(s.lastActivityAt)}${R}`,
        ];
        const issueMeta = [s.issue ? `#${s.issue.number}` : "", s.prNumber ? `PR #${s.prNumber} ${s.prState ?? ""}` : ""]
          .filter(Boolean)
          .join("  ");
        if (issueMeta) lines.push(` ${D}${issueMeta}${R}`);
        lines.push("", ...sectionBar, "");
        if (runSection === "overview") {
          lines.push(` ${B}${C}Status${R}`);
          const statusText = s.error ?? s.finalText ?? s.status.toUpperCase();
          const statusTone = s.error ? RED : s.status === "completed" ? G : W;
          for (const line of wrapText(statusText, cols - 4).slice(0, short ? 3 : 6)) {
            lines.push(`  ${statusTone}${line}${R}`);
          }
          if (pending?.text) lines.push(` ${Y}? ASK${R} ${W}${trunc(pending.text, cols - 8)}${R}`);
          lines.push("", ` ${B}${C}Request${R}`);
          for (const line of wrapText(s.request, cols - 4).slice(0, short ? 3 : 6)) lines.push(`  ${W}${line}${R}`);
          lines.push("", ` ${B}${C}Now${R}`);
          const lastModel = [...ev].reverse().find((event) => event.type === "model_select" && !event.error);
          const lastTool = [...ev].reverse().find((event) => event.type === "tool_call_start");
          const lastEnd = [...ev].reverse().find((event) => event.type === "model_call_end");
          lines.push(`  model  ${C}${String(lastModel?.key ?? "(pending)")}${R}`);
          if (lastTool) lines.push(`  tool   ${Y}${String(lastTool.tool)}${R} ${D}${JSON.stringify(lastTool.args ?? {}).slice(0, cols - 18)}${R}`);
          if (lastEnd) lines.push(`  turn   ${D}${String(lastEnd.stopReason ?? "")} · ${fmtTokens(Number((lastEnd.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0))} tok${R}`);
          lines.push("", ` ${B}${C}Progress${R}`);
          lines.push(`  context ${C}${context ? `${context.chars.toLocaleString()} chars / ${context.sources.length} sources` : "not recorded"}${R}`);
          lines.push(`  changes ${touched.length ? `${C}${touched.length}${R} path(s) touched` : `${D}none yet${R}`}`);
          if (children.length) lines.push(`  children ${C}${children.length}${R} subagent run(s)`);
          lines.push(`  parent  ${s.parentRunId ? `${D}${s.parentRunId.slice(-8)}${R}` : `${D}none${R}`}`);
          if (context) {
            lines.push("", ` ${B}${C}Context${R}`);
            for (const source of context.sources.slice(0, short ? 3 : 8)) {
              lines.push(`  ${source.kind.padEnd(10)} ${D}${String(source.bytes).padStart(6)}b${R} ${source.ref}`);
            }
          }
          if (thinking.length) {
            lines.push("", ` ${B}${C}Latest${R}`);
            for (const line of wrapText(thinking[thinking.length - 1]!.text, cols - 4).slice(-Math.max(1, short ? 2 : 5))) lines.push(`  ${W}${line}${R}`);
          }
          const w = selectableLines(lines, 0, runScroll, bodyH);
          runScroll = w.scroll;
          body = clipBody(w.lines);
        } else if (runSection === "timeline") {
          const eventLines: string[] = [];
          const starts: number[] = [];
          for (let i = 0; i < ev.length; i++) {
            starts[i] = eventLines.length;
            const event = ev[i]!;
            const isSelected = i === eventSel;
            const prefix = isSelected ? `${C}▸${R}` : " ";
            const time = String(event.t ?? "").slice(11, 19);
            const expandedEvent = expanded.has(`${s.id}:${i}`);
            const type = String(event.type);
            if (type === "run_start") eventLines.push(`${prefix} ${GR}${time}${R} ${C}▶ start${R} ${M}${event.agent}${R}${event.mode ? `/${event.mode}` : ""}`);
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
              const text = typeof event.text === "string" ? event.text : "";
              if (text) {
                for (const line of text.split("\n")) {
                  for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${W}${wrapped}${R}`);
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
            else if (type === "retry") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}↻ retry${R} ${D}${String(event.failedModel)}${R}`);
            else if (type === "control") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}⌘ ${String(event.action)}${R}`);
            else if (type === "run_end") eventLines.push(`${prefix} ${GR}${time}${R} ${statusColor(String(event.status))}■ ${String(event.status).toUpperCase()}${R}`);
            else if (type === "child_spawned") eventLines.push(`${prefix} ${GR}${time}${R} ${M}↳ child${R} ${C}${String(event.childRunId ?? "").slice(-8)}${R} ${D}${String(event.role ?? "")}${R}`);
            else if (type === "child_completed") eventLines.push(`${prefix} ${GR}${time}${R} ${M}↲ child done${R} ${C}${String(event.childRunId ?? "").slice(-8)}${R} ${String(event.status ?? "")}`);
            else if (type === "issue_created") eventLines.push(`${prefix} ${GR}${time}${R} ${G}+ issue${R} #${String(event.issue)} ${D}${String(event.kind ?? "")}${R}`);
            else if (type === "context_assembled") eventLines.push(`${prefix} ${GR}${time}${R} ${BL}context${R} ${D}${fmtTokens(Number(event.chars ?? 0))} chars${R}`);
            else eventLines.push(`${prefix} ${GR}${time}${R} ${D}${type}${R}`);
          }
          eventSel = Math.max(0, Math.min(ev.length - 1, eventSel));
          const start = starts[eventSel] ?? 0;
          if (start < eventScroll) eventScroll = start;
          if (start >= eventScroll + bodyH - 4) eventScroll = start - (bodyH - 4) + 1;
          const visibleCount = Math.max(1, bodyH - 4);
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
          body = clipBody(lines);
        } else if (runSection === "children") {
          if (children.length === 0) lines.push(` ${D}No child/subagent runs.${R}`);
          if (childSel >= children.length) childSel = Math.max(0, children.length - 1);
          for (let i = 0; i < children.length; i++) {
            const child = children[i]!;
            const isSelected = i === childSel;
            const line = ` ${icon(child.status)} ${D}${child.id.slice(-8)}${R} ${M}${child.agent}${R}${child.mode ? `/${child.mode}` : ""} ${D}${fmtTokens(child.usage.totalTokens)} tok · ${fmtMoney(child.cost.actual)} · ${ago(child.lastActivityAt)}${R} ${child.request.replace(/\s+/g, " ").slice(0, 40)}`;
            lines.push(selected(line, isSelected));
          }
          body = clipBody(lines);
        } else if (runSection === "context") {
          if (!context) lines.push(` ${D}No context manifest recorded.${R}`);
          else {
            lines.push(` ${B}${C}Context manifest${R} ${D}${context.chars.toLocaleString()} chars / ${context.sources.length} sources${R}`);
            for (const source of context.sources) {
              lines.push(`  ${source.kind.padEnd(10)} ${D}${String(source.bytes).padStart(6)}b${R} ${source.origin.padEnd(9)} ${W}${trunc(source.ref, cols - 36)}${R}${source.truncated ? ` ${Y}trunc${R}` : ""}${source.warning ? ` ${Y}${source.warning}${R}` : ""}`);
            }
          }
          body = clipBody(lines);
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

    /* ------------------------------------------------------------- help */
    else if (screen === "help") {
      const lines = [
        "",
        ` ${C}Navigation${R}`,
        `   ${W}1-4 / Tab${R}  switch page        ${W}j/k${R}      move or scroll`,
        `   ${W}Enter${R}      open / start       ${W}Space${R}    fold or expand`,
        `   ${W}/${R}          search              ${W}q / Esc${R}  back or quit`,
        "",
        ` ${Y}Runs${R}`,
        `   ${W}n${R} new run    ${W}N${R} untracked run    ${W}g${R} group    ${W}f${R} filter    ${W}r${R} refresh cache`,
        "",
        ` ${M}Run detail${R}`,
        `   ${W}h/l${R} section   ${W}space${R}/${W}Enter${R} expand   ${W}a${R} answer   ${W}i${R} interrupt   ${W}c${R} correct   ${W}p${R} approve   ${W}o${R} open`,
        "",
        ` ${G}New run${R}`,
        `   ${W}a${R} agent   ${W}t${R} tier   ${W}i${R} issue   ${W}e${R}/p prompt edit   ${W}s${R} settings   ${W}Enter${R} start   ${W}Esc${R} cancel`,
        `   In the prompt: ${W}Enter${R} newline · ${W}Esc${R} or ${W}jk${R} leaves insert mode.`,
        "",
        ` ${D}GH issue groups by repository, then the Epic → Feature → Task tree and Untracked.${R}`,
        ` ${D}g cycles GH issue → Status (per repo) → Overall status (machine-wide).${R}`,
        ` ${D}Screen: ${screen} · cwd: ${cwd}${R}`,
      ];
      body = clipBody(lines);
      actions = joinCommands([
        command("Esc", "Back", undefined, GR),
        command("q", "Back", undefined, GR),
      ]);
      secondary = `${D}${process.env.npm_package_version ? `v${process.env.npm_package_version}` : ""}${R}`;
    }

    /* ------------------------------------------------------------ compose */
    if (searchMode) {
      actions = joinCommands([
        command("/", "Search", searchText || "…", C, W),
        command("Enter", "Apply", undefined, G),
        command("Esc", "Cancel", undefined, GR),
      ]);
      secondary = `${D}filters ${page} · type to edit${R}`;
    }
    const defaultActions = joinCommands([
      command("1-4", "Pages", undefined, C),
      command("?", "Help", undefined, BL),
      command("q", "Quit", undefined, GR),
    ]);
    const statusTokens = [
      `${M}⚑${R} ${counts.approvals} approval${counts.approvals === 1 ? "" : "s"}`,
      `${Y}PR${R} ${counts.openPrs} open`,
      `${G}$${todaySpend.toFixed(2)}${R} today`,
    ];
    // Runs list keeps its live counts on the very bottom row of the screen.
    const runIndicators = [
      `${C}●${R}  ${counts.active} running`,
      `${Y}?${R}  ${counts.awaiting} awaiting`,
      `${Y}⏸${R}  ${counts.paused} paused`,
    ];
    const commandRows = runDetailHeader ? [] : wrapCommands(actions || defaultActions, cols);
    const secondaryRows = runDetailHeader
      ? []
      : secondaryStyled
        ? wrapCommands(secondary, cols).slice(0, 2)
        : wrapPlain(secondary, cols).slice(0, narrow ? 2 : 1);
    // The runs page owns the full status footer: live counts plus approvals/PR/spend.
    const trailingRows = runDetailHeader
      ? []
      : page === "runs" && screen === "list"
        ? wrapTokenList([...runIndicators, ...statusTokens], cols, "   ")
        : [];
    const footer = runDetailHeader
      ? runFooter
        ? [` ${D}${runFooter}${R}`]
        : []
      : [...commandRows, ...secondaryRows, ...trailingRows];
    // Key legends sit on the near-black surface; trailing rows keep the footer band.
    const legendRows = commandRows.length;
    const bodySpace = Math.max(0, rows - header.length - footer.length);
    body = body.slice(0, bodySpace);
    while (body.length < bodySpace) body.push("");
    const frame = [...header, ...body, ...footer];
    while (frame.length < rows) frame.push("");
    const headerCount = header.length;
    const footerStart = headerCount + body.length;
    const output = frame.slice(0, rows).map((line, index) => {
      const fitted = fit(sanitizeLine(line), cols);
      if (index < headerCount) return background(fitted, headerTone);
      if (index >= footerStart) {
        const footerIndex = index - footerStart;
        return background(fitted, footerIndex < legendRows ? theme.bodyBg : theme.footerBg);
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

  const pickerIssues = (): Issue[] => {
    const cache = readIssueCache(layout(newRunRepo));
    if (!cache) return [];
    if (!issuePickText.trim()) return cache.issues;
    const q = issuePickText.toLowerCase();
    return cache.issues.filter((issue) => `#${issue.ref.number} ${issue.title} ${issue.kind}`.toLowerCase().includes(q));
  };

  const chooseIssue = (issue: Issue) => {
    newrun.issue = issue.ref;
    issuePick = null;
    notify(`linked #${issue.ref.number}; ${issue.kind === "task" ? "runs attach here" : "a child task will be created"}`);
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
      if (issuePick === "newrun") {
        if (data === "\x1b") { issuePick = null; draw(); return; }
        if (data === "\x1b[A" || data === "k") { issuePickSel = Math.max(0, issuePickSel - 1); draw(); return; }
        if (data === "\x1b[B" || data === "j") { const list = pickerIssues(); issuePickSel = Math.min(Math.max(0, list.length - 1), issuePickSel + 1); draw(); return; }
        if (data === "\r" || data === "\n") { const list = pickerIssues(); const issue = list[issuePickSel]; if (issue) chooseIssue(issue); draw(); return; }
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
        if (data === "\x1b" || data === "jk") { newRunInsert = false; newRunPendingJ = false; draw(); return; }
        if ((newRunPendingJ || newrun.prompt.endsWith("j")) && data === "k") {
          newrun.prompt = newrun.prompt.slice(0, -1);
          newRunPendingJ = false;
          newRunInsert = false;
          draw();
          return;
        }
        newRunPendingJ = false;
        if (data === "j") newRunPendingJ = true;
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
      if (data === "\x1b") { screen = "list"; draw(); return; }
      if (data === "\r" || data === "\n") { submitNewRun(); draw(); return; }
      if (data === "a") { cycleAgent(); draw(); return; }
      if (data === "t") { newrun.tier = newrun.tier === "paid" ? "free" : "paid"; draw(); return; }
      if (data === "i") { startIssuePicker(); draw(); return; }
      if (data === "s") { newRunSettings = true; newRunSettingsSel = 0; draw(); return; }
      if (data === "e" || data === "p") { newRunInsert = true; newRunPendingJ = false; draw(); return; }
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

    if (screen === "help") {
      if (data === "\x1b" || data === "q" || data === "?") { screen = "list"; draw(); return; }
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
    if (data === "?") { screen = "help"; draw(); return; }

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
      if (data === "j" || data === "\x1b[B") {
        if (runSection === "timeline") eventSel = Math.min(Math.max(0, n - 1), eventSel + 1);
        else if (runSection === "thinking") { thinkingFollow = false; thinkingScroll++; }
        else if (runSection === "children") childSel++;
        else runScroll++;
        draw();
        return;
      }
      if (data === "k" || data === "\x1b[A") {
        if (runSection === "timeline") eventSel = Math.max(0, eventSel - 1);
        else if (runSection === "thinking") { thinkingFollow = false; thinkingScroll = Math.max(0, thinkingScroll - 1); }
        else if (runSection === "children") childSel = Math.max(0, childSel - 1);
        else runScroll = Math.max(0, runScroll - 1);
        draw();
        return;
      }
      const moveSection = (delta: number) => {
        const index = RUN_SECTIONS.indexOf(runSection);
        runSection = RUN_SECTIONS[(index + delta + RUN_SECTIONS.length) % RUN_SECTIONS.length]!;
        runScroll = 0;
        eventScroll = 0;
        thinkingFollow = true;
        draw();
      };
      if (data === "h" || data === "\x1b[D") { moveSection(-1); return; }
      if (data === "l" || data === "\x1b[C") { moveSection(1); return; }
      if (data === "]" || data === "[") { moveSection(data === "]" ? 1 : -1); return; }
      const toggleEvent = () => {
        if (runSection !== "timeline") return;
        const key = `${detail.summary.id}:${eventSel}`;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      };
      if (data === " ") { toggleEvent(); draw(); return; }
      if (data === "a") { answerRun(detail.summary); draw(); return; }
      if (data === "i") { interrupt(detail.summary); draw(); return; }
      if (data === "c") { startCorrect(detail.summary); draw(); return; }
      if (data === "p") { approveSelected(issueByRef(detail.summary.issue), detail.summary, detail.summary.repoRoot); draw(); return; }
      if (data === "o") { openUrl(issueByRef(detail.summary.issue)?.url ?? detail.summary.prUrl); draw(); return; }
      if (data === "\r" || data === "\n") {
        if (runSection === "timeline") toggleEvent();
        else if (runSection === "children") {
          const child = childRuns(listAllRuns(l.home), detail.summary.id)[childSel];
          if (child) { selectedRunId = child.id; runSection = "overview"; screen = "run"; }
        }
        draw();
        return;
      }
      if (data === "g") { thinkingFollow = true; draw(); return; }
      draw();
      return;
    }

    /* ------------------------------------------------------- model keys */
    if (page === "models" && screen === "model") {
      if (data === "\x1b[A" || data === "k") { modelScroll = Math.max(0, modelScroll - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { modelScroll++; draw(); return; }
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

    /* ---------------------------------------------------- settings keys */
    if (page === "settings") {
      if (data === "\x1b[A" || data === "k") { settingsSel = Math.max(0, settingsSel - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { settingsSel++; draw(); return; }
      if (data === "e" || data === "\r" || data === "\n") {
        const machine = (() => { try { return loadMachineConfig(l); } catch { return undefined; } })();
        const rows = buildSettings(l, machine, effectivePolicy());
        const row = rows[settingsSel];
        openEditor(settingsFileFor(l, row));
        draw();
        return;
      }
      if (data === "o") {
        const machine = (() => { try { return loadMachineConfig(l); } catch { return undefined; } })();
        const rows = buildSettings(l, machine, effectivePolicy());
        const row = rows[settingsSel];
        notify(settingsFileFor(l, row) ?? "");
        draw();
        return;
      }
      if (data === "p") { openEditor(l.policyFile); draw(); return; }
      if (data === "c") { openEditor(l.machineConfig); draw(); return; }
      if (data === "r") { draw(); return; }
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
  setInterval(() => {
    if (Date.now() - issueRefreshAt > 30_000) void refreshIssues();
    draw();
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
