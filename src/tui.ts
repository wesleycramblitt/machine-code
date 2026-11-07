/**
 * machine_code — TUI.
 *
 * Four durable pages (runs, models, spend, settings) plus focused
 * detail/composer screens. The frame contract is unchanged: exactly `rows`
 * lines, two header lines, two footer lines, content clipped to the middle.
 *
 * The TUI wraps the CLI's file/CLI primitives rather than inventing a second
 * source of truth. Every screen is derived from run summaries, the packet
 * catalog, the catalogue, config, and the spend ledger on each refresh.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout, type Layout } from "./paths.js";
import { readPacketFile, writePacketFile, listPacketFiles, planCategories, type PacketFile } from "./plan/packets.js";
import { isActiveStatus, listAllRuns, listProjects, readRun, type RunEvent, type RunSummary } from "./state/runs.js";
import { summarizeRun, readStateView } from "./state/outcome.js";
import { appendInbox, latestUnansweredQuestion, readInbox } from "./state/question.js";
import { headerCounts, sortRuns } from "./tui/status.js";
import {
  RUN_GROUPS,
  RUN_GROUP_LABELS,
  buildRunIndex,
  focusRowIds,
  repoLabel,
  repoOf,
  type RunGroup,
  type RunRow,
} from "./tui/runs.js";
import { scrollLines, selectableLines } from "./tui/scroll.js";
import {
  agentTone,
  ago, ALT, ALT_L, B, background, BG, BL, C, CLEAR_BELOW, command, commandBadge, contextTone,
  R, Y,
  CTRL_D, CTRL_U, D, dim, DIM, editEventArgs, editSummaryLines, eventTone, fit, fmtContext,
  fmtMoney, fmtRunTokens, fmtTokens, G, GR, HALF_PAGE, HIDE, HOME, icon, isEditToolEvent,
  isGenericTaskRequest, joinCommands, M, modelPriceText, modelReasonLabel, modelReasonRank,
  modelReasonText, type ModelPickerEntry, pad, PANEL_BG, printable, progress, RED, recentEditEvents,
  resolveTheme, runIdFromEvent, sanitizeLine, selected, SHOW, splitKeys, statusColor, stripAnsi,
  SUBTAB_BG, START_BG, SYNC_OFF, SYNC_ON, tierTone, trunc, type UiTheme, visible, W, WHITE,
  wrapCommands, wrapPlain, wrapText, wrapTokenList, WRAP_OFF, WRAP_ON, ZEBRA_BG,
} from "./tui/format.js";
import { describeTimelineEvent, describeToolArgs, isTimelineEvent, lastTimelineIndex, stepTimelineSelection, waitingForRun } from "./tui/timeline.js";
import { buildSettings, settingsFileFor, type SettingRow } from "./tui/settings.js";
import { forkSettingsFromRun, type ForkedRunSettings } from "./tui/fork.js";
import { loadMachineConfig, loadPolicy, CAPABILITY_AXES, SELECTION_TIERS, type AgentPolicy, type MachineConfig, type Policy } from "./config.js";
import { axisWeights, effectiveCallCost, estimateTokens, isMetaRouter, modelStatus, pick } from "./select.js";
import { readSpendSummary, spendBar, spendDays } from "./spend.js";
import { loadAvailability, saveAvailability, type AvailabilityState } from "./availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "./availability/probe.js";
import { latestProcessRecords } from "./processes/registry.js";
import { skillListItems, toolListItems, tokensForChars } from "./tui/tools.js";
import { toolSchemaChars } from "./tools/schema.js";
import { readLogTail } from "./processes/logs.js";
import { reconcileProcessRecords } from "./processes/reconcile.js";
import { terminateAllProcesses, terminateProcessRecord } from "./processes/supervisor.js";
import { AGENT_META, AGENT_NAMES, agentDef, roleSkillPresets } from "./agents.js";
import { resolveAgent, resolveAgentConfig } from "./agents/config.js";
import { createModelsCollection, providerStatuses } from "./models.js";
import { fundedProviderIds } from "./data.js";
import { loadCatalogue } from "./catalogue/load.js";
import { loadCuration } from "./catalogue/refresh.js";
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
import { commitPlanningFiles } from "./tasks/packet.js";

/* Terminal primitives live in ./tui/format.js; imported above. */


type Page = "runs" | "models" | "spend" | "settings";
type Screen = "list" | "run" | "newrun" | "answer" | "correct" | "model" | "delete" | "packet";
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
const NEW_RUN_CONTEXT_TABS = ["Packets", "Plans", "Knowledge", "Skills", "Scripts", "Tools", "Codebase", "References", "Agent Prompt", "Files"] as const;

type NewRunState = ForkedRunSettings & {
  /** Isolation worktree. Shown only for build; other agents ignore it. */
  worktree: boolean;
};


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

/* Pure formatting helpers live in ./tui/format.js; mapStatusTokens stays here (filesystem/LSP). */

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


/* ------------------------------------------------------------------ app */

export async function runTui(): Promise<void> {
  const l = layout();
  mkdirSync(l.localDir, { recursive: true });

  // Fold fresh provider listings into the catalogue file so the model picker
  // reflects added/removed models without a manual refresh. Best-effort and
  // silent: the picker reads whatever is on disk either way.
  try {
    const [{ createModelsCollection }, { loadProviderDefinitions }] = await Promise.all([
      import("./models.js"),
      import("./data.js"),
    ]);
    const models = createModelsCollection();
    const dynamic = Object.entries(loadProviderDefinitions())
      .filter(([, def]) => def.discovery === "openai-compatible" || def.discovery === "ollama")
      .map(([id]) => id);
    if (dynamic.length > 0) await models.refresh({ allowNetwork: true, providers: dynamic });
    const { reconcileCatalogue } = await import("./catalogue/reconcile.js");
    const { providerFetchOk } = await import("./models/providers.js");
    await reconcileCatalogue(l, models, (id) => providerFetchOk(id));
  } catch {
    // discovery/reconcile failures leave the cached catalogue in place
  }

  let page: Page = "runs";
  let screen: Screen = "list";
  /** Repo scope for the runs list. `f` toggles all repos vs the TUI cwd. */
  let runsRepoScope: RunsRepoScope = "cwd";
  let runsText = "";
  let runsGroup: RunGroup = "packets";
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
  /** Index of the last row Enter opened, so the list can restore it exactly. */
  let lastOpenedModelKey: string | null = null;
  let selectedModelKey: string | null = null;
  /** Catalogue + provider cache: the 1MB models.json stays parsed across frames. */
  let catalogueCache: { mtime: number; doc: CatalogueDocument | null } | null = null;
  let statusesCache: { at: number; statuses: ReturnType<typeof providerStatuses> } | null = null;

  let spendDaysWindow = 30;
  let spendBy: "provider" | "model" | "day" | "agent" = "provider";
  let spendScroll = 0;

  let settingsSel = 0;
  let settingsScroll = 0;

  let selectedRunId: string | null = null;
  let selectedPacketSlug: string | null = null;
  let packetScroll = 0;
  let deleteRunTarget: RunSummary | undefined;
  let deleteReturn: Screen = "list";
  const deletingRuns = new Set<string>();
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
  const expanded = new Set<string>();
  let changesCache: ChangesCache | null = null;

  let newrun: NewRunState = {
    agent: "research",
    preset: "unrestricted",
    verification: "verified",
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
  let packetPick: "newrun" | null = null;
  let packetPickSel = 0;
  let packetPickText = "";
  let modelPick: "newrun" | null = null;
  let modelPickSel = 0;
  let modelPickText = "";
  /** Picker sort: role fit (default) or estimated per-call price. Eligible rows always first. */
  let modelPickSort: "fit" | "price" = "fit";
  let modelPickEntries: ModelPickerEntry[] = [];
  /** New-run prompt is modal: navigation keys are disabled while true. */
  let newRunInsert = false;
  /** Cursor column (code units) inside the new-run prompt for insert mode. */
  let newRunCursor = 0;
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
    const agent = "research";
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

  /** Roles that isolate in a worktree and expose the verify switch. */
  const agentIsolates = (agent: string): boolean => agent === "build";

  const resetNewRunUi = () => {
    newRunInsert = false;
    newRunCursor = 0;
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
    packetPick = null;
    packetPickSel = 0;
    packetPickText = "";
  };

  const startNewRun = (packetSlug?: string, repoRoot = l.repoRoot) => {
    const previous = newrun;
    newRunRepo = repoRoot;
    const packetFile = packetSlug ? readPacketFile(layout(repoRoot), packetSlug) : null;
    // A packet is implementation work: start with Build. Untracked runs keep
    // the last agent.
    const preferredAgent = packetSlug ? "build" : previous.agent;
    newrun = {
      ...defaultNewRun(),
      ...(previous.tier ? { tier: previous.tier } : {}),
      ...(preferredAgent ? { agent: preferredAgent } : {}),
      ...(packetSlug ? { packet: packetSlug } : {}),
    };
    // Verification and isolation are role-shaped: only build verifies, and a
    // fresh build isolates in a worktree.
    newrun.verification = agentIsolates(newrun.agent) ? "verified" : "direct";
    newrun.worktree = true;
    enforceLockedSkills(true);
    // A packet-attached run starts with a concrete objective. The prompt stays
    // editable, but the human no longer has to type one.
    if (packetFile) newrun.prompt = packetFile.deliverable || packetSlug || "";
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
    const agent = AGENT_NAMES.includes(summary.agent) ? summary.agent : "research";
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
    // When the run is attached to a packet, derive the request from it.
    const forkPacket = newrun.packet ? readPacketFile(repoLayout, newrun.packet) : null;
    if (forkPacket && (!newrun.prompt.trim() || isGenericTaskRequest(newrun.prompt))) {
      newrun.prompt = forkPacket.deliverable || newrun.packet || "";
    }
    resetNewRunUi();
    newRunParentId = summary.id;
    screen = "newrun";
    notify(`forked settings from ${summary.id.slice(-8)}; edit the request and start`);
  };

  const cycleAgent = () => {
    const previousAgent = newrun.agent;
    const index = NEW_RUN_AGENTS.indexOf(previousAgent);
    newrun.agent = NEW_RUN_AGENTS[(index + 1) % NEW_RUN_AGENTS.length] ?? previousAgent;
    // Verification and isolation follow the role: only build verifies and
    // isolates in a worktree.
    newrun.verification = agentIsolates(newrun.agent) ? "verified" : "direct";
    newrun.worktree = true;
    enforceLockedSkills(true);
  };

  /** Build verification mode, shown as verify[v] beside the agent row. */
  const cycleVerify = () => {
    const values: NewRunState["verification"][] = ["direct", "verified"];
    newrun.verification = values[(values.indexOf(newrun.verification) + 1) % values.length]!;
    enforceLockedSkills(true);
  };

  /**
   * Skills the current mode requires. verified-testing carries the TDD
   * discipline that Verify promises; excluding it would silently downgrade
   * the mode, so the composer refuses and submit re-admits it.
   */
  const lockedSkills = (): string[] =>
    newrun.verification === "verified" ? ["verified-testing"] : [];

  /** Re-admit mode-locked skills excluded under a previous mode. */
  const enforceLockedSkills = (announce: boolean): void => {
    let fixed = false;
    for (const name of lockedSkills()) {
      if (newRunSkillModes.get(name) === "exclude") {
        newRunSkillModes.delete(name);
        fixed = true;
      }
      if (newRunContextExcluded.delete(`skill:${name}`)) fixed = true;
    }
    if (fixed && announce) notify("verified-testing is required by Verify; switch to Direct to exclude it");
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
    // Everything below depends on the repo/packet, not on the text being typed.
    // Cache it for the duration of an insert session so keystrokes stay cheap.
    const skillModesKey = [...newRunSkillModes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(",");
    const includedFilesKey = [...newRunContextIncluded].filter((key) => key.startsWith("file:")).sort().join(",");
    const previewKey = `${newRunRepo}\0${newrun.packet ?? ""}\0${newrun.agent}\0${newrun.verification}\0${newrun.worktree ? "wt" : "main"}\0${skillModesKey}\0${includedFilesKey}`;
    const previewTtl = newRunInsert ? 60_000 : 5_000;
    if (
      !newRunPreviewCache ||
      newRunPreviewCache.key !== previewKey ||
      Date.now() - newRunPreviewCache.at > previewTtl
    ) {
      const statuses = providerStatuses(createModelsCollection());
      const machine = (() => { try { return loadMachineConfig(newRunLayout); } catch { return undefined; } })();
      newRunPreviewCache = {
        key: previewKey,
        at: Date.now(),
        context: previewContext(newRunLayout, "", {
          agent: newrun.agent,
          ...(newrun.packet ? { packet: newrun.packet } : {}),
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
    const previewPacket = newrun.packet ? readPacketFile(newRunLayout, newrun.packet) : null;
    const previewPrompt =
      newrun.prompt.trim() ||
      (previewPacket ? previewPacket.deliverable : "");
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
        ask: newrun.ask,
        approval: newrun.approval,
        ambiguity: newrun.ambiguity,
      },
    });
    const toolChars = toolSchemaChars(resolved.def.tools);
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
    if (newrun.prompt.trim().length === 0 && !newrun.packet) {
      notify("type a task before starting");
      return null;
    }
    const modelState = modelPreview();
    if (modelState.error) {
      notify(`no model is ready: ${modelState.error}`);
      return null;
    }
    const policy = effectivePolicy(newRunRepo);
    const args = [
      "run",
      "--agent", newrun.agent,
      ...(newrun.model ? ["--model", newrun.model] : []),
      "--tier", newrun.tier,
      "--preset", newrun.preset,
      "--verify", newrun.verification,
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
    if (newrun.packet) {
      args.push("--packet", newrun.packet);
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
    // Authoritative guard: locked skills survive any path that excluded them.
    enforceLockedSkills(false);
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
      (page === "runs" && (screen === "list" || screen === "run"));
    const allRuns = needRunData ? listAllRuns(l.home).filter((run) => !deletingRuns.has(run.id)) : [];
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

    const scopedRuns = runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
    const filteredRuns = runsListScreen ? scopedRuns : [];
    const runIndex = buildRunIndex({
      runs: filteredRuns,
      group: runsGroup,
      collapsed,
      text: runsText,
      attentionOnly: runsAttention,
      preferredRepo: l.repoRoot,
      ...(runsGroup === "packets"
        ? { packetRepo: l.repoRoot, packets: listPacketFiles(l), planCategories: planCategories(l) }
        : {}),
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
          const tone = row.tone === "status" ? Y : row.tone === "orphaned" ? Y : GR;
          const text = ` ${indent}${B}${theme.sectionFg}${tone}${row.collapsed ? "▸" : "▾"} ${row.label}${R} ${D}(${row.count})${R}`;
          rendered.push(isSelected ? selected(text, true) : background(fit(text, cols), theme.sectionBg));
        } else if (row.kind === "packet") {
          const status = row.packet.status;
          const tone = status === "in-progress" ? C : status === "blocked" ? Y : status === "done" ? G : D;
          const glyph = status === "in-progress" ? "●" : status === "blocked" ? "⏸" : status === "done" ? "✓" : "○";
          const left = `${indent}${row.collapsible ? (row.collapsed ? "▸" : "▾") : " "} ${glyph} ${tone}${row.slug}${R} ${D}[${status}]${R}`;
          const runs = row.directRuns > 0 ? `${D}${row.directRuns} run${row.directRuns === 1 ? "" : "s"}${R}` : "";
          const detail = `${D}${trunc(row.packet.deliverable, Math.max(12, cols - indent.length - 34))}${R}`;
          const text = ` ${pad(left, Math.max(20, cols - visible(`${runs}  ${detail}`) - 2))}${runs}  ${detail}`;
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
        if (focus && !focus.has(row.id) && row.kind === "run") {
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
          ]);
      extraActions = joinCommands([
        command("g", "Group", RUN_GROUP_LABELS[runsGroup], C),
        command("f", "Repos", runsRepoScope === "all" ? "all" : "cwd", M),
        command("D", "Delete", undefined, RED),
      ]);
      if (toast) secondary = `${Y}${toast}${R}`;
    }

    /* ----------------------------------------------------------- delete */
    else if (screen === "delete") {
      if (!deleteRunTarget) {
        screen = deleteReturn;
        return draw();
      }
      {
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
      }
    }

    /* ---------------------------------------------------------- new run */
    else if (screen === "newrun") {
      footerMapTokens = mapStatusTokens(newRunRepo);
      footerBandTone = theme.bodyBg;
      const preview = modelPreview();
      const ctx = preview.context;
      const ap = preview.policy?.agents[newrun.agent];
      const newRunPacketFile = newrun.packet ? readPacketFile(layout(newRunRepo), newrun.packet) : null;
      const packetValue = newrun.packet ?? "NA";
      const displayAgent = newrun.agent ? `${newrun.agent[0]!.toUpperCase()}${newrun.agent.slice(1)}` : newrun.agent;
      const resolvedAgent = resolveAgent(layout(newRunRepo), newrun.agent, {
        agentPolicy: ap,
        machineOverrides: preview.machine?.agents[newrun.agent],
        runOverrides: {
          preset: newrun.preset,
          verification: newrun.verification === "redundant" ? "verified" : newrun.verification,
          worktree: newrun.worktree,
          ask: newrun.ask,
          approval: newrun.approval,
          ambiguity: newrun.ambiguity,
        },
      });
      const packetOutcome = (() => {
        if (newrun.packet) {
          if (!newRunPacketFile) return "packet file is missing";
          return `ready · ${newRunPacketFile.status} · gate ${newRunPacketFile.review ?? "gates"}`;
        }
        return "no packet · run is untracked";
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
        resolvedAgent.def.tools,
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
      // Attached references first, then every store bundle as
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
      // Space cycles include → on-demand → exclude. Mode-locked skills show
      // · required and cannot cycle to exclude. Tags sit right after the name
      // so row truncation cannot hide them. Active modes sort first.
      const locked = new Set(lockedSkills());
      const tagLocked = (text: string, tags: string[]): string => {
        if (tags.length === 0) return text;
        const insert = ` · ${tags.join(" · ")}`;
        const sep = text.indexOf(" · ");
        return sep < 0 ? text + insert : text.slice(0, sep) + insert + text.slice(sep);
      };
      newRunSkillShown.clear();
      for (const item of skillItems) {
        const name = item.key.slice("skill:".length);
        const mode = skillModeOf(name);
        newRunSkillShown.set(name, mode);
        const tags: string[] = [];
        if (mode === "include") {
          item.chars += bodyChars.get(name) ?? 0;
          tags.push("body");
        } else if (mode === "on-demand") {
          tags.push("on-demand");
        }
        if (locked.has(name)) tags.push("required");
        item.text = tagLocked(item.text, tags);
        bodyChars.delete(name);
      }
      for (const [name, chars] of bodyChars) {
        const mode = skillModeOf(name);
        newRunSkillShown.set(name, mode);
        if (mode === "exclude") continue;
        const tags: string[] = [mode === "include" ? "body" : "on-demand"];
        if (locked.has(name)) tags.push("required");
        skillItems.push({
          text: tagLocked(name, tags),
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
        `${D}${command("f", "fit", fitText, C)}  ${command("F", "floors", floorsText, M)}  ${command("t", "Tier", displayTier, tierTone(newrun.tier))}${R}`,
        Math.max(10, cols - 1),
      );
      const minimumsInfo = ` ${" ".repeat(Math.max(0, cols - visible(minimumsText) - 1))}${minimumsText}`;
      const packetSource = ctx.sources.find((source) => source.kind === "packet");
      const packetItems: ContextPanelItem[] = [];
      for (const packet of listPacketFiles(newRunLayout)) {
        const selected = newrun.packet === packet.slug;
        packetItems.push({
          text:
            `${packet.slug} · ${trunc(packet.deliverable || "(no deliverable)", Math.max(12, cols - 40))} ` +
            `[${packet.status}]` +
            (selected ? " · selected" : ""),
          chars: selected ? (packetSource?.chars ?? 0) : 0,
          exists: true,
          key: `packet:${packet.slug}`,
          ...(selected ? {} : { available: true, counted: false }),
        });
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
        { label: "Packets", tone: Y, sectionKey: "section:packets", items: packetItems },
        { label: "Plans", tone: contextTone("plan"), sectionKey: "section:plans", items: itemsFor(["plan", "project"]) },
        { label: "Knowledge", tone: contextTone("knowledge"), sectionKey: "section:knowledge", items: knowledgeItems },
        { label: "Skills", tone: contextTone("skill"), sectionKey: "section:skills", items: skillItems },
        { label: "Scripts", tone: contextTone("script"), sectionKey: "section:scripts", items: scriptItems },
        { label: "Tools", tone: contextTone("tool"), sectionKey: "section:tools", items: toolItems },
        { label: "Codebase", tone: BL, sectionKey: "section:codebase", items: codebaseItems },
        { label: "References", tone: contextTone("reference"), sectionKey: "section:references", items: referenceItems },
        { label: "Agent Prompt", tone: W, sectionKey: "section:prompt", items: promptItems },
        { label: "Files", tone: C, sectionKey: "section:files", items: fileItems },
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
      const packetHint = activeSection.sectionKey === "section:packets"
        ? panelLine(` ${D}${packetOutcome}${R}`, false, true)
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
          !newRunInsert && activeSection.sectionKey === "section:packets"
            ? command("i", "Packet", packetValue, newrun.packet ? C : GR)
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
        ...(packetHint ? [packetHint] : []),
        ...(itemLines.length ? itemLines : [panelLine(`  ${D}none${R}`)]),
      ];
      if (ctx.warnings.length > 0) summary.push(` ${Y}${ctx.warnings[0]}${R}`);

      const boxWidth = panelWidth;
      const inner = Math.max(12, boxWidth - 2);
      const promptText = newrun.prompt || (newRunInsert ? "" : newrun.packet ? "Press :! to run the packet" : "Press p to type the task");
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
            newrun.prompt.trim() || newrun.packet ? commandBadge("Start", ":!", START_BG, WHITE) : "",
          ]);
      const agentControls = newRunInsert
        ? ""
        : joinCommands([
            command("a", "Agent", displayAgent, agentTone(newrun.agent)),
            ...(agentIsolates(newrun.agent)
              ? [
                  command("v", "Verify", newrun.verification === "verified" ? "Verified" : "Direct", C),
                  command("w", "Worktree", newrun.worktree ? "on" : "off", newrun.worktree ? G : D),
                ]
              : []),
            command("g", "Ambiguity", newrun.ambiguity, M),
          ]);
      const runControls = newRunInsert
        ? promptActions
        : joinCommands([
            promptActions,
          ]);
      const promptHint =
        !agentControls && !runControls
          ? ""
          : ` ${agentControls}${" ".repeat(Math.max(1, boxWidth - visible(agentControls) - visible(runControls) - 1))}${runControls}`;
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
      } else if (packetPick === "newrun") {
        const list = pickerPackets();
        if (packetPickSel >= list.length) packetPickSel = Math.max(0, list.length - 1);
        const picker: string[] = [` ${command("Esc", "Back", undefined, GR)}  ${B}${W}Link a packet${R} ${D}(type to filter; Enter selects)${R}`, ""];
        for (let i = 0; i < list.length; i++) {
          const packet = list[i]!;
          const isSelected = newrun.packet === packet.slug;
          const line = ` ${isSelected ? C + "▸" : " "} ${C}${packet.slug}${R} ${D}[${packet.status}]${R} ${W}${trunc(packet.deliverable || "(no deliverable)", Math.max(12, cols - packet.slug.length - 24))}${R}`;
          picker.push(selected(line, i === packetPickSel));
        }
        picker.push("", ` ${D}filter: ${packetPickText || "(all)"}${R}`);
        body = clipBody(picker.slice(0, bodyH));
        actions = joinCommands([
          command("Enter", "Select", undefined, G),
          command("j/k", "Move", undefined, M),
          command("Esc", "Close", undefined, GR),
        ]);
        secondary = `${D}${list.length} packet(s)${packetPickText ? ` · “${packetPickText}”` : ""}${R}`;
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
        // Agent, verify, worktree, and ambiguity controls sit left-aligned
        // beside the prompt; Prompt/Start stay right-aligned. Tier moved to
        // the top fit line. The bottom footer has no command row.
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
          const headerText = fit(` ${B}${theme.sectionFg}${marker} ${group.key}${R} ${D}(${group.rows.length})${R}`, cols);
          // A focused header gets the same BG selection as model rows; the
          // section background is reserved for the idle state so selection
          // stays obvious instead of drowning in the panel color.
          lines.push(
            isSelected ? selected(headerText, true) : background(headerText, theme.sectionBg),
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
      // Vetoed rows never enter the catalogue; list them dimmed with their
      // reason so a missing model is explainable in place (curation.toml).
      const vetoed = [...loadCuration(l).models.entries()].filter(([, entry]) => entry.veto === true);
      const vetoQuery = modelText.trim().toLowerCase();
      const shownVetoed = vetoed.filter(([key]) => vetoQuery.length === 0 || key.toLowerCase().includes(vetoQuery));
      if (shownVetoed.length > 0) {
        lines.push("", ` ${D}Vetoed (${shownVetoed.length}) — excluded by ~/.machine_code/curation.toml; remove the stanza to restore${R}`);
        for (const [key, entry] of shownVetoed) {
          const why = [entry.source ?? entry.note, entry.date].filter((part) => part && part.length > 0).join(" · ");
          lines.push(`  ${GR}✕ ${key}${R}${why ? ` ${D}${trunc(why, Math.max(10, cols - key.length - 8))}${R}` : ""}`);
        }
      }
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

    /* ---------------------------------------------------------- packet */
    else if (page === "runs" && screen === "packet") {
      const slug = selectedPacketSlug;
      const packet = slug ? readPacketFile(l, slug) : null;
      const lines: string[] = [];
      if (!packet || !slug) {
        lines.push("", ` ${Y}packet not found${R}`);
      } else {
        lines.push(` ${B}${W}${slug}${R}  ${D}[${packet.status}]  gate ${packet.review ?? "gates"}${R}`);
        lines.push(` ${W}${packet.deliverable || "(no deliverable)"}${R}`);
        if (packet.deps.length > 0) lines.push(` ${D}deps: ${packet.deps.join(", ")}${R}`);
        if (packet.files.length > 0) {
          lines.push(` ${D}files:${R}`);
          for (const file of packet.files) lines.push(`   ${C}${file}${R}`);
        }
        if (packet.acceptance.length > 0) lines.push(` ${D}acceptance: ${packet.acceptance.join("; ")}${R}`);
        lines.push(` ${D}verify: ${packet.verify.length ? packet.verify.join(", ") : "(none)"}${R}`);
        const runs = allRuns.filter((run) => run.packetId === slug);
        lines.push("", ` ${B}runs${R} ${D}(${runs.length})${R}`);
        for (const run of sortRuns(runs, "activity")) {
          lines.push(`   ${W}${run.id.slice(-8)}${R} ${D}${run.agent}${R} ${run.status}${run.error ? ` ${Y}${trunc(run.error, 40)}${R}` : ""}`);
        }
      }
      const w = selectableLines(lines, packetScroll, packetScroll, bodyH);
      packetScroll = w.scroll;
      body = clipBody(w.lines);
      actions = joinCommands([
        command("g", "Gate", packet?.review ?? "gates", packet?.review === "agent" ? C : packet?.review === "human" ? Y : D),
        command("o", "Orchestrate", undefined, GR),
        command("b", "Build", undefined, C),
        command("a", "Approve", undefined, G),
        command("d", "Delete", undefined, RED),
        command("esc", "Back"),
      ]);
      secondary = slug ? `${D}packets/${slug}.md${toast ? ` · ${Y}${toast}${R}` : ""}${R}` : "";
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
        // Related runs honor the repo scope: the panel must not resurrect
        // rows the list hides when the human filtered to the cwd. The Enter
        // handler below selects from the same scoped list, so navigation and
        // rendering agree.
        const relatedList = relatedRuns(scopedRuns, s);
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
        const prMeta = [s.packetId ? `${s.packetId}` : "", s.prNumber ? `PR #${s.prNumber} ${s.prState ?? ""}` : ""]
          .filter(Boolean)
          .join("  ");
        if (prMeta) lines.push(` ${D}${prMeta}${R}`);
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
        ` ${D}This interrupts the current run and starts a fresh child with the parent's${R}`,
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

  /* ------------------------------------------------------------ packet modal helpers */

  /* ------------------------------------------------------------ packet modal helpers */

  const startPacketPicker = () => {
    packetPick = "newrun";
    packetPickSel = 0;
    packetPickText = "";
  };

  const pickerPackets = () => {
    const needle = packetPickText.trim().toLowerCase();
    const packets = listPacketFiles(layout(newRunRepo));
    if (!needle) return packets;
    return packets.filter((packet) =>
      `${packet.slug} ${packet.deliverable} ${packet.status}`.toLowerCase().includes(needle),
    );
  };

  const choosePacket = (packet: PacketFile) => {
    const previousPacket = newrun.packet ? readPacketFile(layout(newRunRepo), newrun.packet) : null;
    const previousPrompt = previousPacket?.deliverable ?? "";
    const hadPacket = Boolean(newrun.packet);
    newrun.packet = packet.slug;
    // A blank composer that was opened with `N` still starts as research. Once
    // a packet is attached, default to the agent that does the work.
    if (!hadPacket && newrun.agent === "research") {
      newrun.agent = "build";
      newrun.verification = agentIsolates(newrun.agent) ? "verified" : "direct";
      newrun.worktree = true;
      enforceLockedSkills(true);
    }
    if (!newrun.prompt.trim() || (previousPrompt && newrun.prompt === previousPrompt)) {
      newrun.prompt = packet.deliverable || packet.slug;
    }
    packetPick = null;
    notify(`linked ${packet.slug}; ready · ${packet.status} · gate ${packet.review ?? "gates"}`);
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

  /* ------------------------------------------------------------- input */

  const handleKey = (data: string) => {
    if (data === "\x03") {
      cleanup();
      process.exit(0);
    }

    // Text-entry modes take precedence over global navigation.
    if (screen === "delete") {
      if (data === "\x1b") { deleteRunTarget = undefined; screen = deleteReturn; draw(); return; }
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
      if (packetPick === "newrun") {
        if (data === "\x1b") { packetPick = null; draw(); return; }
        if (data === "\x1b[A" || data === "k") { packetPickSel = Math.max(0, packetPickSel - 1); draw(); return; }
        if (data === "\x1b[B" || data === "j") { const list = pickerPackets(); packetPickSel = Math.min(Math.max(0, list.length - 1), packetPickSel + 1); draw(); return; }
        if (data === "\r" || data === "\n") { const list = pickerPackets(); const picked = list[packetPickSel]; if (picked) choosePacket(picked); draw(); return; }
        if (data === "\x7f" || data === "\b") { packetPickText = packetPickText.slice(0, -1); packetPickSel = 0; draw(); return; }
        if (!data.startsWith("\x1b")) { packetPickText += printable(data); packetPickSel = 0; draw(); return; }
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
        if (key && key.startsWith("packet:")) {
          const slug = key.slice("packet:".length);
          const packet = readPacketFile(layout(newRunRepo), slug);
          if (packet) choosePacket(packet);
          else notify(`packet ${slug} is missing`);
          draw();
          return;
        }
        if (key && key.startsWith("skill:")) {
          // Three modes cycle: include (body inlined) → on-demand
          // (description only, pulled with the skill tool) → exclude.
          const name = key.slice("skill:".length);
          const current = newRunSkillShown.get(name) ?? "on-demand";
          const next: SkillMode = current === "include" ? "on-demand" : current === "on-demand" ? "exclude" : "include";
          if (next === "exclude" && lockedSkills().includes(name)) {
            notify("verified-testing is required by Verify; switch to Direct to exclude it");
            draw();
            return;
          }
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
      if (data === "v") {
        if (!agentIsolates(newrun.agent)) { notify("verify is build-only"); draw(); return; }
        cycleVerify(); draw(); return;
      }
      if (data === "w") {
        if (!agentIsolates(newrun.agent)) { notify("worktree is build-only"); draw(); return; }
        newrun.worktree = !newrun.worktree; draw(); return;
      }
      if (data === "g") { cycleAmbiguity(); draw(); return; }
      if (data === "f") { cycleMinFit(); draw(); return; }
      if (data === "F") { cycleFloors(); draw(); return; }
      if (data === "i" && newRunContextSectionKey === "section:packets") { startPacketPicker(); draw(); return; }
      if (data === "m") { startModelPicker(); draw(); return; }
      if (data === "e" || data === "p") { newRunInsert = true; draw(); return; }
      if (data === "X" && newrun.packet) { newrun.packet = undefined; draw(); return; }
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
      const scopeFiltered = runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
      const index = buildRunIndex({
        runs: scopeFiltered,
        group: runsGroup,
        collapsed,
        text: runsText,
        attentionOnly: runsAttention,
        preferredRepo: l.repoRoot,
        ...(runsGroup === "packets"
          ? { packetRepo: l.repoRoot, packets: listPacketFiles(l), planCategories: planCategories(l) }
          : {}),
      });
      const repoForRow = (row: RunRow | undefined): string => {
        if (!row) return l.repoRoot;
        if (row.kind === "repo") return row.repoRoot;
        if (row.kind === "run") return repoOf(row.run);
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
        // A run is a leaf; space on it folds the parent packet/section/repo.
        const target = row?.kind === "run" && row.parent
          ? index.rows.find((candidate) => candidate.id === row.parent)
          : row;
        if (
          target?.kind !== "section" &&
          target?.kind !== "repo" &&
          target?.kind !== "packet"
        ) return false;
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
        if (row?.kind === "run") { selectedRunId = row.run.id; runSection = "overview"; runScroll = 0; screen = "run"; }
        else if (row?.kind === "packet") {
          selectedPacketSlug = row.slug;
          packetScroll = 0;
          screen = "packet";
        }
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
        const packet = row?.kind === "packet" ? row.slug : row?.kind === "run" ? row.run.packetId : undefined;
        startNewRun(packet, repoForRow(row));
        draw();
        return;
      }
      if (data === "N") { startNewRun(undefined, l.repoRoot); draw(); return; }
      if (data === "D") {
        const row = index.selectable[runsSel];
        if (row?.kind !== "run") { notify("select a run to delete"); draw(); return; }
        deleteRunTarget = row.run;
        deleteReturn = "list";
        screen = "delete";
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
      if (data === "r") { draw(); return; }
      draw();
      return;
    }

    /* ------------------------------------------------------ packet keys */
    if (page === "runs" && screen === "packet") {
      const slug = selectedPacketSlug;
      const spawnCli = (args: string[], note: string): void => {
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: "ignore" }).unref();
        notify(note);
        draw();
      };
      if (data === "\x1b" || data === "q") { screen = "list"; draw(); return; }
      if (data === "\x1b[A" || data === "k") { packetScroll = Math.max(0, packetScroll - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { packetScroll += 1; draw(); return; }
      if (data === "g" && slug) {
        const packet = readPacketFile(l, slug);
        if (packet) {
          const order = ["gates", "agent", "human"] as const;
          const idx = order.indexOf((packet.review ?? "gates") as (typeof order)[number]);
          packet.review = order[(idx + 1) % order.length]!;
          writePacketFile(l, packet);
          void commitPlanningFiles(l, `plans: gate ${slug}`);
          notify(`${slug} gate → ${packet.review}`);
        }
        draw();
        return;
      }
      if (data === "o") { spawnCli(["batch"], "orchestration started (batch)"); return; }
      if (data === "b" && slug) { spawnCli(["build", slug], `build ${slug} started`); return; }
      if (data === "a" && slug) { spawnCli(["approve", slug], `approve ${slug} queued`); return; }
      if (data === "d" && slug) { spawnCli(["delete", slug], `delete ${slug} queued`); return; }
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
      if (data === "p") {
        const packet = detail.summary.packetId;
        if (!packet) { notify("run has no packet to approve"); draw(); return; }
        const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
        spawn(process.execPath, [cliPath, "approve", packet], { detached: true, stdio: "ignore" }).unref();
        notify(`approve ${packet} queued`);
        draw();
        return;
      }
      if (data === "D") {
        deleteRunTarget = detail.summary;
        deleteReturn = "run";
        screen = "delete";
        draw();
        return;
      }
      if (data === "\r" || data === "\n") {
        if (runSection === "timeline") toggleEvent();
        else if (runSection === "processes") {
          const record = reconcileProcessRecords(detail.dir)[processSel];
          if (!record) notify("no process selected");
          else openEditor(record.stdoutLog);
        }
        else if (runSection === "related") {
          const scopeRuns = runsRepoScope === "cwd"
            ? listAllRuns(l.home).filter((run) => run.repoRoot === l.repoRoot && !deletingRuns.has(run.id))
            : listAllRuns(l.home).filter((run) => !deletingRuns.has(run.id));
          const child = relatedRuns(scopeRuns, detail.summary)[childSel];
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

  // Packet picker overlay is drawn after the page body by replacing the body
  // bottom; keeping it in the draw path above avoids another navigation mode.
  const drawWithPicker = () => {
    const original = draw;
    void original;
    draw();
  };
  void drawWithPicker;

  let availabilityProbeAt = Date.now();
  setInterval(() => {
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

