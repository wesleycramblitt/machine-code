/**
 * machine_code — TUI.
 *
 * Four durable pages (runs, models, spend, settings) plus focused
 * detail/composer screens. The frame contract is unchanged: exactly `rows`
 * lines, two header lines, two footer lines, content clipped to the middle.
 *
 * The TUI wraps the CLI's file/CLI primitives rather than inventing a second
 * source of truth. Every s.screen is derived from run summaries, the issue
 * catalog, the catalogue, config, and the spend ledger on each refresh.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout, type Layout } from "./paths.js";
import { findIssue, listIssues, type Issue } from "./plan/issues.js";
import { effectiveStatus } from "./plan/lifecycle.js";
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
import { createTuiState, type NewRunSeed, type NewRunState, type Page, type RunDetail, type RunsRepoScope, type Screen, type TuiState } from "./tui/state.js";
import { renderDeleteConfirm } from "./tui/screens/delete.js";
import { renderIssue } from "./tui/screens/issue.js";
import { policyWeightsFor, renderModelDetail, renderModelsList } from "./tui/screens/models.js";
import { renderAnswer } from "./tui/screens/answer.js";
import { TABS, renderFooterRows, renderHeader, rightHeaderPath } from "./tui/screens/chrome.js";
import { renderComposer } from "./tui/screens/composer/composer.js";
import { handleAnswerKeys } from "./tui/screens/answer-keys.js";
import { handleCorrectKeys } from "./tui/screens/correct-keys.js";
import { handleDeleteKeys } from "./tui/screens/delete-keys.js";
import { handleIssueKeys } from "./tui/screens/issue-keys.js";
import { handleSettingsKeys } from "./tui/screens/settings-keys.js";
import { handleSpendKeys } from "./tui/screens/spend-keys.js";
import type { KeyServices } from "./tui/screens/keys.js";
import { handleModelKeys, handleModelsListKeys } from "./tui/screens/models-keys.js";
import { handleRunsListKeys } from "./tui/screens/runs-list-keys.js";
import { handleComposerKeys } from "./tui/screens/composer/keys.js";
import { handleRunKeys } from "./tui/screens/run-detail/keys.js";
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
  SUBTAB_BG, START_BG, SYNC_OFF, SYNC_ON, trunc, type UiTheme, visible, W, WHITE,
  wrapCommands, wrapPlain, wrapText, wrapTokenList, WRAP_OFF, WRAP_ON, ZEBRA_BG,
} from "./tui/format.js";
import { describeTimelineEvent, describeToolArgs, isTimelineEvent, lastTimelineIndex, stepTimelineSelection, waitingForRun } from "./tui/timeline.js";
import { buildSettings, settingsFileFor, type SettingRow } from "./tui/settings.js";
import { forkSettingsFromRun, type ForkedRunSettings } from "./tui/fork.js";
import { loadMachineConfig, CAPABILITY_AXES, SELECTION_TIERS, type MachineConfig } from "./config.js";
import { axisWeights, capabilityFit, effectiveCallCost, estimateTokens, isMetaRouter, modelStatus, pick } from "./select.js";

import { loadAvailability, saveAvailability, type AvailabilityState } from "./availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "./availability/probe.js";
import { latestProcessRecords } from "./processes/registry.js";
import { skillListItems, toolListItems, tokensForChars } from "./tui/tools.js";
import { toolSchemaChars } from "./tools/schema.js";
import { readLogTail } from "./processes/logs.js";
import { reconcileProcessRecords } from "./processes/reconcile.js";
import { terminateAllProcesses, terminateProcessRecord } from "./processes/supervisor.js";
import { AGENT_META, AGENT_NAMES, agentDef, normalizeAgentName, roleSkillPresets } from "./agents.js";
import { resolveAgent, resolveAgentConfig } from "./agents/config.js";
import { createModelsCollection, providerStatuses } from "./models.js";
import { fundedProviderIds } from "./data.js";
import { loadCatalogue } from "./catalogue/load.js";
import { loadCuration } from "./catalogue/refresh.js";
import { filterModels, groupModels, siblingOffers, type ModelSort } from "./catalogue/query.js";
import type { CatalogueDocument, CatalogueRow } from "./catalogue/types.js";
import { previewContext, artifactPreview, type ContextPreview } from "./context/preview.js";
import { contextBudget } from "./context/budget.js";
import { skillMetas, defaultSkillsFor, resolveSkillMode, type SkillMode } from "./context/references.js";
import { listReferenceEntries } from "./references/store.js";
import { changesFor, contextUsage, readContextManifest, relatedRuns, thinkingChunks, touchedPaths, type ChangeSummary, type ThinkingChunk } from "./report/run.js";
import { artifactPath, listArtifacts, type ArtifactDef } from "./artifacts/registry.js";
import { readCachedMap, renderMapIndex, symbolCount } from "./map/deterministic.js";
import { serverAvailable } from "./lsp/index.js";
import { commitPlanningFiles } from "./tasks/planning.js";

/* Terminal primitives live in ./tui/format.js; imported above. */




const NEW_RUN_AGENTS = [...AGENT_NAMES];

/**
 * Min-fit ladder for `f` on the new-run page. No duplicates — `findIndex`
 * always hits the first match, so repeated values create infinite loops.
 * Sequence: role → 6 → step down by 0.25 to 4 → step up from 6.25 to 8.5 → 0.
 */
const NEW_RUN_MIN_FITS: Array<number | null | undefined> = [
  undefined,
  6, 5.75, 5.5, 5.25, 5, 4.75, 4.5, 4.25, 4,
  6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75, 8, 8.25, 8.5,
  0,
];




interface ChangesCache {
  runId: string;
  at: number;
  data: ChangeSummary;
}

/* Pure formatting helpers live in ./tui/format.js; mapStatusTokens stays here (filesystem/LSP). */

/** Compact codebase-index health tokens for bottom footers. */
function mapStatusTokens(root: string): string[] {
  const mapCached = existsSync(join(root, ".machine_code", "local", "cache", "map.json"));
  const lspReady = serverAvailable("typescript");
  return [
    `${mapCached ? G : Y}MAP${mapCached ? "✓" : "✗"}${R}`,
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

  const s = createTuiState(l.repoRoot);

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
    s.toast = message;
    s.toastAt = Date.now();
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
      s.pendingRunAt = Date.now();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const defaultNewRun = (): NewRunState => {
    const agent = "research";
    return {
      agent,
      approval: "human",
      ambiguity: "precise",
      tier: "paid",
      minFit: undefined,
      floors: "role",
      kind: "features",
      priority: "medium",
      tags: [],
      prompt: "",
    };
  };

  s.newrun = defaultNewRun();

  /** Roles that isolate in a worktree and expose the verify switch. */
  const agentIsolates = (agent: string): boolean => agent === "engineer";

  const resetNewRunUi = () => {
    s.newRunInsert = false;
    s.newRunCursor = 0;
    s.newRunColon = false;
    s.newRunContextTab = 0;
    s.newRunContextItem = 0;
    s.newRunContextItemKey = null;
    s.newRunContextFilter = "";
    s.newRunContextFiltering = false;
    s.newRunSkillModes.clear();
    s.newRunContextExcluded.clear();
    s.newRunContextIncluded.clear();
    s.newRunHints = true;
    s.newRunPreviewCache = null;
    s.newRunParentId = null;
    s.modelPick = null;
    s.modelPickSel = 0;
    s.modelPickText = "";
    s.modelPickEntries = [];
    s.itemPick = null;
    s.itemPickSel = 0;
    s.itemPickText = "";
  };

  const startNewRun = (itemSlug?: string, repoRoot = l.repoRoot, seed?: NewRunSeed) => {
    const previous = s.newrun;
    s.newRunRepo = repoRoot;
    const slug = itemSlug ?? seed?.item;
    const issue = slug ? findIssue(layout(repoRoot), slug) : undefined;
    const attached = issue ? slug : undefined;
    // An issue is the work item: ideas start research, features/bugs start
    // engineer. A seeded run names its own agent; blank runs keep the last.
    const preferredAgent = seed?.agent ?? (issue ? (issue.kind === "ideas" ? "research" : "engineer") : previous.agent);
    s.newrun = {
      ...defaultNewRun(),
      ...(preferredAgent ? { agent: preferredAgent } : {}),
      ...(attached ? { item: attached } : {}),
    };
    if (seed?.prompt) s.newrun.prompt = seed.prompt;
    else if (issue) s.newrun.prompt = issue.prompt || issue.slug || "";
    resetNewRunUi();
    // The issue file is the objective and is always explicit context.
    if (issue) s.newRunContextIncluded.add(`issue:${issue.rel}`);
    for (const name of seed?.skills ?? []) s.newRunSkillModes.set(name, "include");
    s.screen = "newrun";
  };

  const forkRun = (detail: RunDetail) => {
    const summary = detail.summary;
    if (summary.status === "created" || summary.status === "running" || summary.status === "awaiting_input") {
      notify(`interrupt ${summary.id.slice(-8)} before forking; its worktree is still active`);
      return;
    }
    const repoLayout = layout(summary.repoRoot);
    const candidate = normalizeAgentName(summary.agent);
    const agent = AGENT_NAMES.includes(candidate) ? candidate : "research";
    const policy = agentDefFor(summary.repoRoot);
    const machine = (() => {
      try { return loadMachineConfig(repoLayout); } catch { return undefined; }
    })();
    const defaults = resolveAgentConfig({
      role: agent,
      machineOverrides: machine?.agents[agent],
    });
    const configured = new Set(
      providerStatuses(createModelsCollection())
        .filter((status) => status.configured)
        .map((status) => status.id),
    );
    s.newRunRepo = summary.repoRoot;
    s.newrun = {
      ...forkSettingsFromRun({
        summary,
        events: detail.events,
        catalogue: loadCatalogue(repoLayout.catalogueFile),
        defaults,
        configuredProviders: configured,
      }),
    };
    // A legacy packet id is not an issue; do not attach a run to it.
    if (s.newrun.item && !findIssue(repoLayout, s.newrun.item)) {
      s.newrun.item = undefined;
    }
    // A generic inherited request ("Build the task.") hides the real objective.
    // When the run is attached to an issue, derive the request from it.
    const forkIssue = s.newrun.item ? findIssue(repoLayout, s.newrun.item) : null;
    if (forkIssue && (!s.newrun.prompt.trim() || isGenericTaskRequest(s.newrun.prompt))) {
      s.newrun.prompt = forkIssue.prompt || s.newrun.item || "";
    }
    resetNewRunUi();
    s.newRunParentId = summary.id;
    s.screen = "newrun";
    notify(`forked settings from ${summary.id.slice(-8)}; edit the request and start`);
  };

  const cycleAgent = () => {
    const previousAgent = s.newrun.agent;
    const index = NEW_RUN_AGENTS.indexOf(previousAgent);
    s.newrun.agent = NEW_RUN_AGENTS[(index + 1) % NEW_RUN_AGENTS.length] ?? previousAgent;
  };

  const cycleAmbiguity = () => {
    const values: NewRunState["ambiguity"][] = ["strict", "precise", "adaptive", "autonomous"];
    s.newrun.ambiguity = values[(values.indexOf(s.newrun.ambiguity) + 1) % values.length]!;
  };

  const cycleMinFit = () => {
    const index = NEW_RUN_MIN_FITS.findIndex((value) => value === s.newrun.minFit);
    s.newrun.minFit = NEW_RUN_MIN_FITS[(index + 1) % NEW_RUN_MIN_FITS.length];
  };

  const cycleFloors = () => {
    const floors: NewRunState["floors"][] = ["role", "strict", "off"];
    s.newrun.floors = floors[(floors.indexOf(s.newrun.floors) + 1) % floors.length]!;
  };

  const cycleTier = () => {
    const tiers: NewRunState["tier"][] = ["paid", "local"];
    s.newrun.tier = tiers[(tiers.indexOf(s.newrun.tier) + 1) % tiers.length]!;
  };

  const agentDefFor = (repoRoot = l.repoRoot): any => {
    const { agentDef } = require("./agents.js");
    return agentDef(layout(repoRoot), s.newrun.agent);
  };

  /**
   * Apply minFit and floors overrides to a copy of the agent def, so the
   * preview, picker, and CLI-args builder all use the same effective thresholds.
   */
  const effectiveDefForRun = (def: any) => {
    const effective = { ...def, minAxes: { ...(def.minAxes ?? {}) } };
    if (s.newrun.minFit !== undefined) effective.minFit = s.newrun.minFit ?? 0;
    if (s.newrun.floors === "off") {
      effective.minFit = 0;
      for (const axis of CAPABILITY_AXES) effective.minAxes[axis] = 0;
    }
    if (s.newrun.floors === "strict") {
      for (const axis of CAPABILITY_AXES) {
        const current = effective.minAxes[axis] ?? def.minFit;
        effective.minAxes[axis] = Math.min(10, Math.round((current + 0.5) * 10) / 10);
      }
    }
    return effective;
  };

  const modelPreview = (): {
    context: ContextPreview;
    model?: CatalogueRow;
    fit?: number;
    estimate?: { inputTokens: number; outputTokens: number };
    error?: string;
    machine?: MachineConfig;
  } => {
    const newRunLayout = layout(s.newRunRepo);
    const newRunIssue = s.newrun.item ? findIssue(newRunLayout, s.newrun.item) : null;
    // Everything below depends on the repo/issue, not on the text being typed.
    // Cache it for the duration of an insert session so keystrokes stay cheap.
    const skillModesKey = [...s.newRunSkillModes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(",");
    const includedFilesKey = [...s.newRunContextIncluded].filter((key) => key.startsWith("file:")).sort().join(",");
    const includedIssuesKey = [...s.newRunContextIncluded].filter((key) => key.startsWith("issue:")).sort().join(",");
    const previewKey = `${s.newRunRepo}\0${s.newrun.item ?? ""}\0${s.newrun.agent}\0${skillModesKey}\0${includedFilesKey}\0${includedIssuesKey}`;
    const previewTtl = s.newRunInsert ? 60_000 : 5_000;
    if (
      !s.newRunPreviewCache ||
      s.newRunPreviewCache.key !== previewKey ||
      Date.now() - s.newRunPreviewCache.at > previewTtl
    ) {
      const statuses = providerStatuses(createModelsCollection());
      const machine = (() => { try { return loadMachineConfig(newRunLayout); } catch { return undefined; } })();
      s.newRunPreviewCache = {
        key: previewKey,
        at: Date.now(),
        context: previewContext(newRunLayout, "", {
          agent: s.newrun.agent,
          knowledgeIndex: machine?.context.knowledgeIndex,
          files: [...s.newRunContextIncluded]
            .filter((key) => key.startsWith("file:"))
            .map((key) => key.slice("file:".length)),
          issues: [...s.newRunContextIncluded]
            .filter((key) => key.startsWith("issue:"))
            .map((key) => key.slice("issue:".length)),
          defaultSkills: defaultSkillsFor({
            agent: s.newrun.agent,
            verification: newRunIssue?.verification ?? "direct",
          }),
          skillPresets: roleSkillPresets(s.newrun.agent),
          skillOverrides: Object.fromEntries(s.newRunSkillModes),
        }),
        policy: agentDefFor(s.newRunRepo),
        machine,
        catalogue: loadCatalogue(newRunLayout.catalogueFile),
        configured: new Set(statuses.filter((status) => status.configured).map((status) => status.id)),
        availability: loadAvailability(l.home),
      };
    }
    const base = s.newRunPreviewCache;
    const previewIssue = newRunIssue;
    const previewPrompt =
      s.newrun.prompt.trim() ||
      (previewIssue ? previewIssue.prompt : "");
    const context: ContextPreview = { ...base.context, promptChars: previewPrompt.length };
    const machine = base.machine;
    const catalogue = base.catalogue;
    if (!machine || !catalogue) return { context, error: "configuration/catalogue unavailable", machine };
    const ap = machine.agents[s.newrun.agent];
    if (!ap) return { context, error: `unknown agent ${s.newrun.agent}`, machine };
    const resolved = resolveAgent(newRunLayout, s.newrun.agent, {
      machineOverrides: machine.agents[s.newrun.agent],
      runOverrides: {
        approval: s.newrun.approval,
        ambiguity: s.newrun.ambiguity,
      },
    });
    s.newRunRequiredSkills = [...resolved.def.requiredSkills];
    const toolChars = toolSchemaChars(resolved.def.tools);
    const effective = effectiveDefForRun(agentDefFor(s.newRunRepo));
    const select = (requireModel?: string) => pick({
      agent: s.newrun.agent,
      agentDef: effective,
      machine,
      catalogue: catalogue.models,
      configuredProviders: base.configured,
      availability: base.availability,
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: context.chars + context.promptChars + toolChars,
      requireModel,
      tier: s.newrun.tier,
    });
    let result = select(s.newrun.model);
    if ("error" in result && s.newrun.model) {
      // A fork or an earlier pick can leave a pin that is now cooling,
      // unfunded, or below this agent's floors. Prefer auto-selection over a
      // dead end, and say what happened.
      const pinned = s.newrun.model;
      const fallback = select(undefined);
      if (!("error" in fallback)) {
        s.newrun.model = undefined;
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
      const pin = s.newrun.model ? ` · pinned ${s.newrun.model}` : "";
      return {
        context,
        error: reasons ? `${result.error} (${reasons})${pin}` : `${result.error}${pin}`,
        machine,
      };
    }
    return {
      context,
      model: result.selected,
      fit: result.candidates.find((candidate) => candidate.key === result.selected.key)?.fit,
      estimate: result.estimate,
      machine,
    };
  };

  const buildNewRunArgs = (): string[] | null => {
    if (s.newrun.prompt.trim().length === 0 && !s.newrun.item) {
      notify("type a task before starting");
      return null;
    }
    // Validate git + remote before spawning.
    const buildRepoRoot = layout(s.newRunRepo).repoRoot;
    const gitVersion = spawnSync("git", ["--version"], { cwd: buildRepoRoot });
    if (gitVersion.error || gitVersion.status !== 0) {
      notify("git is required; install git and try again");
      return null;
    }
    const gitRemote = spawnSync("git", ["remote", "-v"], { cwd: buildRepoRoot });
    if (gitRemote.error || gitRemote.status !== 0 || !gitRemote.stdout.toString().trim()) {
      notify("no git remote; configure one with `git remote add origin <url>`");
      return null;
    }
    const modelState = modelPreview();
    if (modelState.error) {
      notify(`no model is ready: ${modelState.error}`);
      return null;
    }
    const policy = agentDefFor(s.newRunRepo);
    const args = [
      "run",
      "--agent", s.newrun.agent,
      ...(s.newrun.model ? ["--model", s.newrun.model] : []),
      "--tier", s.newrun.tier,
      "--approval", s.newrun.approval,
      "--ambiguity", s.newrun.ambiguity,
      ...(s.newRunParentId ? ["--parent", s.newRunParentId] : []),
    ];
    const previewPolicy = policy?.agents[s.newrun.agent];
    if (modelState.model && previewPolicy) {
      const budget = contextBudget(modelState.model.context, previewPolicy.expectedOutputTokens);
      args.push("--context-budget", String(budget.inputChars));
    }
    if (s.newrun.floors === "off") {
      args.push("--min-fit", "0");
    } else if (s.newrun.minFit !== undefined) {
      args.push("--min-fit", String(s.newrun.minFit ?? 0));
    }
    if (s.newrun.floors === "off") {
      args.push("--min-axes", "reasoning=0,code=0,agentic=0,general=0");
    } else if (s.newrun.floors === "strict") {
      const ap = policy?.agents[s.newrun.agent];
      const floors = CAPABILITY_AXES.map((axis) => {
        const current = ap?.minAxes?.[axis] ?? ap?.minFit ?? 6;
        return `${axis}=${Math.min(10, Math.round((current + 0.5) * 10) / 10)}`;
      });
      args.push("--min-axes", floors.join(","));
    }
    if (s.newrun.item) {
      args.push("--item", s.newrun.item);
    }
    if (s.newrun.kind) {
      args.push("--kind", s.newrun.kind);
    }
    if (s.newrun.priority) {
      args.push("--priority", s.newrun.priority);
    }
    if (s.newrun.tags && s.newrun.tags.length > 0) {
      args.push("--tags", JSON.stringify(s.newrun.tags));
    }
    const excludedSections = [...s.newRunContextExcluded]
      .filter((key) => key.startsWith("section:"))
      .map((key) => key.slice("section:".length));
    const excludedItems = [...s.newRunContextExcluded].filter((key) => !key.startsWith("section:"));
    if (excludedSections.length > 0 || excludedItems.length > 0) {
      args.push("--context-exclude", JSON.stringify({ sections: excludedSections, items: excludedItems }));
    }
    const includedFiles = [...s.newRunContextIncluded]
      .filter((key) => key.startsWith("file:"))
      .map((key) => key.slice("file:".length));
    const includedIssues = [...s.newRunContextIncluded]
      .filter((key) => key.startsWith("issue:"))
      .map((key) => key.slice("issue:".length));
    const includedKnowledge = [...s.newRunContextIncluded]
      .filter((key) => key.startsWith("knowledge:"))
      .map((key) => key.slice("knowledge:".length));
    const includedReferences = [...s.newRunContextIncluded]
      .filter((key) => key.startsWith("reference:"))
      .map((key) => key.slice("reference:".length));
    if (includedFiles.length > 0 || includedIssues.length > 0 || includedKnowledge.length > 0 || includedReferences.length > 0) {
      args.push("--context-include", JSON.stringify({
        ...(includedFiles.length > 0 ? { files: includedFiles } : {}),
        ...(includedIssues.length > 0 ? { issues: includedIssues } : {}),
        ...(includedKnowledge.length > 0 ? { knowledge: includedKnowledge } : {}),
        ...(includedReferences.length > 0 ? { references: includedReferences } : {}),
      }));
    }
    if (s.newRunSkillModes.size > 0) {
      args.push("--skill-modes", JSON.stringify(Object.fromEntries(s.newRunSkillModes)));
    }
    if (!s.newRunHints) {
      args.push("--hints", "false");
    }
    if (s.newrun.prompt.trim().length > 0) args.push(s.newrun.prompt);
    return args;
  };

  const submitNewRun = () => {
    s.newRunColon = false;
    const args = buildNewRunArgs();
    if (!args) return;
    if (launch(args, s.newRunRepo)) {
      notify("run started; opening it when the record appears");
      s.screen = "run";
      s.page = "runs";
      s.selectedRunId = null;
      // The 1s background tick is too coarse for run handoff. Repaint fast
      // until the record resolves so the run-details s.screen opens promptly.
      if (s.pendingFastTimer) clearInterval(s.pendingFastTimer);
      s.pendingFastTimer = setInterval(() => {
        if (s.pendingRunAt === 0) {
          if (s.pendingFastTimer) clearInterval(s.pendingFastTimer);
          s.pendingFastTimer = null;
          return;
        }
        if (Date.now() - s.pendingRunAt > 15_000) {
          if (s.pendingFastTimer) clearInterval(s.pendingFastTimer);
          s.pendingFastTimer = null;
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
    s.selectedRunId = detail.summary.id;
    s.answerQuestionId = pending.questionId;
    s.answerOptions = pending.options ?? [];
    s.answerText = "";
    s.answerScroll = 0;
    s.screen = "answer";
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
    s.selectedRunId = summary.id;
    s.correctText = "";
    s.screen = "correct";
  };

  const submitCorrection = () => {
    if (!s.selectedRunId || s.correctText.trim().length === 0) { notify("type a correction"); return; }
    const args = ["correct", s.selectedRunId, s.correctText];
    if (launch(args)) {
      notify("correction queued; opening the child run when it appears");
      s.screen = "list";
      s.page = "runs";
    }
  };

  const runDetailData = (): RunDetail | null => (s.selectedRunId ? findRunDetail(s.selectedRunId) : null);

  const currentChanges = (detail: RunDetail): ChangeSummary => {
    if (s.changesCache && s.changesCache.runId === detail.summary.id && Date.now() - s.changesCache.at < 4_000) {
      return s.changesCache.data;
    }
    const data = changesFor(detail.summary.worktree);
    s.changesCache = { runId: detail.summary.id, at: Date.now(), data };
    return data;
  };

  const searchSeed = (): string => {
    if (s.page === "runs") return s.runsText;
    if (s.page === "models") return s.modelText;
    return s.searchText;
  };

  const applySearch = () => {
    if (s.page === "runs") s.runsText = s.searchText;
    else if (s.page === "models") s.modelText = s.searchText;
    s.searchMode = false;
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
      s.pendingRunAt > 0 ||
      (s.page === "runs" && (s.screen === "list" || s.screen === "run" || s.screen === "issue"));
    const allRuns = needRunData ? listAllRuns(l.home).filter((run) => !s.deletingRuns.has(run.id)) : [];
    const counts = needRunData ? headerCounts(allRuns) : headerCounts([]);
    const settingsMachine = (() => { try { return loadMachineConfig(l); } catch { return undefined; } })();
    const theme = resolveTheme(settingsMachine?.theme);
    if (s.toast && Date.now() - s.toastAt > 8_000) s.toast = "";

    // Resolve a newly launched run before the header is built, so the first
    // frame already shows the run-detail chrome.
    if (s.pendingRunAt > 0) {
      const fresh = allRuns
        .filter((run) => new Date(run.startedAt).getTime() >= s.pendingRunAt - 1_500)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
      if (fresh) {
        s.selectedRunId = fresh.id;
        s.runSection = "overview";
        s.screen = "run";
        s.page = "runs";
        s.pendingRunAt = 0;
        notify(`opened new run ${fresh.id.slice(-8)}`);
      } else if (Date.now() - s.pendingRunAt > 15_000) {
        s.pendingRunAt = 0;
      }
    }

    const runsListScreen = s.page === "runs" && s.screen === "list";
    const runIndicators = [
      `${G}●${R} ${counts.active} running`,
      `${Y}!${R} ${counts.awaiting} awaiting`,
    ];
    const statusTokens: string[] = [];

    let catalogue: CatalogueDocument | null = null;
    let statuses: ReturnType<typeof providerStatuses> = [];
    if (s.page === "models") {
      try {
        const mtime = statSync(l.catalogueFile).mtimeMs;
        if (!s.catalogueCache || s.catalogueCache.mtime !== mtime) {
          s.catalogueCache = { mtime, doc: loadCatalogue(l.catalogueFile) };
        }
        catalogue = s.catalogueCache.doc;
      } catch {
        catalogue = loadCatalogue(l.catalogueFile);
      }
      if (!s.statusesCache || Date.now() - s.statusesCache.at > 5_000) {
        s.statusesCache = { at: Date.now(), statuses: providerStatuses(createModelsCollection()) };
      }
      statuses = s.statusesCache.statuses;
    }
    const activeProviders = new Set(statuses.map((status) => status.id));
    // Hide stale rows for providers that are disabled or no longer registered.
    const catalogueRows = (catalogue?.models ?? []).filter((row) => activeProviders.has(row.providerID));
    const configured = new Set(statuses.filter((status) => status.configured).map((status) => status.id));
    const modelRows = s.page === "models"
      ? filterModels(catalogueRows, {
          text: s.modelText,
          providers: s.modelsAll ? undefined : configured,
          codingOnly: s.modelsCoding,
          sort: s.modelSort,
          weights: policyWeightsFor(s.newrun.agent),
        })
      : [];
    if (s.modelSel >= modelRows.length) s.modelSel = Math.max(0, modelRows.length - 1);
    const selectedModel = modelRows[s.modelSel];

    const settingsPolicy = s.page === "settings" ? agentDefFor() : undefined;
    const settingsRows = s.page === "settings" ? buildSettings(l, settingsMachine, settingsPolicy) : [];
    if (s.settingsSel >= settingsRows.length) s.settingsSel = Math.max(0, settingsRows.length - 1);

    const chrome = renderHeader({
      cols, theme, page: s.page, screen: s.screen, toast: s.toast,
      runIndicators,
      statusTokens,
      modelCount: modelRows.length,
      modelFilter: s.modelText,
      newRunRepo: s.newRunRepo,
      runsList: runsListScreen,
    });
    const header = chrome.header;
    const headerTone = chrome.headerTone;
    const backHeader = chrome.backHeader;
    const runDetailHeader = chrome.runDetailHeader;
    // Prompt editing moves its controls into the body but keeps the model line.
    const hideFooter = s.screen === "newrun" && s.newRunInsert;
    const bodyH = Math.max(1, rows - header.length - footerReserve);

    const scopedRuns = s.runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
    const filteredRuns = runsListScreen ? scopedRuns : [];
    const workGroup = s.runsGroup === "all" || s.runsGroup === "category";
    const issuesByRepo: Record<string, readonly Issue[]> = {};
    for (const root of new Set([l.repoRoot, ...filteredRuns.map((run) => run.repoRoot)])) {
      issuesByRepo[root] = listIssues(layout(root));
    }
    const runIndex = buildRunIndex({
      runs: filteredRuns,
      group: s.runsGroup,
      collapsed: s.collapsed,
      text: s.runsText,
      attentionOnly: s.runsAttention,
      preferredRepo: l.repoRoot,
      ...(workGroup ? { issueRepo: l.repoRoot, issuesByRepo } : {}),
    });
    if (s.runsSel >= runIndex.selectable.length) s.runsSel = Math.max(0, runIndex.selectable.length - 1);
    const selectedRow = runIndex.selectable[s.runsSel];
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
    if (s.page === "runs" && s.screen === "list") {
      const frame = renderRunsList({
        cols, narrow, runNarrow, bodyH, theme, toast: s.toast,
        index: runIndex,
        selectedRow,
        focus,
        group: s.runsGroup,
        reposScope: s.runsRepoScope,
        pendingFor: pendingForRun,
        scroll: s.runsScroll,
      });
      s.runsScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      extraActions = frame.extraActions;
      secondary = frame.secondary;
    }

    /* ----------------------------------------------------------- delete */
    else if (s.screen === "delete") {
      const frame = renderDeleteConfirm(s.deleteTarget, bodyH);
      if (!frame) {
        s.screen = s.deleteReturn;
        return draw();
      }
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ---------------------------------------------------------- new run */
    else if (s.screen === "newrun") {
      const frame = renderComposer({
        cols, narrow, bodyH, theme, toast: s.toast,
        run: s.newrun,
        repoRoot: s.newRunRepo,
        home: l.home,
        insert: s.newRunInsert,
        confirm: s.newRunConfirm,
        cursor: s.newRunCursor,
        colon: s.newRunColon,
        contextTab: s.newRunContextTab,
        contextItem: s.newRunContextItem,
        contextItemKey: s.newRunContextItemKey,
        contextFilter: s.newRunContextFilter,
        contextFiltering: s.newRunContextFiltering,
        excluded: s.newRunContextExcluded,
        included: s.newRunContextIncluded,
        hintsEnabled: s.newRunHints,
        skillModes: s.newRunSkillModes,
        skillShown: s.newRunSkillShown,
        preview: modelPreview(),
        pickers: {
          model: s.modelPick === null ? null : {
            entries: s.modelPickEntries,
            sel: s.modelPickSel,
            text: s.modelPickText,
            sort: s.modelPickSort,
          },
          issue: s.itemPick === null ? null : {
            text: s.itemPickText,
            sel: s.itemPickSel,
            list: pickerIssues(),
          },
        },
        agentIsolates,
        mapTokens: mapStatusTokens,
      });
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
      secondaryStyled = frame.secondaryStyled;
      bottomAlign = frame.bottomAlign;
      footerMapTokens = frame.footerMapTokens;
      footerBandTone = frame.footerBandTone;
      footerCtx = frame.footerCtx;
      s.newRunContextTab = frame.contextTab;
      s.newRunContextSectionKey = frame.contextSectionKey;
      s.newRunContextItemKeys = frame.contextItemKeys;
      s.newRunContextItemAvailable = frame.contextItemAvailable;
      s.newRunContextItem = frame.contextItem;
      s.newRunContextItemKey = frame.contextItemKey;
      s.modelPickSel = frame.modelPickSel;
      s.itemPickSel = frame.itemPickSel;
    }

    /* ------------------------------------------------------------ model */
    else if (s.page === "models" && s.screen === "model" && s.selectedModelKey) {
      const frame = renderModelDetail({
        cols, narrow, bodyH, theme, toast: s.toast,
        home: l.home,
        row: catalogueRows.find((row) => row.key === s.selectedModelKey),
        rows: catalogueRows,
        agent: s.newrun.agent,
        weights: policyWeightsFor(s.newrun.agent),
        probing: s.probingModels.has(s.selectedModelKey),
        scroll: s.modelScroll,
      });
      if (!frame) {
        s.screen = "list";
        return draw();
      }
      s.modelScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ----------------------------------------------------------- models */
    else if (s.page === "models" && s.screen === "list") {
      const frame = renderModelsList({
        cols, narrow, bodyH, theme, toast: s.toast,
        home: l.home,
        repoRoot: l.repoRoot,
        rows: modelRows,
        group: s.modelGroup,
        collapsed: s.modelCollapsed,
        selected: s.modelSel,
        scroll: s.modelScroll,
        filterText: s.modelText,
        showAllProviders: s.modelsAll,
        codingOnly: s.modelsCoding,
        sort: s.modelSort,
        probing: s.probingModels,
      });
      s.modelDisplay = frame.display;
      s.modelSel = frame.selected;
      s.modelScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ------------------------------------------------------------ spend */
    else if (s.page === "spend") {
      const frame = renderSpend({
        cols, narrow, bodyH, theme, toast: s.toast,
        home: l.home,
        daysWindow: s.spendDaysWindow,
        groupBy: s.spendBy,
        scroll: s.spendScroll,
      });
      s.spendScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* --------------------------------------------------------- settings */
    else if (s.page === "settings") {
      const frame = renderSettings({
        cols, narrow, bodyH, theme, toast: s.toast,
        layout: l,
        rows: settingsRows,
        selectedIndex: s.settingsSel,
        scroll: s.settingsScroll,
      });
      s.settingsScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ----------------------------------------------------------- issue */
    else if (s.page === "runs" && s.screen === "issue") {
      const itemSlug = s.selectedIssueSlug;
      const issueLayout = layout(s.selectedIssueRepo ?? l.repoRoot);
      const issue = itemSlug ? findIssue(issueLayout, itemSlug) : undefined;
      const issueRuns = allRuns.filter((run) => run.repoRoot === issueLayout.repoRoot);
      const frame = renderIssue({
        cols, narrow, bodyH, theme, toast: s.toast,
        slug: itemSlug,
        issue: issue
          ? {
              slug: issue.slug,
              kind: issue.kind,
              status: effectiveStatus(issue, issueRuns),
              rel: issue.rel,
              priority: issue.priority,
              review: issue.review,
              verification: issue.verification,
              tags: issue.tags,
              depends: issue.depends,
              prompt: issue.prompt,
              acceptance: issue.acceptance,
              todo: issue.todo,
            }
          : null,
        runs: issueRuns,
        scroll: s.issueScroll,
      });
      s.issueScroll = frame.scroll;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ------------------------------------------------------------- run */
    else if (s.page === "runs" && s.screen === "run") {
      const detail = runDetailData();
      if (!detail) {
        body = ["   Run starting... (awaiting record)"]; // placeholder while pending
          actions = ""; // no actions until run appears
      } else {
        const frame = renderRunDetail({
          cols, short, bodyH, theme,
          detail,
          scopedRuns,
          section: s.runSection,
          runScroll: s.runScroll,
          processSel: s.processSel,
          processFollow: s.processFollow,
          eventSel: s.eventSel,
          eventScroll: s.eventScroll,
          eventBodyScroll: s.eventBodyScroll,
          timelineFollow: s.timelineFollow,
          timelineVerbose: s.timelineVerbose,
          thinkingScroll: s.thinkingScroll,
          thinkingFollow: s.thinkingFollow,
          childSel: s.childSel,
          expanded: s.expanded,
          changes: currentChanges(detail),
          mapTokens: mapStatusTokens,
        });
        body = frame.body;
        runCwd = frame.runCwd;
        runHints = frame.runHints;
        footerMapTokens = frame.footerMapTokens;
        footerCtx = frame.footerCtx;
        s.runScroll = frame.runScroll;
        s.processSel = frame.processSel;
        s.eventSel = frame.eventSel;
        s.eventScroll = frame.eventScroll;
        s.eventBodyScroll = frame.eventBodyScroll;
        s.thinkingScroll = frame.thinkingScroll;
        s.childSel = frame.childSel;
      }
    }

    /* ----------------------------------------------------------- answer */
    else if (s.screen === "answer") {
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
        options: s.answerOptions.length > 0 ? s.answerOptions : pending?.options ?? [],
        answerText: s.answerText,
        scroll: s.answerScroll,
      });
      s.answerScroll = frame.scroll;
      s.answerPage = frame.page;
      s.answerOverflow = frame.overflow;
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    /* ---------------------------------------------------------- correct */
    else if (s.screen === "correct") {
      const detail = runDetailData();
      const frame = renderCorrect({
        cols,
        bodyH,
        correctText: s.correctText,
        parentId: detail ? detail.summary.id : null,
        parentWorktree: Boolean(detail?.summary.worktree),
      });
      body = frame.body;
      actions = frame.actions;
      secondary = frame.secondary;
    }

    if (runDetailHeader && runCwd) header[1] = rightHeaderPath(cols, runCwd);

    /* ------------------------------------------------------------ compose */
    if (s.searchMode) {
      actions = joinCommands([
        command("/", "Search", s.searchText || "…", C),
        command("Enter", "Apply", undefined, G),
        command("Esc", "Cancel", undefined, GR),
      ]);
      secondary = `${D}filters ${s.page} · type to edit${R}`;
    }
    const footerRows = renderFooterRows({
      cols, narrow, theme, screen: s.screen, hideFooter, runDetailHeader,
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
      // Every s.page body uses the theme body color, so the surface is controllable.
      return background(fitted, theme.bodyBg);
    });
    process.stdout.write(SYNC_ON + WRAP_OFF + HOME + output.join("\n") + CLEAR_BELOW + WRAP_ON + SYNC_OFF);
  };

  /* ------------------------------------------------------------- issue modal helpers */

  /* ------------------------------------------------------------- issue modal helpers */

  const startIssuePicker = () => {
    s.itemPick = "newrun";
    s.itemPickSel = 0;
    s.itemPickText = "";
  };

  const pickerIssues = () => {
    const needle = s.itemPickText.trim().toLowerCase();
    const issues = listIssues(layout(s.newRunRepo));
    if (!needle) return issues;
    return issues.filter((issue) =>
      `${issue.slug} ${issue.prompt} ${issue.status} ${issue.kind}`.toLowerCase().includes(needle),
    );
  };

  const chooseIssue = (issue: Issue) => {
    const previousPrompt = s.newrun.item ? findIssue(layout(s.newRunRepo), s.newrun.item)?.prompt ?? "" : "";
    const hadItem = Boolean(s.newrun.item);
    s.newrun.item = issue.slug;
    // A blank composer that was opened with `N` still starts as research. Once
    // an issue is attached, default to the agent that does the work.
    const wanted = issue.kind === "ideas" ? "research" : "engineer";
    if (!hadItem && s.newrun.agent !== wanted) {
      s.newrun.agent = wanted;
    }
    if (!s.newrun.prompt.trim() || (previousPrompt && s.newrun.prompt === previousPrompt)) {
      s.newrun.prompt = issue.prompt || issue.slug;
    }
    s.newRunContextIncluded.add(`issue:${issue.rel}`);
    s.itemPick = null;
    notify(`linked ${issue.slug}; ${issue.status} · review ${issue.review}`);
  };

  const newRunWeights = () => {
    const policy = agentDefFor(s.newRunRepo);
    const ap = policy?.agents[s.newrun.agent];
    return ap ? axisWeights(s.newrun.agent, ap) : undefined;
  };

  const pickerModels = (): ModelPickerEntry[] => {
    const catalogue = loadCatalogue(layout(s.newRunRepo).catalogueFile);
    if (!catalogue) return [];
    const configured = new Set(
      providerStatuses(createModelsCollection())
        .filter((status) => status.configured)
        .map((status) => status.id),
    );
    const policy = agentDefFor(s.newRunRepo);
    const ap = policy?.agents[s.newrun.agent];
    const machine = (() => {
      try {
        return loadMachineConfig(layout(s.newRunRepo));
      } catch {
        return undefined;
      }
    })();
    if (!ap || !machine) return [];
    const effective = effectiveDefForRun(agentDefFor(s.newRunRepo));
    const availability = loadAvailability(l.home);
    const funded = fundedProviderIds(machine.providers);
    const weights = newRunWeights();
    const rows = filterModels(catalogue.models, {
      providers: configured,
      codingOnly: true,
      text: s.modelPickText,
      weights,
      sort: "fit",
    }).filter((row) => {
      if (s.newrun.tier === "local") return row.providerID === "ollama";
      if (s.newrun.tier === "paid") return row.providerID !== "ollama";
      return true;
    });
    const contextChars = (s.newRunPreviewCache?.context.chars ?? 0) + s.newrun.prompt.length + 2_000;
    const input = {
      agent: s.newrun.agent,
      agentDef: effective,
      machine,
      catalogue: rows,
      configuredProviders: configured,
      fundedProviders: funded,
      contextChars,
      tier: s.newrun.tier,
      availability,
    };
    const estimate = estimateTokens(contextChars, ap.expectedOutputTokens);
    const priceOf = (row: CatalogueRow): number =>
      effectiveCallCost(row, estimate.inputTokens, estimate.outputTokens, machine);
    const sortMode = s.modelPickSort;
    return rows
      .map((row): ModelPickerEntry => {
        const status = modelStatus(row, input);
        return {
          row,
          fit: weights ? capabilityFit(row.scores, weights) : row.scores.capability,
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
    s.modelPick = "newrun";
    s.modelPickText = "";
    s.modelPickEntries = pickerModels();
    const index = s.newrun.model
      ? s.modelPickEntries.findIndex((entry) => entry.row.key === s.newrun.model)
      : -1;
    s.modelPickSel = index >= 0 ? index + 1 : 0;
  };

  /* ------------------------------------------------------------- input */

  const keyCtx: KeyServices = {
    draw, notify, launch, openEditor, startNewRun, forkRun, answerRun,
    interrupt, startCorrect, submitCorrection, runDetailData, pendingForRun,
    cycleAgent, cycleAmbiguity, cycleMinFit, cycleFloors, cycleTier,
    startIssuePicker, pickerIssues, chooseIssue,
    pickerModels, startModelPicker, buildNewRunArgs, submitNewRun,
    agentIsolates, searchSeed,
    repoRoot: l.repoRoot,
  };

  const handleKey = (data: string) => {
    if (data === "\x03") {
      cleanup();
      process.exit(0);
    }

    // Text-entry modes take precedence over global navigation.
    if (s.screen === "delete") return handleDeleteKeys(s, keyCtx, data);
    if (s.screen === "answer") return handleAnswerKeys(s, keyCtx, data);
    if (s.screen === "correct") return handleCorrectKeys(s, keyCtx, data);
    if (s.screen === "newrun") return handleComposerKeys(s, keyCtx, data);

    if (s.searchMode) {
      if (data === "\x1b") { s.searchMode = false; s.searchText = ""; draw(); return; }
      if (data === "\r" || data === "\n") { applySearch(); draw(); return; }
      if (data === "\x7f" || data === "\b") { s.searchText = s.searchText.slice(0, -1); draw(); return; }
      if (!data.startsWith("\x1b")) { s.searchText += printable(data); draw(); return; }
      draw();
      return;
    }

    // Page switching.
    const tabIndex = Number(data);
    if (data.length === 1 && tabIndex >= 1 && tabIndex <= TABS.length) {
      s.page = TABS[tabIndex - 1]!.id as Page;
      s.screen = "list";
      s.searchText = "";
      draw();
      return;
    }
    if (data === "\t") {
      const index = TABS.findIndex((tab) => tab.id === s.page);
      s.page = TABS[(index + 1) % TABS.length]!.id as Page;
      s.screen = "list";
      s.searchText = "";
      draw();
      return;
    }
    if (data === "q") {
      if (s.screen !== "list") { s.screen = "list"; draw(); return; }
      if (s.page !== "runs") { s.page = "runs"; draw(); return; }
      cleanup();
      process.exit(0);
    }
    if (data === "\x1b") {
      if (s.screen !== "list") { s.screen = "list"; draw(); return; }
      if (s.page !== "runs") { s.page = "runs"; draw(); return; }
      cleanup();
      process.exit(0);
    }

    /* --------------------------------------------------------- runs keys */
    if (s.page === "runs" && s.screen === "list") return handleRunsListKeys(s, keyCtx, data);
    /* ------------------------------------------------------- issue keys */
    if (s.page === "runs" && s.screen === "issue") return handleIssueKeys(s, keyCtx, data);
    /* --------------------------------------------------------- run keys */
    if (s.page === "runs" && s.screen === "run") return handleRunKeys(s, keyCtx, data);

    /* ------------------------------------------------------- model keys */
    if (s.page === "models" && s.screen === "model") return handleModelKeys(s, keyCtx, data);
    /* ------------------------------------------------------- models list */
    if (s.page === "models") return handleModelsListKeys(s, keyCtx, data);
    /* ------------------------------------------------------- spend keys */
    if (s.page === "spend") return handleSpendKeys(s, keyCtx, data);
    /* ---------------------------------------------------- settings keys */
    if (s.page === "settings") return handleSettingsKeys(s, keyCtx, data);

    draw();
  };

  stdin.on("data", (chunk: string) => {
    // Terminal key repeat can deliver several keys in one read. Text entry
    // accepts the whole chunk (so pastes stay intact); navigation replays each
    // key so held j/k never get dropped.
    const textEntry =
      s.screen === "answer" ||
      s.screen === "correct" ||
      s.searchMode ||
      (s.screen === "newrun" && s.newRunInsert);
    if (textEntry && !chunk.includes("\x1b")) handleKey(chunk);
    else for (const key of splitKeys(chunk)) handleKey(key);
  });

  // Packet picker overlay is drawn after the s.page body by replacing the body
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
            if (!s.newRunInsert) draw();
          }
        } catch {
          // background availability refresh must never break the TUI
        }
      })();
    }
    // The composer repaints on input; background refreshes would only steal
    // frames from typing.
    if (!s.newRunInsert) draw();
  }, 1_000);
  process.stdout.on("resize", draw);
  draw();
  await new Promise(() => { /* run until exit */ });
}

/* ---------------------------------------------------------------- helpers */

function axisFloorText(axes: Partial<Record<"reasoning" | "code" | "agentic" | "general", number>> | undefined): string {
  return CAPABILITY_AXES.map((axis) => `${axis[0]!.toUpperCase()}${(axes?.[axis] ?? 0).toFixed(1)}`).join(" ");
}

