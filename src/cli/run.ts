/**
 * machine_code — CLI run execution lifecycle.
 *
 * Split from `src/cli.ts`; behavior unchanged. See `src/cli/common.ts` for
 * shared setup (flags, runtime, formatting, run lookup).
 */
import { existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../paths.js";
import { loadEnvFiles } from "../env.js";

import { createModelsCollection, availableChatModels, providerStatuses } from "../models.js";
import { refreshCatalogue } from "../catalogue/refresh.js";
import { loadCatalogue } from "../catalogue/load.js";
import { filterModels, siblingOffers, type ModelSort } from "../catalogue/query.js";
import { snapshotFiles } from "../catalogue/snapshot.js";
import { resolveSelectionContext, pickWithContext, pinViability } from "../select.js";

import type { CatalogueDocument, CatalogueRow } from "../catalogue/types.js";
// agents resolved inside orchestrate.ts
import { singleAgentRun } from "../orchestrate.js";
import { RunRecorder, listRuns, listAllRuns, registerProject, reconcileRun, pruneRuns, listProjects, sendControl, waitForControlAck, isPidAlive, isActiveStatus, type RunStatus, type RunSummary } from "../state/runs.js";
import { appendInbox, readInbox, latestUnansweredQuestion } from "../state/question.js";
import { summarizeRun, readStateView } from "../state/outcome.js";
import { isTimelineEvent } from "../tui/timeline.js";
import { loadTranscript, repairResumeTail } from "../state/transcript.js";
import { ENGINEER_WORK_STATUSES, appendIssueGateFailure, ensureIssueVerification, findIssue, gateFailureAttempts, kindTag, moveIssue, writeIssue } from "../plan/issues.js";
import { suggestHints, suggestTaskFilesFromMap, suggestionText, withKeywordTerms } from "../map/suggest.js";
import { defaultSkillsFor, skillMetas } from "../context/references.js";
import { commitPlanningFiles } from "../tasks/planning.js";
import { issueToTaskPacket, unmetDepends, unknownDepends, activeFileConflicts } from "../tasks/issue.js";
import { abortMergeIfInProgress, ensureCommitted, mergeBranchIntoMain } from "../tasks/merge.js";
import { slugify } from "../plan/slug.js";
import { runProc } from "../proc.js";
import { agentDef, normalizeAgentName, type AgentName } from "../agents.js";
import { resolveAgent, resolveAgentConfig, type AgentConfig } from "../agents/config.js";
import { runLoop, type RunLoopResult } from "../loop.js";
import { AGENT_NAMES } from "../agents.js";
import { gateFailureText, resolveGates, withSyncGate, type GateSpec } from "../verify.js";
import { allCommands } from "../commands/registry.js";
import { createWorktree, removeWorktree, pruneWorktrees, recreateWorktreeFromBranch, branchExists, branchCheckedOutAt, defaultBaseBranch, resolveBaseRef, mainWorktreeRoot, reusableWorktreeOwner, refreshReusedWorktree, WorktreeError } from "../worktree.js";
import { loadAvailability, saveAvailability } from "../availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "../availability/probe.js";

import { latestProcessRecords } from "../processes/registry.js";
import { readLogTail } from "../processes/logs.js";
import { reconcileProcessRecords } from "../processes/reconcile.js";
import { deleteRun } from "../state/run-delete.js";
import { ProcessSupervisor, terminateAllProcesses, terminateProcessRecord } from "../processes/supervisor.js";
import { filterRuns, sortRuns, type RunFilter } from "../tui/status.js";
import { readSpendSummary, spendDays, spendBar, type SpendBucket } from "../spend.js";
import { buildRunIndex, repoLabel, repoOf, type RunGroup, type RunRow } from "../tui/runs.js";
import { listArtifacts, artifactSummary, resolveArtifact, artifactPath, artifactExists } from "../artifacts/registry.js";
import { artifactPeek } from "../context/preview.js";
import { changesFor, contextUsage, exceededLimits, readContextManifest, relatedRuns, runMetrics, thinkingChunks, touchedPaths } from "../report/run.js";
import { buildSettings, settingsFileFor } from "../tui/settings.js";
import { fundedProviderIds, loadProviderDefinitions, packageDataDir } from "../data.js";
import { runTui } from "../tui.js";
import { SEARCH_EXCLUDES } from "../tools/safety.js";
import { BASE_CLIS, findOnPath, installClis, type InstallMethod } from "../install.js";
import { allServers, formatServerList, lspStatusForPaths, serverAvailable, serverForLanguage } from "../lsp/index.js";

import { fail, parseFlags, loadRuntime, findRunAnywhere, indentEventLines, printRunOutcome, toolResultText, EXIT, type Runtime } from "./common.js";
import { parseAxisOverrides } from "./models.js";

/** Update the local main branch from the remote. Non-blocking: if the remote is
 * unreachable the work continues with the local state. A divergence is
 * reported loudly (never forced): the run continues on local main. */
async function syncFromRemote(topRoot: string): Promise<void> {
  try {
    const { fastForwardMain } = await import("../tasks/sync.js");
    const synced = await fastForwardMain(topRoot);
    if (!synced.ok) process.stderr.write(`machine_code: main sync: ${synced.detail}\n`);
  } catch {
    // Remote unreachable — local main is good enough.
  }
}


export async function cmdRun(argv: string[]): Promise<number> {
  // Bare --worktree predates the true|false value; treat it as --worktree true.
  // Only fill in the value when no explicit value follows: rewriting every
  // `--worktree` unconditionally turned `--worktree false` into
  // `--worktree true false`, and the leftover leaked into the request as a
  // "true"/"false" prefix on every TUI run.
  argv = argv.flatMap((arg, i) =>
    arg === "--worktree" && (i + 1 >= argv.length || argv[i + 1]!.startsWith("--"))
      ? ["--worktree", "true"]
      : [arg],
  );
  const { flags, positional } = parseFlags(argv);
  const modeFlag = flags.get("mode");
  const agentName = flags.get("agent");
  const normalizedAgent = agentName === undefined ? undefined : normalizeAgentName(agentName);
  if (normalizedAgent !== undefined && !(AGENT_NAMES as readonly string[]).includes(normalizedAgent)) {
    fail(`unknown agent "${agentName}"; choose one of ${AGENT_NAMES.join(", ")}`);
  }
  let requireProvider = flags.get("provider");
  let requireModel = flags.get("model");
  const tierFlag = flags.get("tier") as "paid" | "local" | undefined;
  if (flags.get("packet") !== undefined) {
    fail("--packet was removed; attach the run to an issue with --item <slug>");
  }
  const itemFlag = flags.get("item");
  const baseFlag = flags.get("base");
  let request = positional.join(" ").trim();
  if (flags.has("issue") || flags.has("auto-issue")) {
    fail("issue tracking was removed; attach the run with --item <slug> instead");
  }

  // An item-attached run can derive its objective from the issue.
  // Only an untracked run needs the human to type one.
  if (request.length === 0 && itemFlag === undefined) {
    fail(`run needs a question or --item <slug>`);
  }

  // Run-level agent configuration overrides (Phase 3).
  const agentOverrides: Partial<AgentConfig> = {};
  const approvalFlag = flags.get("approval");
  if (approvalFlag !== undefined) {
    if (approvalFlag !== "human" && approvalFlag !== "agent") fail("--approval must be human|agent");
    agentOverrides.approval = approvalFlag;
  }
  const ambiguityFlag = flags.get("ambiguity");
  if (ambiguityFlag !== undefined) {
    const valid = ["strict", "precise", "adaptive", "autonomous"] as readonly string[];
    if (!valid.includes(ambiguityFlag)) fail(`--ambiguity must be one of ${valid.join(", ")}`);
    agentOverrides.ambiguity = ambiguityFlag as AgentConfig["ambiguity"];
  }
  // A detached delegated child runs a single agent directly (task tool spawn).
  const directExec = flags.has("direct-exec");

  const l = layout();

  // Require git with a configured remote.
  {
    const gitCheck = await runProc("git", ["--version"], { cwd: l.repoRoot, timeoutMs: 10_000 });
    if (gitCheck.outcome === "spawn-error" || gitCheck.code !== 0) {
      fail("git is required but not found. Install git and try again.");
    }
    const remoteCheck = await runProc("git", ["remote", "-v"], { cwd: l.repoRoot, timeoutMs: 10_000 });
    if (remoteCheck.outcome === "spawn-error" || remoteCheck.code !== 0 || !remoteCheck.stdout.trim()) {
      fail("no git remote configured. machine_code requires a remote (e.g. `git remote add origin <url>`).");
    }
  }

  let itemSlug = itemFlag !== undefined ? slugify(itemFlag) : undefined;
  if (itemSlug) {
    const issue = findIssue(l, itemSlug);
    if (!issue) fail(`no issue ${itemSlug} — create one with \`machine_code issue create features|bugs ${itemSlug} "..."\``);
    // An issue decides its agent unless --agent overrides it.
    const issueAgent = normalizedAgent ?? (issue.kind === "ideas" ? "research" : "engineer");
    // Agent must match the issue kind.
    if (issueAgent === "research" && issue.kind !== "ideas") {
      fail(`issue ${itemSlug} is ${issue.kind}, not an idea; research only runs on ideas`);
    }
    if (issueAgent === "engineer" && issue.kind === "ideas") {
      fail(`issue ${itemSlug} is an idea; research it first (machine_code issue run ${itemSlug})`);
    }
    // Engineer: work from todo, a failed attempt, or a legacy blocked state.
    if (issueAgent === "engineer" && !(ENGINEER_WORK_STATUSES as readonly string[]).includes(issue.status)) {
      fail(`issue ${itemSlug} is ${issue.status}; engineer works from todo or a failed-gates/review state`);
    }
    // Engineer: dependencies serialize same-file sequences. Building before
    // the dependency merges means racing it and conflicting at merge time.
    if (issue.kind !== "ideas") {
      const unmet = unmetDepends(l, issue);
      if (unmet.length > 0) {
        fail(`issue ${itemSlug} depends on ${unmet.join(", ")} — build ${unmet.join(", ")} first`);
      }
      const unknown = unknownDepends(l, issue);
      if (unknown.length > 0) {
        process.stderr.write(
          `machine_code: ignoring unknown depends for ${itemSlug}: ${unknown.join(", ")} (fix or remove them in the issue header)\n`,
        );
      }
      // `depends:` sequences queued issues. This catches the case where two
      // same-file issues were queued without the edge and are running now.
      const overlaps = activeFileConflicts(l, issue);
      if (overlaps.length > 0) {
        fail(
          `issue ${itemSlug} shares files with active work — ` +
            overlaps.map((c) => `${c.slug} (run ${c.runId.slice(-8)}: ${c.files.join(", ")})`).join("; ") +
            `; wait for it to finish or add depends: ${overlaps.map((c) => c.slug).join(", ")}`,
        );
      }
    }
    if (request.length === 0) request = issue.prompt || issue.title || itemSlug;
  }
  // Auto-create an issue for bare runs so every run is linked to a branch.
  // Gather context relevant to the request to save the agent scouting turns.
  // Without this, issueless runs skip the post-run commit/merge block and
  // their work is stranded in the worktree.
  let autoCreatedIssue = false;
  if (!itemSlug && (normalizedAgent === "engineer" || normalizedAgent === "research") && request) {
    const autoSlug = slugify(request);
    let issue = findIssue(l, autoSlug);
    if (!issue) {
      issue = writeIssue(l, {
        kind: normalizedAgent === "research" ? "ideas" : "features",
        slug: autoSlug,
        prompt: request,
        body: `Auto-created from run.\n\n${request}`,
        tags: [],
        review: "none",
      });
      // Commit (and push) immediately so the new issue lives on origin/main
      // before the branch is created — otherwise it exists only in the local
      // main, and the post-run merge back upstream diverges and refuses.
      await commitPlanningFiles(l, `[NEW FEATURE] ${autoSlug}`, true);
      autoCreatedIssue = true;
    }
    itemSlug = issue.slug;
    if (request.length === 0) request = issue.prompt || issue.title || itemSlug;
  }
  const { machine, models, catalogue: catalogueDoc, configuredProviders } = await loadRuntime(l);
  const minFit = flags.get("min-fit");
  if (minFit !== undefined) {
    const n = Number(minFit);
    if (!Number.isFinite(n) || n < 0 || n > 10) fail("--min-fit needs a number in 0-10");
  }
  const minCapability = flags.get("min-capability");
  if (minCapability !== undefined) {
    const n = Number(minCapability);
    if (!Number.isFinite(n) || n < 0 || n > 10) fail("--min-capability needs a number in 0-10");
  }
  const minAxes = flags.get("min-axes");
  let minAxesSnapshot: Record<string, number> | undefined;
  if (minAxes !== undefined) {
    minAxesSnapshot = parseAxisOverrides(minAxes);
  }
  // Selection floors are not policy text — they override the role def so the
  // run's pick() enforces exactly what the TUI preview and `models` dry-run
  // enforce. Without this the flags are validated and recorded but ignored.
  const floorOverrides =
    minFit !== undefined || minCapability !== undefined || minAxesSnapshot
      ? {
          ...(minFit !== undefined ? { minFit: Number(minFit) } : {}),
          ...(minCapability !== undefined ? { minCapability: Number(minCapability) } : {}),
          ...(minAxesSnapshot ? { minAxes: minAxesSnapshot } : {}),
        }
      : undefined;
  // Per-run price ceiling ($ per 1M tokens). Narrows or replaces the machine
  // selection.price_caps without persisting.
  const priceFlag = (name: string): number | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) fail(`--${name} needs a non-negative number ($ per 1M tokens)`);
    return n;
  };
  const maxPrice = priceFlag("max-price");
  const maxInputPrice = priceFlag("max-input-price") ?? maxPrice;
  const maxOutputPrice = priceFlag("max-output-price") ?? maxPrice;
  if (maxInputPrice !== undefined) machine.priceCaps.input = maxInputPrice;
  if (maxOutputPrice !== undefined) machine.priceCaps.output = maxOutputPrice;
  const contextExcludeFlag = flags.get("context-exclude");
  let contextExclude: import("../context/assemble.js").ContextExclusion | undefined;
  if (contextExcludeFlag !== undefined) {
    try {
      const raw = JSON.parse(contextExcludeFlag) as { sections?: unknown; items?: unknown };
      const strings = (value: unknown): string[] | undefined =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
      contextExclude = { sections: strings(raw.sections), items: strings(raw.items) };
    } catch {
      fail("--context-exclude must be a JSON object");
    }
  }
  const contextIncludeFlag = flags.get("context-include");
  let contextInclude: import("../context/assemble.js").ContextInclude | undefined;
  // An include that names no files leaves file seeding to the ranker: the
  // composer passes an explicit (possibly empty) include on every TUI launch,
  // and gating on the flag alone silently disabled suggestions for all of
  // them. The attached issue is merged below and never counts as explicit.
  let explicitFileInclude = false;
  if (contextIncludeFlag !== undefined) {
    try {
      const raw = JSON.parse(contextIncludeFlag) as { files?: unknown; docs?: unknown; knowledge?: unknown; references?: unknown; issues?: unknown };
      const strings = (value: unknown): string[] | undefined =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : undefined;
      contextInclude = {
        files: strings(raw.files),
        docs: strings(raw.docs ?? raw.knowledge),
        references: strings(raw.references),
        issues: strings(raw.issues),
      };
      explicitFileInclude = (contextInclude.files?.length ?? 0) > 0;
    } catch {
      fail("--context-include must be a JSON object");
    }
  }
  // The attached issue file is always explicit context, regardless of how the
  // run was started. Seed a deterministic Todo before assembly so the model
  // sees the plan in the issue block.
  if (itemSlug) ensureIssueVerification(l, itemSlug);
  const attachedIssue = itemSlug ? findIssue(l, itemSlug) : null;
  if (attachedIssue) {
    contextInclude = contextInclude ?? {};
    contextInclude.files = [...new Set([...(contextInclude.files ?? []), attachedIssue.rel])];
  }
  // Suggestions are context files. Small ones inline whole into the run's
  // file set (and become seeded symbol-map entries with outlines); everything
  // else stays on demand — one inspect call runs the same ranker and returns
  // the evidence denser. Outlines are not baked into the prompt: the model
  // would hold bytes the symbol map never saw, and every turn would re-send
  // them. No second `## Context` prompt block.
  // Suggestion file list, computed up front and recorded once the recorder
  // exists below. Best effort; the run still has the issue without it.
  let suggestedFiles: string[] = [];
  let hintRanges: Array<{ path: string; start: number; end: number }> = [];
  let builtMapFiles = 0;
  const hintsOn = flags.get("hints") !== "false";
  if (!explicitFileInclude && hintsOn) {
    try {
      const { buildRepoMap } = await import("../map/deterministic.js");
      // Use the freshly built map directly: re-reading it from disk re-opens
      // a stale/null window between the build and the suggestion pass.
      const builtMap = await buildRepoMap(l.repoRoot);
      builtMapFiles = builtMap.map.files.length;
      const suggestionRequest = withKeywordTerms(suggestionText(attachedIssue?.prompt ?? request), attachedIssue?.keywords);
      const hints = suggestHints({
        map: builtMap.map,
        request: suggestionRequest,
        repoRoot: l.repoRoot,
        limit: machine.map.suggestLimit,
        ...(attachedIssue?.rel ? { exclude: [attachedIssue.rel] } : {}),
      });
      suggestedFiles = hints.map((hint) => hint.path);
      // Hint symbols pre-fill the living map: their paths register as seen,
      // so turn 1 already indexes the suggested files.
      for (const hint of hints) {
        for (const symbol of hint.symbols.slice(0, 3)) {
          if (symbol.start >= 1 && symbol.end >= symbol.start && hintRanges.length < 12) {
            hintRanges.push({ path: hint.path, start: symbol.start, end: symbol.end });
          }
        }
      }
      const smallFiles = hints.filter((hint) => hint.small).map((hint) => hint.path);
      // Small high-rank files just below the outline cut still inline whole:
      // a keys/types sibling (often <4KB) rides along instead of costing a
      // discovery pass. Ranked once, capped, exclusion-aware.
      try {
        const { statSync } = await import("node:fs");
        const ranked = suggestTaskFilesFromMap(builtMap.map, suggestionRequest, 10);
        for (const entry of ranked) {
          if (smallFiles.includes(entry.path) || suggestedFiles.includes(entry.path)) continue;
          if (attachedIssue?.rel && entry.path === attachedIssue.rel) continue;
          try {
            if (statSync(join(l.repoRoot, entry.path)).size < 4 * 1024) smallFiles.push(entry.path);
          } catch {
            // missing — skip
          }
          if (smallFiles.length >= 5) break;
        }
      } catch {
        // Best effort; the inlined small files above still apply.
      }
      if (smallFiles.length > 0) {
        contextInclude = contextInclude ?? {};
        contextInclude.files = [...new Set([...(contextInclude.files ?? []), ...smallFiles])];
      }
    } catch {
      // Suggestions are best effort; the run still has the issue.
    }
  }
  const contextBudgetFlag = flags.get("context-budget");
  let contextBudgetChars: number | undefined;
  if (contextBudgetFlag !== undefined) {
    contextBudgetChars = Number(contextBudgetFlag);
    if (!Number.isFinite(contextBudgetChars) || contextBudgetChars <= 0) {
      fail("--context-budget needs a positive character count");
    }
  }
  const holdingsBudgetFlag = flags.get("holdings-budget");
  let holdingsMaxChars: number | undefined;
  if (holdingsBudgetFlag !== undefined) {
    holdingsMaxChars = Number(holdingsBudgetFlag);
    if (!Number.isFinite(holdingsMaxChars) || holdingsMaxChars <= 0) {
      fail("--holdings-budget needs a positive character count");
    }
  }
  // Composer per-skill mode overrides: {"clean-code":"include",...}.
  let skillModeOverrides: Record<string, import("../context/references.js").SkillMode> | undefined;
  const skillModesFlag = flags.get("skill-modes");
  if (skillModesFlag !== undefined) {
    try {
      const raw = JSON.parse(skillModesFlag) as Record<string, unknown>;
      const { isSkillMode } = await import("../context/references.js");
      const modes: Record<string, import("../context/references.js").SkillMode> = {};
      for (const [name, mode] of Object.entries(raw)) {
        if (typeof name === "string" && name.trim().length > 0 && isSkillMode(mode)) modes[name] = mode;
      }
      skillModeOverrides = modes;
    } catch {
      fail("--skill-modes must be a JSON object of skill name to include|on-demand|exclude");
    }
  }
  const excludedSections = new Set(contextExclude?.sections ?? []);
  const excludedItems = new Set(contextExclude?.items ?? []);
  const skillExcludes = [...excludedItems]
    .filter((key) => key.startsWith("skill:"))
    .map((key) => key.slice("skill:".length));
  const skipMap = excludedSections.has("codebase") || excludedItems.has("map:index");
  if (requireProvider && !configuredProviders.has(requireProvider)) {
    fail(`provider "${requireProvider}" is not configured`);
  }

  if (modeFlag !== undefined) {
    fail("--mode was removed; runs execute directly per their agent role");
  }
  // An item-attached run defaults to the agent its issue kind needs; a bare
  // run defaults to research (the historical behavior).
  const agentNameParsed = normalizedAgent ?? (attachedIssue?.kind === "ideas" ? "research" : attachedIssue ? "engineer" : "research");

  if (request.length === 0) {
    fail(`run needs a question, e.g. machine_code run "fix the parser panic"`);
  }

  // Probe cooling models with free metadata before a run record exists. A
  // recovered model can rejoin selection; if nothing is ready, block here
  // instead of starting a run that cannot make its first call.
  const availabilityState = loadAvailability(l.home);
  const probeResults = await probeCoolingModels({
    rows: catalogueDoc.models,
    state: availabilityState,
    config: machine.availability,
    configuredProviders,
  });
  if (probeResults.length > 0) saveAvailability(l.home, availabilityState);
  for (const result of probeResults) {
    if (result.status === "ready") {
      process.stderr.write(`availability: ${result.key} recovered\n`);
    } else if (result.status === "unavailable" || result.status === "auth") {
      process.stderr.write(`availability: ${result.key} ${result.status}${result.message ? ` (${result.message})` : ""}\n`);
    }
  }
  const agentDefObj = agentDef(l, agentNameParsed === "" ? "engineer" : agentNameParsed);
  // Every pick on this path goes through one selection context so preflight,
  // the loop, the TUI preview, and the models dry-run enforce the same
  // floors, tier, pin, and runtime filter.
  const selection = resolveSelectionContext({
    role: agentNameParsed,
    layout: l,
    machine,
    def: agentDefObj,
    floors: floorOverrides,
    ...(tierFlag ? { tier: tierFlag } : {}),
    pin: {
      ...(requireModel ? { model: requireModel } : {}),
      ...(requireProvider ? { provider: requireProvider } : {}),
    },
    hasRuntimeModel: (providerID: string, id: string) => models.getModel(providerID, id) !== undefined,
  });
  let preflight = pickWithContext(selection, {
    agent: agentNameParsed,
    machine,
    catalogue: catalogueDoc.models,
    configuredProviders,
    availability: availabilityState,
    fundedProviders: fundedProviderIds(machine.providers),
    contextChars: request.length,
  });
  if ("error" in preflight && (requireModel || requireProvider)) {
    // A pin that can never work is a user error, not a preference: silently
    // falling back to auto-selection has picked paid models the user never
    // asked for. Transient states (cooling, floors, funding) keep the old
    // fallback below.
    const viability = pinViability(selection, {
      agent: agentNameParsed,
      machine,
      catalogue: catalogueDoc.models,
      configuredProviders,
      availability: availabilityState,
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: request.length,
    });
    if (!viability.ok) {
      fail(`model pin unusable (${requireModel ?? requireProvider}): ${viability.reasons.join(", ")} (${viability.hint})`);
    }
    // A pin is a preference: if the pinned model is not ready before start,
    // fall back to auto-selection instead of refusing to start the run.
    const relaxed = pickWithContext({ ...selection, requireModel: undefined, requireProvider: undefined }, {
      agent: agentNameParsed,
      machine,
      catalogue: catalogueDoc.models,
      configuredProviders,
      availability: availabilityState,
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: request.length,
    });
    if (!("error" in relaxed)) {
      process.stderr.write(
        `model pin unavailable (${requireModel ?? requireProvider}); falling back to auto-selection\n`,
      );
      requireModel = undefined;
      requireProvider = undefined;
      preflight = relaxed;
    }
  }
  if ("error" in preflight) {
    fail(`no model is ready before run start: ${preflight.error}${preflight.rejected[0] ? ` (${preflight.rejected[0].key}: ${preflight.rejected[0].reason})` : ""}`);
  }
  const runSettings: import("../state/run-schema.js").RunSettingsSnapshot = {
    ...(requireModel ? { model: preflight.selected.key } : {}),
    ...(minFit !== undefined ? { minFit: Number(minFit) } : {}),
    ...(minAxesSnapshot ? { minAxes: minAxesSnapshot } : {}),
  };

  // Fork lineage: resolve the parent before the recorder exists so the child
  // is born with its lineage (never patched in after the fact).
  const parentFlag = flags.get("parent");
  const inheritWorktree = flags.has("inherit-worktree");
  let parentRun: import("../state/runs.js").RunSummary | undefined;
  /** Parent, grandparent, … nearest first, so a fork of a fork keeps the whole chain. */
  const parentChain: Array<{
    id: string;
    request: string;
    finalText?: string;
    status?: string;
    stopReason?: string;
    error?: string;
  }> = [];
  const parentChainRuns: RunSummary[] = [];
  if (parentFlag !== undefined) {
    const allRuns = listAllRuns(l.home);
    parentRun = allRuns.find((r) => r.id === parentFlag);
    if (!parentRun) fail(`no such parent run: ${parentFlag}`);
    // Done issues are immutable: their branch/worktree are pruned and only
    // the commit survives. Forking their old runs would resurrect dead
    // branches, so refuse and point at the commit instead.
    const parentItem = parentRun.itemId ?? parentRun.packetId;
    if (parentItem) {
      const parentIssue = findIssue(l, parentItem);
      if (parentIssue && (parentIssue.status === "done" || parentIssue.status === "researched") && parentIssue.commit) {
        fail(
          `run ${parentFlag} belongs to done issue ${parentItem} (${parentIssue.commit.slice(0, 12)}); ` +
            `start a new issue that depends on it instead of forking`,
        );
      }
    }
    const byId = new Map(allRuns.map((run) => [run.id, run]));
    const seen = new Set<string>();
    let cursor: import("../state/runs.js").RunSummary | undefined = parentRun;
    while (cursor && parentChain.length < 4 && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parentChainRuns.push(cursor);
      parentChain.push({
        id: cursor.id,
        request: cursor.request,
        ...(cursor.finalText ? { finalText: cursor.finalText } : {}),
        ...(cursor.status ? { status: cursor.status } : {}),
        ...(cursor.stopReason ? { stopReason: cursor.stopReason } : {}),
        ...(cursor.error ? { error: cursor.error } : {}),
      });
      cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) : undefined;
    }
  }

  const recorder = new RunRecorder(l, {
    agent: agentNameParsed,
    mode: "",
    request,
    repoRoot: l.repoRoot,
    settings: runSettings,
    ...(itemSlug ? { itemId: itemSlug } : {}),
    ...(parentRun
      ? {
          parentRunId: parentRun.id,
          rootRunId: parentRun.rootRunId ?? parentRun.id,
          forkReason: "manual" as const,
        }
      : {}),
  });
  registerProject(l.home, l.repoRoot);
  if (itemSlug) recorder.event("item_linked", { slug: itemSlug });
  // Diagnostic anchor: the run exists on disk as "created" but has not hand
  // off into execution yet. The TUI reads this event to distinguish a queued
  // run from a stuck one when the waiting page shows no progress.
  recorder.event("start_requested", {
    agent: agentNameParsed,
    ...(itemSlug ? { item: itemSlug } : {}),
    ...(flags.has("debug") || flags.has("verbose") ? { debug: true } : {}),
  });
  // The witness fires whether or not suggestions applied: files:[] with a
  // real map means the ranker filtered everything, mapFiles is the map size,
  // and skipped names why nothing was attached. Never silently empty.
  if (!explicitFileInclude && hintsOn) {
    recorder.event("suggestions", {
      files: suggestedFiles,
      mapFiles: builtMapFiles,
    });
  } else {
    recorder.event("suggestions", {
      files: [],
      skipped: explicitFileInclude ? "explicit-include" : "disabled",
    });
  }
  for (const result of probeResults) {
    recorder.event("availability_probe", {
      key: result.key,
      provider: result.providerID,
      status: result.status,
      source: result.source,
      latencyMs: result.latencyMs,
      ...(result.message ? { message: result.message } : {}),
    });
    if (result.status === "ready") {
      recorder.event("availability_cooldown_cleared", { key: result.key });
    } else if (result.status === "cooling" || result.status === "unavailable") {
      recorder.event("availability_cooldown_extended", { key: result.key, retryAfterMs: result.retryAfterMs });
    }
  }

  // Build runs work in an isolated worktree. Review reads the worktree it
  // inspects. Research gets a temporary worktree on the main branch so the
  // repo stays clean.
  const worktreeFlag = flags.get("worktree");
  if (worktreeFlag !== undefined && worktreeFlag !== "true" && worktreeFlag !== "false") {
    fail("--worktree must be true|false");
  }
  const worktreeOn = worktreeFlag !== "false";
  const forceWorktree = worktreeOn && flags.has("worktree");
  const mutating =
    agentNameParsed === "research" || agentNameParsed === "engineer"
      ? true
      : forceWorktree;
  let toolRoot = l.repoRoot;
  let reusedWorktree = false;
  /** Files the owning run touched; seeded whole into the first prompt. */
  let priorWorkFiles: string[] = [];
  if (mutating) {
    const issueWorktree = Boolean(itemSlug);
    // Reuse a terminal/paused worktree that already owns this issue branch.
    const issueBranch = attachedIssue?.branch;
    // A fresh path cannot be created while the issue branch is checked out.
    const reuse = reusableWorktreeOwner(
      [
        ...parentChainRuns,
        ...listAllRuns(l.home).filter((run) => run.repoRoot === l.repoRoot),
      ],
      issueWorktree ? (issueBranch ?? `mc/${itemSlug}`) : undefined,
      agentNameParsed,
    );
    if (reuse) {
      toolRoot = reuse.path;
      reusedWorktree = true;
      const refresh = await refreshReusedWorktree(reuse.path, reuse.run.baseBranch ?? "main");
      recorder.patchSummary({
        worktree: reuse.path,
        worktreeOwnerRunId: reuse.run.id,
        branch: reuse.run.branch,
        baseBranch: reuse.run.baseBranch,
        baseRef: reuse.run.baseRef,
      });
      recorder.event("worktree_reused", {
        parentRunId: reuse.run.id,
        path: reuse.path,
        branch: reuse.run.branch,
        refresh,
      });
      process.stderr.write(
        `worktree ${reuse.path} (reused from ${reuse.run.id}, branch ${reuse.run.branch}` +
          `${refresh === "updated" ? ", merged main" : refresh === "conflict" ? ", main merge conflicted (state preserved)" : ""})\n`,
      );
    } else {
      try {
        // Fetch latest main before creating the worktree so the branch starts from
        // the most recent upstream state.
        await syncFromRemote(l.repoRoot);
        const worktreeProcesses = new ProcessSupervisor({
          runId: recorder.id,
          runDir: recorder.dir,
          onEvent: (type, data) => recorder.event(type, data),
        });
        const spec = await createWorktree({
          layout: l,
          runId: recorder.id,
          kind: issueWorktree ? "issue" : "run",
          ...(issueWorktree ? { slug: itemSlug } : {}),
          ...(issueWorktree && attachedIssue?.branch ? { branch: attachedIssue.branch } : {}),
          base: baseFlag ?? (inheritWorktree && parentRun?.branch ? parentRun.branch : undefined),
          processes: worktreeProcesses,
        });
        recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
        if (inheritWorktree && parentRun?.worktree) {
          try {
            const { inheritWorktreePatch } = await import("../worktree.js");
            const patch = await inheritWorktreePatch({
              parentWorktree: parentRun.worktree,
              parentBaseRef: parentRun.baseRef,
              childWorktree: spec.path,
            });
            recorder.event("fork_inherited", { parentRunId: parentRun.id, patchBytes: patch.bytes });
          } catch (error) {
            if (error instanceof WorktreeError) {
              recorder.event("worktree_failed", { error: error.message, code: error.code });
              recorder.event("start_failed", { error: error.message, code: error.code, stage: "fork_inherit" });
              recorder.finalize("blocked", `${error.code}: ${error.message}`);
              process.stderr.write(`machine_code: ${error.code}: ${error.message}\n`);
              return EXIT.blocked;
            }
            throw error;
          }
        }
        for (const branch of spec.createdBranches) {
          recorder.event("branch_created", { branch, base: spec.baseRef });
        }
        // Maintain a remote copy of the feature branch so an interrupted
        // run loses no committed work.
        if (issueWorktree) {
          const { pushFeatureBranch } = await import("../tasks/sync.js");
          const pushed = await pushFeatureBranch(spec.path, spec.branch);
          recorder.event("branch_pushed", { branch: spec.branch, pushed });
        }
        recorder.event("worktree_created", {
          path: spec.path,
          branch: spec.branch,
          baseRef: spec.baseRef,
          baseBranch: spec.baseBranch,
          linkedDirs: spec.linkedDirs,
          skippedLinks: spec.skippedLinks,
          materialized: spec.materialized,
        });
        toolRoot = spec.path;
        process.stderr.write(`worktree ${spec.path} (branch ${spec.branch})\n`);
      } catch (error) {
        if (error instanceof WorktreeError && error.code === "branch_checked_out" && issueWorktree && itemSlug) {
          // The issue branch is already checked out in another worktree: just use it.
          const branch = attachedIssue?.branch ?? `mc/${itemSlug}`;
          const existing = await branchCheckedOutAt(l.repoRoot, branch);
          if (!existing) {
            recorder.finalize("blocked", `${error.code}: ${error.message}`);
            process.stderr.write(`machine_code: ${error.code}: ${error.message}\n`);
            return EXIT.blocked;
          }
          const baseBranch = await defaultBaseBranch(l.repoRoot);
          const baseRef = await resolveBaseRef(l.repoRoot, baseBranch);
          const owner = [
            ...parentChainRuns,
            ...listAllRuns(l.home).filter((run) => run.repoRoot === l.repoRoot),
          ].find((run) => run.worktree === existing);
          const ownerActive = owner !== undefined &&
            (owner.status === "created" || owner.status === "running" || owner.status === "awaiting_input");
          toolRoot = existing;
          reusedWorktree = true;
          // Never touch a worktree that an active run owns; otherwise bring
          // it current like any other reuse.
          const refresh = ownerActive ? "skipped" : await refreshReusedWorktree(existing, owner?.baseBranch ?? baseBranch);
          recorder.patchSummary({
            worktree: existing,
            ...(owner ? { worktreeOwnerRunId: owner.id } : {}),
            branch,
            baseBranch,
            baseRef,
          });
          recorder.event("worktree_reused", {
            ...(owner ? { parentRunId: owner.id } : {}),
            path: existing,
            branch,
            shared: true,
            ...(ownerActive ? { ownerActive: true } : {}),
            refresh,
          });
          process.stderr.write(
            `worktree ${existing} (already checked out, branch ${branch}${ownerActive ? "; owner run still active" : ""})\n`,
          );
        } else if (error instanceof WorktreeError) {
          recorder.event("worktree_failed", { error: error.message, code: error.code });
          recorder.event("start_failed", { error: error.message, code: error.code, stage: "worktree" });
          recorder.finalize("blocked", `${error.code}: ${error.message}`);
          process.stderr.write(`machine_code: ${error.code}: ${error.message}\n`);
          return EXIT.blocked;
        } else {
          throw error;
        }
      }
    }
  }

  // A reused worktree may hold prior work. State only facts: commits ahead,
  // dirty paths, or clean. Never claim prior work on a reset branch; that
  // sends the model through status/history/diff for nothing. Merge commits
  // from harness syncs are not work: count only non-merge commits, and quote
  // the diff inline so the model never inspects history to re-derive it.
  if (reusedWorktree && toolRoot !== l.repoRoot) {
    try {
      const branch = recorder.current.branch ?? "";
      const base = recorder.current.baseRef ?? "main";
      const ownerId = recorder.current.worktreeOwnerRunId;
      const ownerStatus = ownerId
        ? listAllRuns(l.home).find((run) => run.id === ownerId)?.status
        : undefined;
      const baseBranch = recorder.current.baseBranch ?? "main";
      const mergeBase = await runProc("git", ["merge-base", "HEAD", baseBranch], { cwd: toolRoot, timeoutMs: 15_000 });
      const diffBase = mergeBase.code === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : base;
      const ahead = await runProc("git", ["rev-list", "--no-merges", "--count", `${base}..HEAD`], { cwd: toolRoot, timeoutMs: 15_000 });
      const status = await runProc("git", ["status", "--porcelain"], { cwd: toolRoot, timeoutMs: 15_000 });
      const aheadCount = Number(ahead.stdout.trim()) || 0;
      const dirtyText = status.code === 0 ? status.stdout.trim() : "";
      const lines = [
        `## Worktree`,
        `Branch ${branch || "(unknown)"} at ${base}: ${aheadCount} work commit(s) ahead${dirtyText ? ", uncommitted changes" : ", clean"}.`,
      ];
      if (dirtyText) lines.push(`Uncommitted:\n${dirtyText}`);
      const changedNames = await runProc("git", ["diff", "--name-only", `${diffBase}..HEAD`], { cwd: toolRoot, timeoutMs: 15_000 });
      const untrackedNames = dirtyText
        .split("\n")
        .filter((line) => line.startsWith("??"))
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      priorWorkFiles = [...new Set([
        ...changedNames.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
        ...untrackedNames,
      ])];
      if (aheadCount > 0 || dirtyText) {
        // Committed prior work (base...HEAD) and uncommitted work (HEAD)
        // are different diffs; a reused dirty worktree usually has only the
        // latter. Quote both so the model never re-reads to reconstruct them.
        const diffs: string[] = [];
        if (aheadCount > 0) {
          const committed = await runProc("git", ["diff", `${diffBase}..HEAD`], { cwd: toolRoot, timeoutMs: 15_000 });
          const committedText = (committed.stdout || "").trim();
          if (committedText) diffs.push(committedText);
        }
        if (dirtyText) {
          const uncommitted = await runProc("git", ["diff", "HEAD", "--", "."], { cwd: toolRoot, timeoutMs: 15_000 });
          const uncommittedText = (uncommitted.stdout || "").trim();
          // Untracked files (?? in status) are not in any diff; name them so
          // the model reads exactly those instead of re-listing the tree.
          const untracked = dirtyText
            .split("\n")
            .filter((line) => line.startsWith("??"))
            .map((line) => line.slice(3).trim())
            .filter(Boolean);
          if (uncommittedText) diffs.push(uncommittedText);
          if (untracked.length > 0) diffs.push(`New files (read these directly):\n${untracked.join("\n")}`);
        }
        const joined = diffs.join("\n\n").trim();
        const PRIOR_DIFF_CAP = 24_000;
        let capped = joined;
        if (joined.length > PRIOR_DIFF_CAP) {
          const stat = await runProc("git", ["diff", "--stat", `${diffBase}..HEAD`], { cwd: toolRoot, timeoutMs: 15_000 });
          const statText = (stat.stdout || "").trim();
          capped = `${statText ? `${statText}\n\n` : ""}[diff truncated at ${PRIOR_DIFF_CAP.toLocaleString()} chars; read a named file directly]\n${joined.slice(0, PRIOR_DIFF_CAP)}`;
        }
        const complete = ownerStatus === undefined || ownerStatus === "completed";
        const priorLabel = complete
          ? "Prior work (complete — do not re-derive it from history)"
          : `Prior work from ${ownerId ?? "the owning run"} (status: ${ownerStatus}; may be incomplete — verify the files you touch compile)`;
        if (capped) lines.push(`${priorLabel}:\n${capped}`);
        lines.push(
          `The issue is the definition of done; keep only the parts of the above that directly satisfy it, and replace over-built code with the smallest change.`,
        );
      } else {
        lines.push(`Clean at ${base}; there is no prior work.`);
      }
      request = `${request}\n\n${lines.join("\n\n")}`;
      recorder.event("branch_state_reported", { branch, ahead: aheadCount, dirty: Boolean(dirtyText) });
    } catch {
      // Best effort: continue the task from the issue.
    }
  }

  // Explicitly referenced finished issues: inject what was asked (the
  // issue prompt) plus what was committed (the merge's stat + diff), so
  // the agent never needs git history tools. Files from the commit are
  // seeded below so they land in the symbol map like suggestions.
  // Reference issues (done/researched only): what was asked (the prompt)
  // plus what was committed (the merge's stat + diff), each in its own
  // section. Without a commit, just the prompt. File names — from the
  // commit diff when there is one, else the files: header — join the
  // union that seeds the symbol map below.
  let depFiles: string[] = [];
  if ((contextInclude?.issues?.length ?? 0) > 0) {
    try {
      const refs: string[] = [];
      const files: string[] = [];
      for (const ref of contextInclude?.issues ?? []) {
        const depIssue = findIssue(l, ref.split("/").pop()?.replace(/\.md$/, "") ?? ref);
        if (!depIssue || depIssue.slug === itemSlug) continue;
        // Only done/researched issues are references. Other includes are
        // plain context bodies (already inlined by assembly) — not references.
        if (depIssue.status !== "done" && depIssue.status !== "researched") continue;
        if (depIssue.commit) {
          const changed = await runProc("git", ["diff", `${depIssue.commit}^1`, depIssue.commit, "--name-only"], {
            cwd: l.repoRoot,
            timeoutMs: 15_000,
          });
          const changedFiles =
            changed.outcome === "exit" && changed.code === 0
              ? changed.stdout.trim().split("\n").map((f) => f.trim()).filter(Boolean)
              : [];
          if (changedFiles.length > 0) files.push(...changedFiles);
          // The stored commit is the merge into main, so diff against its
          // first parent: exactly what that feature merge introduced, nothing else.
          const stat = await runProc("git", ["diff", `${depIssue.commit}^1`, depIssue.commit, "--stat"], {
            cwd: l.repoRoot,
            timeoutMs: 15_000,
          });
          const statText = stat.outcome === "exit" && stat.code === 0 ? stat.stdout.trim() : "";
          const diff = await runProc(
            "git",
            ["diff", `${depIssue.commit}^1`, depIssue.commit, "--", ...(changedFiles.length > 0 ? changedFiles : ["."])],
            { cwd: l.repoRoot, timeoutMs: 15_000 },
          );
          const diffText =
            diff.outcome === "exit" && diff.code === 0 && diff.stdout.trim() ? diff.stdout.trim() : "";
          refs.push(
            `Reference ${depIssue.slug} (${depIssue.commit.slice(0, 12)}):\n${depIssue.prompt}${statText ? `\n\nLanded change:\n${statText}` : ""}${diffText ? `\n\nDiff:\n${diffText}` : ""}`,
          );
        } else {
          if (depIssue.files.length > 0) files.push(...depIssue.files);
          refs.push(`Reference ${depIssue.slug} (no commit yet):\n${depIssue.prompt}`);
        }
      }
      depFiles = [...new Set(files)];
      if (refs.length > 0) {
        request = `${request}\n\n${refs.join("\n\n")}`;
        recorder.event("reference_context", { count: refs.length });
      }
    } catch {
      // Best effort: missing context never blocks the run.
    }
  }

  // Context assembly (Phase 6): hierarchy + explicit artifacts + project
  // sources, written to context.json for provenance.
  const verification = attachedIssue?.verification ?? "direct";
  const { assembleContext } = await import("../context/assemble.js");
  const { writeJsonAtomic } = await import("../state/run-schema.js");
  const { roleSkillPresets } = await import("../agents.js");
  const contextBundle = await assembleContext({
    layout: l,
    machine,
    fileRoot: toolRoot,
    agent: agentNameParsed,
    verification,
    parentRuns: parentChain.length > 0 ? parentChain : undefined,
    ...(contextBudgetChars !== undefined ? { budgetChars: contextBudgetChars } : {}),
    exclude: contextExclude,
    include: contextInclude,
    defaultSkills: defaultSkillsFor({ agent: agentNameParsed, verification }),
    skillPresets: roleSkillPresets(agentNameParsed),
    skillOverrides: {
      // Verified issues ship tests: inline the full testing brief instead of
      // leaving it one on-demand pull away (models never pull it).
      ...(agentNameParsed === "engineer" && verification === "verified"
        ? { "verified-testing": "include" as const }
        : {}),
      ...skillModeOverrides,
    },
  });
  if (contextBundle.text) {
    writeJsonAtomic(join(recorder.dir, "context.json"), { chars: contextBundle.chars, sources: contextBundle.sources, warnings: contextBundle.warnings, sections: contextBundle.sections });
    recorder.event("context_assembled", { chars: contextBundle.chars, sources: contextBundle.sources, warnings: contextBundle.warnings });
  }
  const contextText = contextBundle.text || undefined;
  // Pin the assembled file sources as seeded symbol-map entries (with outlines)
  // so the first prompt already indexes the code the run is about, instead
  // of the model paging for it over several turns.
  const seedFiles = [...new Set([
    ...contextBundle.sources
      .filter((source) => source.kind === "file" && typeof source.ref === "string")
      .map((source) => source.ref as string),
    ...priorWorkFiles,
    ...(attachedIssue?.files ?? []),
    ...depFiles,
    ...suggestedFiles.slice(0, 3),
  ])];
  const seedRanges = hintRanges
    .filter((entry) => !seedFiles.includes(entry.path))
    .map((entry) => ({ path: entry.path, range: [entry.start, entry.end] as [number, number] }));
  const abort = new AbortController();
  let sigints = 0;
  process.on("SIGINT", () => {
    sigints += 1;
    if (sigints === 1) {
      abort.abort();
    } else {
      recorder.finalize("interrupted");
      process.exit(130);
    }
  });
  process.on("SIGTERM", () => {
    abort.abort();
  });

  process.stderr.write(`run ${recorder.id} (${recorder.dir})\n`);

  // The run has a worktree (or reused one) and is about to hand off into the
  // agent loop. Emit run_started so the TUI distinguishes "actively starting
  // then executing" from a run stranded in the created state.
  recorder.event("run_started", {
    agent: agentNameParsed,
    toolRoot,
    ...(itemSlug ? { item: itemSlug } : {}),
  });
  // Non-verbose default log line with a slug to open run details.
  process.stderr.write(`RUN ${recorder.id} — ${itemSlug ?? recorder.id.slice(-8)}\n`);

  // Fork context: carry the parent run's conversation forward so the child
  // picks up where the parent left off instead of starting fresh. The parent
  // messages are loaded from its saved transcript and the new objective is
  // appended as a final user message so the agent sees the full history.
  let forkMessages: import("@earendil-works/pi-agent-core").AgentMessage[] | undefined;
  let forkStartMode: "prompt" | "continue" | undefined;
  if (parentFlag && parentRun) {
    const parentDir = join(layout(parentRun.repoRoot ?? l.repoRoot).runsDir, parentRun.id);
    const transcript = loadTranscript(parentDir);
    if (transcript && transcript.messages.length > 0) {
      forkMessages = [
        ...(transcript.messages as import("@earendil-works/pi-agent-core").AgentMessage[]),
        {
          role: "user" as const,
          content: `**Forked from run ${parentRun.id} with a new objective:**\n\n${request}`,
          timestamp: Date.now(),
        },
      ];
      forkStartMode = "continue";
      recorder.event("fork_context_loaded", {
        parentRunId: parentRun.id,
        messages: transcript.messages.length,
        request: transcript.request,
      });
    }
  }

  let result: RunLoopResult;
  // Resolve gates from the issue so they run inside the loop. A worktree run
  // that will merge back gets the runner-owned sync gate first, so build/test
  // validate the tree that will actually land on main.
  const resolvedGates: GateSpec[] | undefined =
    itemSlug
      ? resolveGates(issueToTaskPacket(findIssue(l, itemSlug)!), allCommands(l, { scriptsRoot: toolRoot }))
      : undefined;
  const issueGates: GateSpec[] | undefined =
    resolvedGates && toolRoot !== l.repoRoot && (agentNameParsed === "engineer" || agentNameParsed === "research")
      ? withSyncGate(resolvedGates, recorder.current.baseBranch)
      : resolvedGates;
  if (directExec) {
    // Detached delegated child: one agent, directly. Its prompt is its spec.
    const role = (agentNameParsed ?? "engineer") as AgentName;
    if (role !== "engineer") {
      recorder.finalize("failed", "--direct-exec requires --agent engineer");
      process.stderr.write("machine_code: --direct-exec requires --agent engineer\n");
      return EXIT.failed;
    }
    const resolved = resolveAgent(l, role, {
      machineOverrides: machine.agents[role],
      runOverrides: agentOverrides,
      verification,
      ...(floorOverrides ? { floors: floorOverrides } : {}),
    });
    recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
    result = await runLoop({
      models,
      catalogue: catalogueDoc.models,
      configuredProviders,
      agent: resolved.def,
      agentConfig: resolved.config,
      agentCapabilities: resolved.capabilities,
      layout: l,
      machine,
      request,
      root: l.repoRoot,
      toolRoot,
      home: l.home,
      availability: loadAvailability(l.home),
      recorder,
      commands: allCommands(l, { scriptsRoot: toolRoot }),
      requireProvider,
      requireModel,
      contextText,
      ...(seedFiles.length > 0 ? { seedFiles } : {}),
      ...(seedRanges.length > 0 ? { seedRanges } : {}),
      ...(holdingsMaxChars !== undefined ? { holdingsMaxChars } : {}),
      skipMap,
      skillExcludes,
      signal: abort.signal,
      ...(issueGates ? { gates: issueGates } : {}),
      ...(forkMessages ? { initialMessages: forkMessages, startMode: forkStartMode } : {}),
    });
  } else {
    // Non-direct-exec: resolve the agent and run the loop directly.
    const role = (agentNameParsed ?? "research") as AgentName;
    const resolved = resolveAgent(l, role, {
      machineOverrides: machine.agents[role],
      runOverrides: agentOverrides,
      ...(floorOverrides ? { floors: floorOverrides } : {}),
    });
    recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
    result = await runLoop({
      models,
      catalogue: catalogueDoc.models,
      configuredProviders,
      agent: resolved.def,
      agentConfig: resolved.config,
      agentCapabilities: resolved.capabilities,
      layout: l,
      machine,
      request,
      root: l.repoRoot,
      toolRoot,
      home: l.home,
      availability: loadAvailability(l.home),
      recorder,
      commands: allCommands(l, { scriptsRoot: toolRoot }),
      requireProvider,
      requireModel,
      contextText,
      ...(seedFiles.length > 0 ? { seedFiles } : {}),
      ...(seedRanges.length > 0 ? { seedRanges } : {}),
      ...(holdingsMaxChars !== undefined ? { holdingsMaxChars } : {}),
      skipMap,
      skillExcludes,
      signal: abort.signal,
      ...(issueGates ? { gates: issueGates } : {}),
      ...(forkMessages ? { initialMessages: forkMessages, startMode: forkStartMode } : {}),
    });
  }

  // Research that completed means gates passed. The research:verify gate
  // already checked for new files in issues/, docs/, .machine_code/references/.
  // Move any parent idea to researched and commit the new artifacts.
  if (result.status === "completed" && itemSlug && agentNameParsed === "research") {
    const issue = findIssue(l, itemSlug);
    if (issue?.kind === "ideas" && issue.status === "needs-research") {
      moveIssue(l, issue.slug, "researched");
      await commitPlanningFiles(l, `[${kindTag(issue.kind)} RESEARCHED] ${issue.slug}`);
      recorder.event("idea_researched", { slug: issue.slug });
    }
  }

  // Gates ran inside the loop (or inside executeIssue for the orchestrate
  // path). If the result is "completed" the gates passed. Commit, merge, and
  // move the issue through its lifecycle. If the direct-exec loop returned
  // "blocked" with lastGateFailure, write it to the issue file here.
  if (
    result.status === "completed" &&
    itemSlug &&
    (agentNameParsed === "engineer" || agentNameParsed === "research") &&
    toolRoot !== l.repoRoot
  ) {
    const issue = findIssue(l, itemSlug);
    if (issue) {
      let commit: string | null = null;
      try {
        commit = await ensureCommitted(
          toolRoot,
          recorder.current.baseRef,
          `mc(${issue.slug}): ${issue.prompt}\n\nrun: ${recorder.id}\nissue: ${issue.slug}`,
        );
      } catch (error) {
        result = {
          ...result,
          status: "blocked",
          error: `commit failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!commit && result.status !== "blocked") {
        const outcome = /(?:^|\n)\s*Outcome:\s*(researched|curated|done|completed)\b/i.exec(result.finalText ?? "")?.[1]?.toLowerCase();
        if (agentNameParsed === "research" && (outcome === "curated" || outcome === "done")) {
          recorder.event("research_no_commit_expected", { outcome });
        } else {
          result = { ...result, status: "blocked", error: `${agentNameParsed} produced no committable change` };
        }
      } else if (commit) {
        recorder.patchSummary({ commit });
        recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, issue: issue.slug });
        // Keep a remote copy after every commit so interruption loses nothing.
        if (toolRoot !== l.repoRoot && recorder.current.branch) {
          const { pushFeatureBranch } = await import("../tasks/sync.js");
          const pushed = await pushFeatureBranch(toolRoot, recorder.current.branch);
          recorder.event("branch_pushed", { branch: recorder.current.branch, pushed });
        }
        if (issue.kind === "ideas" || issue.review === "none" || flags.has("no-review")) {
          const branch = recorder.current.branch;
          if (branch) {
            const merged = await mergeBranchIntoMain(l.repoRoot, toolRoot, branch);
            if (merged.ok) {
              recorder.event("branch_merged", { branch, mergeCommit: merged.mergeCommit });
              const { updateIssueMeta } = await import("../plan/issues.js");
              if (merged.mergeCommit) updateIssueMeta(l, issue.slug, { commit: merged.mergeCommit });
              if (issue.kind !== "ideas") {
                moveIssue(l, issue.slug, "done");
                await commitPlanningFiles(l, `[${kindTag(issue.kind)} DONE] ${issue.slug}`);
              }
            } else {
              if (issue.kind !== "ideas") {
                moveIssue(l, issue.slug, "blocked");
                await commitPlanningFiles(l, `[${kindTag(issue.kind)} BLOCKED] ${issue.slug}`);
              }
              result = { ...result, status: "blocked", error: `merge failed: ${branch} into main${merged.detail ? ` (${merged.detail})` : ""}` };
            }
          }
        } else {
          moveIssue(l, issue.slug, "needs-human-review");
          await commitPlanningFiles(l, `[${kindTag(issue.kind)} NEEDS HUMAN REVIEW] ${issue.slug}`);
        }
      }
    }
  }
  // Direct-exec loop with gate failure that exhausted its attempts. Write the
  // failure to the issue file and move it to failed-gates. The orchestrate
  // path handles this inside executeIssue.
  if (result.status === "blocked" && itemSlug) {
    const gateFail = (result as RunLoopResult).lastGateFailure;
    if (gateFail && gateFail.length > 0) {
      const issue = findIssue(l, itemSlug);
      if (issue) {
        appendIssueGateFailure(issue.path, gateFail, gateFailureAttempts(issue.body) + 1);
        moveIssue(l, issue.slug, "failed-gates");
        await commitPlanningFiles(l, `[${kindTag(issue.kind)} FAILED GATES] ${issue.slug}`);
      }
    }
  }
  // A blocked run may have left a sync merge half-resolved. Abort it so the
  // worktree is reusable; the branch keeps every committed commit.
  if (result.status !== "completed") await abortMergeIfInProgress(toolRoot);
  recorder.finalize(result.status, result.error, result.finalText);
  if (agentNameParsed === "research") {
    await commitPlanningFiles(l, `[RESEARCH RUN] ${recorder.id.slice(-8)}`);
  }
  printRunOutcome(result, recorder);
  if (machine.notify.webhookUrl || machine.notify.command) {
    const { notify } = await import("../notify.js");
    await notify(machine.notify, {
      event: "run_terminal",
      status: result.status,
      runId: recorder.id,
      repoRoot: l.repoRoot,
      agent: agentNameParsed ?? "research",
      request,
      tokens: recorder.current.usage.totalTokens,
      cost: recorder.current.cost.actual,
      error: result.error,
    }).catch(() => undefined);
  }
  const summary = recorder.current;
  process.stderr.write(
    `\nrun ${summary.id}: ${summary.status}${summary.stopReason && summary.stopReason !== "completed" ? ` (${summary.stopReason})` : ""} — ${summary.modelCalls} call(s), ${summary.usage.totalTokens} tokens, $${summary.cost.actual.toFixed(6)} actual\n`,
  );
  return EXIT[result.status];
}

/* ----------------------------------------------------------------- provider/model health */


export function controlCommand(action: "pause" | "cancel", argv: string[]): number {
  const id = argv[0];
  if (!id) fail(`usage: machine_code ${action} <run-id>`);
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const s = reconcileRun(found.run.summary);
  if (s.status !== "running" && s.status !== "awaiting_input" && s.status !== "created") {
    process.stdout.write(`run ${id} is ${s.status}; nothing to ${action}\n`);
    return 0;
  }
  const seq = sendControl(s.repoRoot, id, action);
  process.stdout.write(`${action} sent to run ${id} (seq ${seq}); the owner polls within ~500ms\n`);
  return 0;
}

/* ------------------------------------------------------------------ respond */

export function cmdRespond(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  const text = positional.slice(1).join(" ").trim();
  if (!id || text.length === 0) fail('usage: machine_code respond <run-id> "<answer>"');
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const runDir = join(found.layout.runsDir, id);
  const events = found.run.events;
  const questions = events.filter((e) => e.type === "question") as Array<{ questionId?: string; text?: string }>;
  const answers = readInbox(runDir).filter((e) => e.kind === "answer");
  const pending = latestUnansweredQuestion(questions, answers);
  const questionId = flags.get("question") ?? pending?.questionId;
  if (!questionId) {
    fail(`run ${id} has no pending question; pass --question <id> to attach the answer anyway`);
  }
  const entry = appendInbox(runDir, {
    questionId,
    kind: "answer",
    text,
    source: flags.get("source") ?? "cli",
  });
  process.stdout.write(`answer recorded for run ${id} (question ${questionId}, seq ${entry.seq})\n`);
  return 0;
}

export function parentWorktreePath(
  parent: Pick<RunSummary, "id" | "worktree">,
  localDir: string,
): string | undefined {
  if (typeof parent.worktree === "string" && existsSync(parent.worktree)) return parent.worktree;
  const conventional = join(localDir, "worktrees", parent.id);
  if (existsSync(conventional)) return conventional;
  return typeof parent.worktree === "string" ? parent.worktree : undefined;
}

export async function cmdFork(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  const objective = positional.slice(1).join(" ").trim();
  if (!id || objective.length === 0) fail('usage: machine_code fork <run-id> "<new objective>" [--inherit-worktree]');
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const parent = reconcileRun(found.run.summary);

  // Pause a running parent (bounded; a dead parent is already interrupted).
  if (parent.status === "running") {
    const seq = sendControl(parent.repoRoot, parent.id, "pause", { fork: true });
    const acked = await waitForControlAck(parent.repoRoot, parent.id, seq, 2_000);
    if (!acked) {
      process.stderr.write(`warning: parent ${parent.id} did not ack pause within 2s; child starts anyway (worktrees isolate it)\n`);
    }
  }

  // Spawn the child detached in the parent's repo. The child process creates
  // its own run record with --parent lineage and (optionally) inherits the
  // parent's branch + uncommitted patch.
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const args = [
    "run",
    "--parent",
    parent.id,
    "--agent",
    normalizeAgentName(parent.agent),
    ...(parent.itemId ? ["--item", parent.itemId] : []),
    ...(flags.has("inherit-worktree") && parentWorktreePath(parent, found.layout.localDir)
      ? ["--inherit-worktree"]
      : []),
    objective,
  ];
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: parent.repoRoot,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  process.stdout.write(`forking run ${parent.id}; child starting in ${parent.repoRoot}\n`);
  return 0;
}

/* ------------------------------------------------------------------- resume */


export async function cmdResume(id: string | undefined, argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const requireModel = flags.get("model");
  if (!id) fail("resume needs a run id");
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const s = reconcileRun(found.run.summary);
  const l2 = layout(s.repoRoot || found.layout.repoRoot);
  const runDir = join(l2.runsDir, id);

  if (s.status === "running" && isPidAlive(s.pid)) {
    process.stdout.write(`run ${id} is still running (pid ${s.pid})\n`);
    return 0;
  }
  if (s.status === "completed" || s.status === "cancelled") {
    process.stdout.write(`run ${id} is already ${s.status}; nothing to resume\n`);
    return 0;
  }

  const runtime = await loadRuntime(l2);
  const { machine, models, catalogue, configuredProviders } = runtime;

  // Worktree: reuse, recreate from branch, or (with --recreate) start fresh.
  // Sync main first so a recreated worktree starts from current upstream.
  let toolRoot = l2.repoRoot;
  let recorderPatchWorktree: { worktree: string; branch: string; baseBranch: string; baseRef: string } | undefined;
  await syncFromRemote(l2.repoRoot);
  if (s.worktree) {
    if (existsSync(s.worktree)) {
      toolRoot = s.worktree;
    } else if (s.branch && (await branchExists(l2.repoRoot, s.branch))) {
      toolRoot = await recreateWorktreeFromBranch(l2, id, s.branch);
      process.stderr.write(`recreated worktree from branch ${s.branch}\n`);
    } else if (flags.has("recreate")) {
      const spec = await createWorktree({ layout: l2, runId: id, kind: "run", base: s.baseRef });
      toolRoot = spec.path;
      process.stderr.write(`recreated worktree from base ${spec.baseRef}\n`);
    } else {
      fail(`worktree ${s.worktree} is missing and branch ${s.branch ?? "(none)"} no longer exists; use --recreate to start from the base commit`);
    }
  } else {
    // No worktree was ever acquired (e.g. the first attempt blocked on a
    // dirty tree). A mutating agent must never run on the main checkout:
    // it would edit main directly, pass gates there, and strand
    // uncommitted changes with no commit/merge/move. Retry creation (the
    // tree may be clean now); refuse if it still fails.
    const resumeAgentName = normalizeAgentName(s.agent ?? "research");
    if (resumeAgentName === "research" || resumeAgentName === "engineer") {
      const slug = s.itemId ?? s.packetId ?? undefined;
      const attached = slug ? findIssue(l2, slug) : null;
      try {
        await syncFromRemote(l2.repoRoot);
        const spec = await createWorktree({
          layout: l2,
          runId: id,
          kind: slug ? "issue" : "run",
          ...(slug ? { slug } : {}),
          ...(attached?.branch ? { branch: attached.branch } : {}),
          ...(s.baseRef ? { base: s.baseRef } : {}),
        });
        toolRoot = spec.path;
        recorderPatchWorktree = { worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef };
        process.stderr.write(`worktree ${spec.path} (branch ${spec.branch})\n`);
      } catch (error) {
        const msg = error instanceof WorktreeError
          ? `${error.code}: ${error.message}`
          : `worktree creation failed: ${error instanceof Error ? error.message : String(error)}`;
        process.stderr.write(`machine_code: cannot resume ${id} without a worktree: ${msg}\n`);
        return EXIT.blocked;
      }
    }
  }

  const gateCommands = allCommands(l2, { scriptsRoot: toolRoot });
  // The agent and the gates share one map so script:* resolves for both.
  const commands = allCommands(l2, { scriptsRoot: toolRoot });
  const recorder = RunRecorder.reopen(l2, s);
  if (recorderPatchWorktree) {
    recorder.patchSummary(recorderPatchWorktree);
    recorder.event("worktree_created", { ...recorderPatchWorktree, resumed: true });
  }
  const resumeFromStatus = s.status;
  recorder.setStatus("running", "resume");
  recorder.patchSummary({ pid: process.pid });
  recorder.event("resume_started", { fromStatus: resumeFromStatus });

  const abort = new AbortController();
  let sigints = 0;
  process.on("SIGINT", () => {
    sigints += 1;
    if (sigints === 1) {
      abort.abort();
    } else {
      recorder.finalize("interrupted");
      process.exit(130);
    }
  });
  process.on("SIGTERM", () => abort.abort());

  // Transcript + tail repair.
  const transcript = loadTranscript(runDir);
  const inbox = readInbox(runDir);
  let startMode: "prompt" | "continue" = "prompt";
  let initialMessages: import("@earendil-works/pi-agent-core").AgentMessage[] | undefined;
  let resumeAgent: AgentName = normalizeAgentName(s.agent ?? "research");
  if (!AGENT_NAMES.includes(resumeAgent)) resumeAgent = "research";
  let resumeRequest = s.request;

  if (transcript && transcript.messages.length > 0) {
    resumeAgent = transcript.agent ? normalizeAgentName(transcript.agent) : resumeAgent;
    if (!AGENT_NAMES.includes(resumeAgent)) resumeAgent = "research";
    resumeRequest = transcript.request || resumeRequest;
    const answerForQuestion = (questionText: string): string | null => {
      // Match the recorded answer to the pending ask by question text.
      const questions = found.run.events.filter((e) => e.type === "question") as Array<{
        questionId?: string;
        text?: string;
      }>;
      const match = [...questions].reverse().find((q) => q.text === questionText);
      if (!match?.questionId) return null;
      const answer = inbox.find((e) => e.kind === "answer" && e.questionId === match.questionId);
      return answer?.text ?? null;
    };
    const repaired = repairResumeTail(transcript.messages as never, answerForQuestion);
    // Orphan answers: recorded while the run was down but the transcript no
    // longer contains their ask tool call (e.g. a crash between the question
    // event and the suspension checkpoint). Deliver them as a user message.
    const questionTextById = new Map<string, string>();
    for (const e of found.run.events) {
      if (e.type === "question") {
        const q = e as { questionId?: string; text?: string };
        if (q.questionId && typeof q.text === "string") questionTextById.set(q.questionId, q.text);
      }
    }
    const transcriptQuestionIds = new Set<string>();
    for (const m of repaired.messages as Array<{ role?: string; content?: unknown }>) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block && block.type === "toolCall" && block.name === "ask") {
          const question = String((block.arguments as Record<string, unknown> | undefined)?.question ?? "");
          for (const [qid, text] of questionTextById) {
            if (text === question) transcriptQuestionIds.add(qid);
          }
        }
      }
    }
    const orphanAnswers = inbox.filter(
      (e) => e.kind === "answer" && e.questionId && !transcriptQuestionIds.has(e.questionId),
    );
    if (orphanAnswers.length > 0) {
      repaired.messages.push({
        role: "user",
        content: `Answer recorded while the run was down: ${orphanAnswers.map((a) => a.text).join(" | ")}`,
        timestamp: Date.now(),
      } as never);
      recorder.event("resume_answer_orphan", { count: orphanAnswers.length });
    }
    initialMessages = repaired.messages as never;
    startMode = "continue";
    if (repaired.repaired.length > 0) {
      recorder.event("resume_repaired", { toolCalls: repaired.repaired.map((r) => ({ name: r.name, answered: r.answered })) });
    }
  } else if (s.status === "awaiting_input") {
    // Awaiting input but the transcript is gone: surface the pending question.
    const pending = latestUnansweredQuestion(
      found.run.events.filter((e) => e.type === "question") as Array<{ questionId?: string }>,
      inbox,
    );
    if (pending) {
      process.stdout.write(`run ${id} is awaiting input; answer with: machine_code respond ${id} "<answer>"\n`);
      return 0;
    }
  }

  // Resolve gates upfront and pass them into the loop so resume runs them inline.
  const resumeItem = s.itemId ?? s.packetId;
  const resumeIssue = resumeItem ? findIssue(l2, resumeItem) : null;
  if (resumeIssue && (resumeIssue.status === "done" || resumeIssue.status === "researched")) {
    // The work already landed (and the branch was pruned) while this run
    // was paused. Resuming would redo it onto a gone branch.
    const msg = `issue ${resumeIssue.slug} is already ${resumeIssue.status}; start a new run instead of resuming ${id}`;
    recorder.finalize("blocked", msg);
    process.stderr.write(`machine_code: ${msg}\n`);
    return EXIT.blocked;
  }
  if (resumeIssue && resumeIssue.kind !== "ideas") {
    // Deps may have landed (or new conflicting runs started) while paused;
    // re-check what the start path enforces instead of merging stale work.
    const { unmetDepends, unknownDepends, activeFileConflicts } = await import("../tasks/issue.js");
    const unmet = unmetDepends(l2, resumeIssue);
    if (unmet.length > 0) {
      const msg = `issue ${resumeIssue.slug} depends on ${unmet.join(", ")} — build ${unmet.join(", ")} first`;
      recorder.finalize("blocked", msg);
      process.stderr.write(`machine_code: ${msg}\n`);
      return EXIT.blocked;
    }
    const unknown = unknownDepends(l2, resumeIssue);
    if (unknown.length > 0) {
      process.stderr.write(
        `machine_code: ignoring unknown depends for ${resumeIssue.slug}: ${unknown.join(", ")}\n`,
      );
    }
    const overlaps = activeFileConflicts(l2, resumeIssue).filter((c) => c.runId !== id);
    if (overlaps.length > 0) {
      const msg =
        `issue ${resumeIssue.slug} shares files with active work — ` +
        overlaps.map((c) => `${c.slug} (run ${c.runId.slice(-8)}: ${c.files.join(", ")})`).join("; ");
      recorder.finalize("blocked", msg);
      process.stderr.write(`machine_code: ${msg}; wait for it to finish\n`);
      return EXIT.blocked;
    }
  }
  const resumeGatesRaw: GateSpec[] | undefined =
    resumeIssue ? resolveGates(issueToTaskPacket(resumeIssue), gateCommands) : undefined;
  const resumeGates: GateSpec[] | undefined =
    resumeGatesRaw && toolRoot !== l2.repoRoot && (resumeAgent === "engineer" || resumeAgent === "research")
      ? withSyncGate(resumeGatesRaw, recorder.current.baseBranch)
      : resumeGatesRaw;

  const resolved = resolveAgent(l2, resumeAgent, {
    machineOverrides: machine.agents[resumeAgent],
    // Floors were recorded at start; re-apply so a resumed run enforces
    // the same thresholds instead of silently dropping to role defaults.
    ...((typeof s.settings?.minFit === "number" || s.settings?.minAxes)
      ? {
          floors: {
            ...(typeof s.settings?.minFit === "number" ? { minFit: s.settings.minFit as number } : {}),
            ...(s.settings?.minAxes ? { minAxes: s.settings.minAxes } : {}),
          },
        }
      : {}),
  });
  let result = await runLoop({
    models,
    catalogue: catalogue.models,
    configuredProviders,
    agent: resolved.def,
    agentConfig: resolved.config,
    agentCapabilities: resolved.capabilities,
    layout: l2,
    machine,
    request: resumeRequest,
    root: l2.repoRoot,
    toolRoot,
    home: l2.home,
    availability: loadAvailability(l2.home),
    recorder,
    commands,
    requireModel,
    signal: abort.signal,
    initialMessages,
    startMode,
    ...(resumeGates && resumeGates.length > 0 ? { gates: resumeGates } : {}),
  });

  // A resumed Engineer phase still owes the runner its gates, commit, and move.
  // Gates now run inside the loop. Handle completion or block from exhaustion.
  if (result.status === "completed" && (resumeAgent === "engineer" || resumeAgent === "research") && resumeIssue) {
    if (toolRoot !== l2.repoRoot) {
      try {
        const commit = await ensureCommitted(
          toolRoot,
          recorder.current.baseRef,
          `mc(${resumeIssue.slug}): ${resumeIssue.prompt}\n\nrun: ${recorder.id}\nissue: ${resumeIssue.slug}`,
        );
        if (commit) {
          recorder.patchSummary({ commit });
          recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, issue: resumeIssue.slug });
          // Keep a remote copy: an interruption between here and the merge
          // must not lose the work.
          if (recorder.current.branch) {
            const { pushFeatureBranch } = await import("../tasks/sync.js");
            const pushed = await pushFeatureBranch(toolRoot, recorder.current.branch);
            recorder.event("branch_pushed", { branch: recorder.current.branch, pushed });
          }
          const outcome = /(?:^|\n)\s*Outcome:\s*(researched|curated|done|completed)\b/i.exec(result.finalText ?? "")?.[1]?.toLowerCase();
          if (resumeIssue.kind === "ideas" && (outcome === "curated" || outcome === "done")) {
            recorder.event("research_no_commit_expected", { outcome });
          } else if (resumeIssue.review === "none" || flags.has("no-review") || resumeIssue.kind === "ideas") {
            const branch = recorder.current.branch;
            if (branch) {
              const merged = await mergeBranchIntoMain(l2.repoRoot, toolRoot, branch);
              if (merged.ok) {
                recorder.event("branch_merged", { branch, mergeCommit: merged.mergeCommit });
                const { updateIssueMeta } = await import("../plan/issues.js");
                if (merged.mergeCommit) updateIssueMeta(l2, resumeIssue.slug, { commit: merged.mergeCommit });
                if (resumeIssue.kind !== "ideas") {
                  moveIssue(l2, resumeIssue.slug, "done");
                  await commitPlanningFiles(l2, `[${kindTag(resumeIssue.kind)} DONE] ${resumeIssue.slug}`);
                }
              } else {
                result = {
                  ...result,
                  status: "blocked",
                  error: `merge failed: ${branch} into main${merged.detail ? ` (${merged.detail})` : ""}`,
                };
              }
            }
          } else {
            moveIssue(l2, resumeIssue.slug, "needs-human-review");
            await commitPlanningFiles(l2, `[${kindTag(resumeIssue.kind)} NEEDS HUMAN REVIEW] ${resumeIssue.slug}`);
          }
        } else if (resumeAgent === "engineer") {
          result = { ...result, status: "blocked", error: "engineer produced no committable change" };
        } else {
          const outcome = /(?:^|\n)\s*Outcome:\s*(researched|curated|done|completed)\b/i.exec(result.finalText ?? "")?.[1]?.toLowerCase();
          if (outcome !== "curated" && outcome !== "done") {
            result = { ...result, status: "blocked", error: "research produced no committable change" };
          } else {
            recorder.event("research_no_commit_expected", { outcome });
          }
        }
      } catch (error) {
        recorder.finalize("blocked", `commit failed: ${error instanceof Error ? error.message : String(error)}`, result.finalText);
        printRunOutcome({ ...result, status: "blocked" }, recorder);
        return EXIT.blocked;
      }
    }
  } else if (result.status === "blocked" && resumeIssue) {
    // Gate exhaustion: write the last failure to the issue file.
    const gateFail = (result as RunLoopResult).lastGateFailure;
    if (gateFail) {
      appendIssueGateFailure(resumeIssue.path, gateFail, gateFailureAttempts(resumeIssue.body) + 1);
      moveIssue(l2, resumeIssue.slug, "failed-gates");
      await commitPlanningFiles(l2, `[${kindTag(resumeIssue.kind)} FAILED GATES] ${resumeIssue.slug}`);
    }
  }

  if (result.status !== "completed") await abortMergeIfInProgress(toolRoot);
  recorder.finalize(result.status, result.error, result.finalText);
  printRunOutcome(result, recorder);
  const summary = recorder.current;
  process.stderr.write(
    `\nrun ${summary.id}: ${summary.status}${summary.stopReason && summary.stopReason !== "completed" ? ` (${summary.stopReason})` : ""} — ${summary.modelCalls} call(s), ${summary.usage.totalTokens} tokens, $${summary.cost.actual.toFixed(6)} actual\n`,
  );
  return EXIT[result.status];
}


export async function cmdPrune(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const days = Number(flags.get("days") ?? "7");
  if (!Number.isFinite(days) || days < 0) fail("prune --days must be a non-negative number");
  const l = layout();
  let checkedRuns = 0;
  for (const run of listAllRuns(l.home)) {
    const runDir = join(layout(run.repoRoot).runsDir, run.id);
    if (!existsSync(runDir)) continue;
    reconcileProcessRecords(runDir);
    checkedRuns += 1;
  }
  if (checkedRuns > 0) process.stdout.write(`checked process records for ${checkedRuns} run(s).\n`);
  const { removed, skipped } = pruneRuns(l.home, days);
  process.stdout.write(`pruned ${removed} run(s) older than ${days} day(s); ${skipped} skipped (active/interrupted/recent).\n`);
  const worktrees = await pruneWorktrees(l);
  if (worktrees.removed > 0) {
    process.stdout.write(`pruned ${worktrees.removed} orphaned worktree(s).\n`);
  }
  return 0;
}

/* ---------------------------------------------------------------- worktree */

export async function cmdWorktree(argv: string[]): Promise<number> {
  const sub = argv[0];
  const l = layout();
  if (sub === "list") {
    const { flags } = parseFlags(argv.slice(1));
    const deleteHint = flags.has("delete-branch");
    void deleteHint;
    const runs = listRuns(l);
    const withWorktree = runs.filter((r) => r.worktree);
    if (withWorktree.length === 0 && !existsSync(join(l.localDir, "worktrees"))) {
      process.stdout.write("no worktrees\n");
      return 0;
    }
    for (const r of withWorktree) {
      const present = existsSync(r.worktree!);
      process.stdout.write(
        `${r.status.padEnd(12)} ${r.id}  ${r.branch ?? "-"}  base ${r.baseBranch ?? "-"}${r.commit ? `  commit ${r.commit.slice(0, 10)}` : ""}  ${present ? r.worktree : `${r.worktree} (missing)`}\n`,
      );
    }
    // Orphaned directories: on disk without a matching run.
    const wtDir = join(l.localDir, "worktrees");
    if (existsSync(wtDir)) {
      const known = new Set(withWorktree.map((r) => r.id));
      for (const entry of readdirSync(wtDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !known.has(entry.name)) {
          process.stdout.write(`orphan        ${entry.name}  (no run record)  ${join(wtDir, entry.name)}\n`);
        }
      }
    }
    return 0;
  }
  if (sub === "remove") {
    const { flags, positional } = parseFlags(argv.slice(1));
    const runId = positional[0];
    if (!runId) fail("usage: machine_code worktree remove <run-id> [--delete-branch] [--force]");
    try {
      await removeWorktree({
        layout: l,
        runId,
        deleteBranch: flags.has("delete-branch"),
        force: flags.has("force"),
      });
      process.stdout.write(`removed worktree for ${runId}\n`);
      return 0;
    } catch (error) {
      if (error instanceof WorktreeError) {
        fail(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  }
  fail("usage: machine_code worktree list | remove <run-id>");
}


/* ----------------------------------------------------------------- runs */


export async function cmdCorrect(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  const correction = positional.slice(1).join(" ").trim();
  if (!id || !correction) fail('usage: machine_code correct <run-id> "<correction>"');
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const parent = reconcileRun(found.run.summary);
  if (parent.status === "running") {
    const seq = sendControl(parent.repoRoot, parent.id, "interrupt", { correction: true });
    const acked = await waitForControlAck(parent.repoRoot, parent.id, seq, 2_000);
    if (!acked) process.stderr.write(`warning: ${parent.id} did not ack interrupt within 2s; corrective run starts anyway\n`);
  }
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const args = ["run", "--parent", parent.id];
  if (parentWorktreePath(parent, found.layout.localDir)) args.push("--inherit-worktree");
  args.push("--agent", normalizeAgentName(parent.agent));
  if (parent.itemId) args.push("--item", parent.itemId);
  if (flags.get("tier")) args.push("--tier", flags.get("tier")!);
  args.push(correction);
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: parent.repoRoot,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  process.stdout.write(`correcting ${parent.id} with a fresh run; context and worktree are inherited\n`);
  return 0;
}
