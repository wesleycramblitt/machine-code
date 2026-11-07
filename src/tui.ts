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
import { listAllRuns, listProjects, readRun, type RunEvent, type RunSummary } from "./state/runs.js";
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
import { renderDeleteConfirm } from "./tui/screens/delete.js";
import { renderPacket } from "./tui/screens/packet.js";
import { modelWeightedFit, policyWeightsFor, renderModelDetail, renderModelsList } from "./tui/screens/models.js";
import { renderAnswer } from "./tui/screens/answer.js";
import { TABS, renderFooterRows, renderHeader, rightHeaderPath } from "./tui/screens/chrome.js";
import { renderComposer } from "./tui/screens/composer/composer.js";
import { renderCorrect } from "./tui/screens/correct.js";
import { renderRunDetail } from "./tui/screens/run-detail/run-detail.js";
import { RUN_SECTIONS, RUN_SECTION_LABEL, type RunSection } from "./tui/screens/run-detail/types.js";
import { renderRunsList } from "./tui/screens/runs-list.js";
import { renderSettings } from "./tui/screens/settings.js";
import { renderSpend } from "./tui/screens/spend.js";
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
/** Runs list repo scope: every known repo, or the TUI cwd only. */
type RunsRepoScope = "all" | "cwd";

const NEW_RUN_AGENTS = [...AGENT_NAMES];

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

    const chrome = renderHeader({
      cols, theme, page, screen, toast,
      runIndicators,
      statusTokens,
      modelCount: modelRows.length,
      modelFilter: modelText,
      newRunRepo,
      runsList: runsListScreen,
    });
    const header = chrome.header;
    const headerTone = chrome.headerTone;
    const backHeader = chrome.backHeader;
    const runDetailHeader = chrome.runDetailHeader;
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
      const frame = renderRunsList({
        cols, narrow, runNarrow, bodyH, theme, toast,
        index: runIndex,
        selectedRow,
        focus,
        group: runsGroup,
        reposScope: runsRepoScope,
        pendingFor: pendingForRun,
        scroll: runsScroll,
      });
      runsScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      extraActions = frame.extraActions;
      secondary = frame.secondary;
    }

    /* ----------------------------------------------------------- delete */
    else if (screen === "delete") {
      const frame = renderDeleteConfirm(deleteRunTarget, bodyH);
      if (!frame) {
        screen = deleteReturn;
        return draw();
      }
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ---------------------------------------------------------- new run */
    else if (screen === "newrun") {
      const frame = renderComposer({
        cols, narrow, bodyH, theme, toast,
        run: newrun,
        repoRoot: newRunRepo,
        home: l.home,
        insert: newRunInsert,
        cursor: newRunCursor,
        colon: newRunColon,
        contextTab: newRunContextTab,
        contextItem: newRunContextItem,
        contextFilter: newRunContextFilter,
        contextFiltering: newRunContextFiltering,
        excluded: newRunContextExcluded,
        included: newRunContextIncluded,
        skillModes: newRunSkillModes,
        skillShown: newRunSkillShown,
        preview: modelPreview(),
        pickers: {
          model: modelPick === null ? null : {
            entries: modelPickEntries,
            sel: modelPickSel,
            text: modelPickText,
            sort: modelPickSort,
          },
          packet: packetPick === null ? null : {
            text: packetPickText,
            sel: packetPickSel,
            list: pickerPackets(),
          },
        },
        agentIsolates,
        mapTokens: mapStatusTokens,
        lockedSkills,
      });
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
      secondaryStyled = frame.secondaryStyled;
      bottomAlign = frame.bottomAlign;
      footerMapTokens = frame.footerMapTokens;
      footerBandTone = frame.footerBandTone;
      footerCtx = frame.footerCtx;
      newRunContextTab = frame.contextTab;
      newRunContextSectionKey = frame.contextSectionKey;
      newRunContextItemKeys = frame.contextItemKeys;
      newRunContextItemAvailable = frame.contextItemAvailable;
      newRunContextItem = frame.contextItem;
      modelPickSel = frame.modelPickSel;
      packetPickSel = frame.packetPickSel;
    }

    /* ------------------------------------------------------------ model */
    else if (page === "models" && screen === "model" && selectedModelKey) {
      const frame = renderModelDetail({
        cols, narrow, bodyH, theme, toast,
        home: l.home,
        row: catalogueRows.find((row) => row.key === selectedModelKey),
        rows: catalogueRows,
        agent: newrun.agent,
        weights: policyWeightsFor(newrun.agent),
        probing: probingModels.has(selectedModelKey),
        scroll: modelScroll,
      });
      if (!frame) {
        screen = "list";
        return draw();
      }
      modelScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ----------------------------------------------------------- models */
    else if (page === "models" && screen === "list") {
      const frame = renderModelsList({
        cols, narrow, bodyH, theme, toast,
        home: l.home,
        repoRoot: l.repoRoot,
        rows: modelRows,
        group: modelGroup,
        collapsed: modelCollapsed,
        selected: modelSel,
        scroll: modelScroll,
        filterText: modelText,
        showAllProviders: modelsAll,
        freeOnly: modelsFree,
        codingOnly: modelsCoding,
        sort: modelSort,
        probing: probingModels,
      });
      modelDisplay = frame.display;
      modelSel = frame.selected;
      modelScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ------------------------------------------------------------ spend */
    else if (page === "spend") {
      const frame = renderSpend({
        cols, narrow, bodyH, theme, toast,
        home: l.home,
        daysWindow: spendDaysWindow,
        groupBy: spendBy,
        scroll: spendScroll,
      });
      spendScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* --------------------------------------------------------- settings */
    else if (page === "settings") {
      const frame = renderSettings({
        cols, narrow, bodyH, theme, toast,
        layout: l,
        rows: settingsRows,
        selectedIndex: settingsSel,
        scroll: settingsScroll,
      });
      settingsScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ---------------------------------------------------------- packet */
    else if (page === "runs" && screen === "packet") {
      const frame = renderPacket({
        cols, narrow, bodyH, theme, toast,
        slug: selectedPacketSlug,
        packet: selectedPacketSlug ? readPacketFile(l, selectedPacketSlug) : null,
        runs: allRuns,
        scroll: packetScroll,
      });
      packetScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ------------------------------------------------------------- run */
    else if (page === "runs" && screen === "run") {
      const detail = runDetailData();
      if (!detail) {
        body = [` ${RED}Run ${selectedRunId ?? "?"} no longer exists.${R}`];
        actions = command("Esc", "Back", undefined, GR);
      } else {
        const frame = renderRunDetail({
          cols, short, bodyH, theme,
          detail,
          scopedRuns,
          section: runSection,
          runScroll,
          processSel,
          processFollow,
          eventSel,
          eventScroll,
          eventBodyScroll,
          timelineFollow,
          timelineVerbose,
          thinkingScroll,
          thinkingFollow,
          childSel,
          expanded,
          changes: currentChanges(detail),
          mapTokens: mapStatusTokens,
        });
        body = frame.body;
        runCwd = frame.runCwd;
        runHints = frame.runHints;
        footerMapTokens = frame.footerMapTokens;
        footerCtx = frame.footerCtx;
        runScroll = frame.runScroll;
        processSel = frame.processSel;
        eventSel = frame.eventSel;
        eventScroll = frame.eventScroll;
        eventBodyScroll = frame.eventBodyScroll;
        thinkingScroll = frame.thinkingScroll;
        childSel = frame.childSel;
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
      const frame = renderAnswer({
        cols,
        bodyH,
        question: pending?.text ?? "(question text not recorded)",
        options: answerOptions.length > 0 ? answerOptions : pending?.options ?? [],
        answerText,
        scroll: answerScroll,
      });
      answerScroll = frame.scroll;
      answerPage = frame.page;
      answerOverflow = frame.overflow;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ---------------------------------------------------------- correct */
    else if (screen === "correct") {
      const detail = runDetailData();
      const frame = renderCorrect({
        cols,
        bodyH,
        correctText,
        parentId: detail ? detail.summary.id : null,
        parentWorktree: Boolean(detail?.summary.worktree),
      });
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    if (runDetailHeader && runCwd) header[1] = rightHeaderPath(cols, runCwd);

    /* ------------------------------------------------------------ compose */
    if (searchMode) {
      actions = joinCommands([
        command("/", "Search", searchText || "…", C),
        command("Enter", "Apply", undefined, G),
        command("Esc", "Cancel", undefined, GR),
      ]);
      secondary = `${D}filters ${page} · type to edit${R}`;
    }
    const footerRows = renderFooterRows({
      cols, narrow, theme, screen, hideFooter, runDetailHeader,
      runHints, extraActions, actions, secondary, secondaryStyled,
      footerCtx, footerMapTokens,
    });
    const commandRows = footerRows.commandRows;
    const secondaryRows = footerRows.secondaryRows;
    const bottomLines = footerRows.bottomLines;
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
      page = TABS[tabIndex - 1]!.id as Page;
      screen = "list";
      searchText = "";
      draw();
      return;
    }
    if (data === "\t") {
      const index = TABS.findIndex((tab) => tab.id === page);
      page = TABS[(index + 1) % TABS.length]!.id as Page;
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

function axisFloorText(axes: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined): string {
  return CAPABILITY_AXES.map((axis) => `${axis[0]!.toUpperCase()}${(axes?.[axis] ?? 0).toFixed(1)}`).join(" ");
}

