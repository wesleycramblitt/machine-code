/**
 * machine_code — CLI run execution lifecycle.
 *
 * Split from `src/cli.ts`; behavior unchanged. See `src/cli/common.ts` for
 * shared setup (flags, runtime, formatting, run lookup).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../paths.js";
import { loadEnvFiles } from "../env.js";
import { loadMachineConfig, loadPolicy, ConfigError, DEFAULT_AGENT_POLICY, AGENT_NAMES, SELECTION_TIERS } from "../config.js";
import { createModelsCollection, availableChatModels, providerStatuses } from "../models.js";
import { refreshCatalogue } from "../catalogue/refresh.js";
import { loadCatalogue } from "../catalogue/load.js";
import { filterModels, siblingOffers, type ModelSort } from "../catalogue/query.js";
import { snapshotFiles } from "../catalogue/snapshot.js";
import { pick, axisWeights } from "../select.js";
import { CAPABILITY_AXES } from "../config.js";
import type { CatalogueDocument, CatalogueRow } from "../catalogue/types.js";
// agents resolved inside orchestrate.ts
import { orchestrate, executeIssue } from "../orchestrate.js";
import { RunRecorder, listRuns, listAllRuns, readRun, registerProject, reconcileRun, pruneRuns, listProjects, sendControl, waitForControlAck, isPidAlive, isActiveStatus, type RunStatus, type RunSummary } from "../state/runs.js";
import { appendInbox, readInbox, latestUnansweredQuestion } from "../state/question.js";
import { summarizeRun, readStateView } from "../state/outcome.js";
import { isTimelineEvent } from "../tui/timeline.js";
import { loadTranscript, repairResumeTail } from "../state/transcript.js";
import { findIssue, moveIssue, writeIssue } from "../plan/issues.js";
import { readCachedMap } from "../map/deterministic.js";
import { skillMetas } from "../context/references.js";
import { commitPlanningFiles } from "../tasks/planning.js";
import { issueToTaskPacket } from "../tasks/issue.js";
import { slugify } from "../plan/slug.js";
import { runProc } from "../proc.js";
import { agentDef, normalizeAgentName, type AgentName } from "../agents.js";
import { resolveAgent, resolveAgentConfig, type AgentConfig } from "../agents/config.js";
import { runLoop, type RunLoopResult } from "../loop.js";
import { inferReviewVerdict, parseReviewVerdict } from "../orchestrator/outcome.js";
import { policyFor, type OrchestrateResult } from "../orchestrate.js";
import { resolveGates, runGates } from "../verify.js";
import { defaultSkillsFor } from "../context/references.js";
import { allCommands } from "../commands/registry.js";
import { commitWorktree, createWorktree, removeWorktree, pruneWorktrees, recreateWorktreeFromBranch, branchExists, branchCheckedOutAt, defaultBaseBranch, resolveBaseRef, mainWorktreeRoot, reusableWorktreeOwner, refreshReusedWorktree, WorktreeError } from "../worktree.js";
import { loadAvailability, saveAvailability, clearFreeModelCooldowns } from "../availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "../availability/probe.js";
import { isFreeRow } from "../select.js";
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

/** Context hints for an issue body or run request: repo files whose path or
 * symbol names contain 2+ distinct request keywords (capped at 5), plus the
 * architecture doc and skill index when present. Weak matches mislead more
 * than they help, so no section at all beats a wrong one. */
/** Files worth opening first, ranked by how well their path and doc header
 * match the request. Files are heavily documented, so the header is the best
 * cheap signal; rarity weighting (IDF) stops generic words like "status" or
 * "issue" from dominating. UI requests prefer src/tui. */
const HINT_STOP = new Set([
  "this", "that", "with", "from", "have", "been", "when", "what", "make", "just",
  "into", "then", "they", "them", "there", "their", "same", "like", "many", "need",
  "needed", "line", "lines", "take", "taking", "next", "each", "over", "only",
  "also", "more", "most", "some", "such", "than", "very", "will", "would",
  "should", "could", "must", "about", "after", "before", "other", "parts",
]);
const HINT_SKIP = /^(issues|plans|knowledge|data|test|tests|docs?)\//;
const HINT_CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cc|cpp|cs)$/i;
const HINT_UI = /\b(ui|ux|screen|page|layout|colou?r|font|bold|badge|render)\b/i;

function hintWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter(
    (word) => word.length >= 4 && !HINT_STOP.has(word),
  );
}

export function buildIssueHints(l: ReturnType<typeof layout>, request: string): string[] {
  const hints: string[] = [];
  const tokens = [...new Set(hintWords(request))];
  const intent = new Set(hintWords(request.split("\n")[0] ?? ""));
  const wantsUi = HINT_UI.test(request);
  const cachedMap = readCachedMap(l.repoRoot);
  const candidates = (cachedMap?.files ?? [])
    .filter(
      (file) =>
        HINT_CODE.test(file.path) &&
        !HINT_SKIP.test(file.path) &&
        !/(^|\/)(test|tests|__tests__)\//.test(file.path) &&
        !/\.(test|spec)\.[tj]sx?$/.test(file.path),
    )
    .map((file) => {
      let header = "";
      try {
        header = readFileSync(join(l.repoRoot, file.path), "utf8").slice(0, 1500);
      } catch {}
      const ordered = [...file.symbols].sort((a, b) => {
        const aHit = tokens.some((token) => a.name.toLowerCase().includes(token)) ? 0 : 1;
        const bHit = tokens.some((token) => b.name.toLowerCase().includes(token)) ? 0 : 1;
        if (aHit !== bHit) return aHit - bHit;
        const aConst = a.kind === "const" ? 1 : 0;
        const bConst = b.kind === "const" ? 1 : 0;
        if (aConst !== bConst) return aConst - bConst;
        return a.line - b.line;
      });
      return {
        path: file.path,
        pathWords: new Set(file.path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
        headerWords: new Set(hintWords(header)),
        symbols: file.symbols.map((symbol) => symbol.name.toLowerCase()),
        // Up-front symbol map: the model can read { symbol } immediately
        // instead of spending calls on map symbols/outline to learn names.
        outline: ordered
          .slice(0, 8)
          .map((symbol) => `${symbol.name}:${symbol.line}`)
          .join(", "),
      };
    });
  const total = Math.max(1, candidates.length);
  const df = new Map(
    tokens.map((token) => [
      token,
      candidates.filter(
        (file) =>
          file.pathWords.has(token) ||
          file.headerWords.has(token) ||
          file.symbols.some((symbol) => symbol.includes(token)),
      ).length,
    ]),
  );
  const idf = (token: string): number => Math.log((total + 1) / ((df.get(token) ?? 0) + 1));
  const files = candidates
    .map((file) => {
      let score = 0;
      for (const token of tokens) {
        const inPath = file.pathWords.has(token);
        const inHeader = file.headerWords.has(token);
        const inSymbol = file.symbols.some((symbol) => symbol.includes(token));
        if (!inPath && !inHeader && !inSymbol) continue;
        const weight = (inPath ? 1.5 : 0) + (inHeader ? 1 : 0) + (inSymbol ? 0.2 : 0);
        score += weight * idf(token) ** 2 * (intent.has(token) ? 2 : 1);
      }
      if (wantsUi && file.path.startsWith("src/tui/")) score *= 1.6;
      return { path: file.path, score, outline: file.outline };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 5);
  if (files.length > 0) {
    const lines = files.map((file) =>
      file.outline ? `  - ${file.path} — ${file.outline}` : `  - ${file.path}`,
    );
    hints.push(`## Context\n\nRelevant files:\n${lines.join("\n")}`);
  }
  const skills = skillMetas(l);
  if (skills.length > 0) {
    hints.push(`## Skills\n\n${skills.map((s) => `  - ${s.name}: ${s.description}`).join("\n")}`);
  }
  return hints;
}

/** Update the local main branch from the remote. Non-blocking: if the remote is
 * unreachable the work continues with the local state. */
async function syncFromRemote(topRoot: string): Promise<void> {
  try {
    await runProc("git", ["fetch", "origin", "main:main"], { cwd: topRoot, timeoutMs: 30_000 });
  } catch {
    // Remote unreachable — local main is good enough.
  }
}

/** Merge a feature branch into main and push. Brings main into the worktree first
 * so conflicts surface there, then merges into main, pushes, and deletes the remote
 * branch. */
async function mergeBranch(topRoot: string, worktreeRoot: string, branch: string): Promise<boolean> {
  try {
    // Fetch the latest main from the remote so the merge is based on real upstream.
    await runProc("git", ["fetch", "origin", "main:main"], { cwd: topRoot, timeoutMs: 30_000 });
    // Bring main into the feature branch (conflicts surface in the worktree).
    await runProc("git", ["merge", "main", "-m", `sync ${branch} with main`], { cwd: worktreeRoot, timeoutMs: 30_000 });
    // Merge feature branch into main.
    await runProc("git", ["merge", branch, "--no-ff", "-m", `merge ${branch}`], { cwd: topRoot, timeoutMs: 30_000 });
    // Push the merge to the remote.
    await runProc("git", ["push", "origin", "main"], { cwd: topRoot, timeoutMs: 30_000 });
    // Delete the remote branch (may fail if it was never pushed — fine).
    try { await runProc("git", ["push", "origin", "--delete", branch], { cwd: topRoot, timeoutMs: 15_000 }); } catch {}
    await runProc("git", ["branch", "-D", branch], { cwd: topRoot, timeoutMs: 15_000 });
    await runProc("git", ["worktree", "remove", worktreeRoot], { cwd: topRoot, timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Commits dirty work, or accepts an existing commit on the branch. */
async function ensureCommitted(
  path: string,
  baseRef: string | undefined,
  message: string,
): Promise<string | null> {
  const committed = await commitWorktree({ path, message });
  if (committed.sha) return committed.sha;
  if (!baseRef) return null;
  const ahead = await runProc("git", ["rev-list", "--count", `${baseRef}..HEAD`], {
    cwd: path,
    timeoutMs: 30_000,
  });
  if ((Number(ahead.stdout.trim()) || 0) === 0) return null;
  const head = await runProc("git", ["rev-parse", "HEAD"], { cwd: path, timeoutMs: 30_000 });
  return head.stdout.trim() || null;
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
    // Agent must match the issue kind.
    if (normalizedAgent === "research" && issue.kind !== "ideas") {
      fail(`issue ${itemSlug} is ${issue.kind}, not an idea; research only runs on ideas`);
    }
    if (normalizedAgent === "engineer" && issue.kind === "ideas") {
      fail(`issue ${itemSlug} is an idea; research it first (machine_code issue run ${itemSlug})`);
    }
    if (normalizedAgent === "review" && issue.kind === "ideas") {
      fail(`issue ${itemSlug} is an idea; ideas are researched, not reviewed`);
    }
    // Engineer: only work on issues that are ready (todo) or blocked by review.
    if (normalizedAgent === "engineer" && issue.status !== "todo" && issue.status !== "blocked") {
      fail(`issue ${itemSlug} is ${issue.status}; engineer works on todo or blocked issues`);
    }
    // Review: only review issues that are done (agent review requested).
    if (normalizedAgent === "review" && issue.review !== "agent") {
      fail(`issue ${itemSlug} review is ${issue.review}; review only runs for agent review`);
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
      const hints = buildIssueHints(l, request);
      issue = writeIssue(l, {
        kind: normalizedAgent === "research" ? "ideas" : "features",
        slug: autoSlug,
        prompt: request,
        body: `Auto-created from run.\n\n${request}\n\n${hints.join("\n\n")}`,
        tags: [],
        review: "none",
      });
      // Commit immediately so the main worktree is clean for worktree creation.
      await commitPlanningFiles(l, `issues: auto-create ${autoSlug}`);
      autoCreatedIssue = true;
    }
    itemSlug = issue.slug;
    if (request.length === 0) request = issue.prompt || issue.title || itemSlug;
  }
  // Hints are recomputed for every run. An issue body may carry hints from
  // when it was created; those go stale as the code and the scorer change, so
  // strip the old generated sections and attach fresh ones. The issue file is
  // left untouched.
  if (itemSlug && !autoCreatedIssue && normalizedAgent === "engineer" && request) {
    const trimmed = request.split(/\n## (?:Context|Architecture|Skills|Verify)\b/)[0]!.trim();
    const hints = buildIssueHints(l, trimmed || request);
    if (hints.length > 0) {
      request = `${trimmed || request}\n\n${hints.join("\n\n")}`;
      process.stderr.write(`issue hints attached (${hints.length} sections)\n`);
    }
  }
  const { machine, policy, models, catalogue: catalogueDoc, configuredProviders } = await loadRuntime(l);
  const tier = flags.get("tier");
  if (tier !== undefined) {
    if (tier !== "free" && tier !== "paid") fail("--tier must be free|paid");
    machine.selection.tier = tier;
  }
  const minFit = flags.get("min-fit");
  if (minFit !== undefined) {
    const n = Number(minFit);
    if (!Number.isFinite(n) || n < 0 || n > 10) fail("--min-fit needs a number in 0-10");
    for (const ap of Object.values(policy.agents)) ap.minFit = n;
  }
  const minCapability = flags.get("min-capability");
  if (minCapability !== undefined) {
    const n = Number(minCapability);
    if (!Number.isFinite(n) || n < 0 || n > 10) fail("--min-capability needs a number in 0-10");
    for (const ap of Object.values(policy.agents)) ap.minCapability = n;
  }
  const minAxes = flags.get("min-axes");
  let minAxesSnapshot: Record<string, number> | undefined;
  if (minAxes !== undefined) {
    const axes = parseAxisOverrides(minAxes);
    minAxesSnapshot = axes;
    for (const ap of Object.values(policy.agents)) ap.minAxes = { ...(ap.minAxes ?? {}), ...axes };
  }
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
  if (contextIncludeFlag !== undefined) {
    try {
      const raw = JSON.parse(contextIncludeFlag) as { files?: unknown; knowledge?: unknown; plans?: unknown; references?: unknown; issues?: unknown };
      const strings = (value: unknown): string[] | undefined =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : undefined;
      contextInclude = {
        files: strings(raw.files),
        knowledge: strings(raw.knowledge),
        plans: strings(raw.plans),
        references: strings(raw.references),
        issues: strings(raw.issues),
      };
    } catch {
      fail("--context-include must be a JSON object");
    }
  }
  // The attached issue file is always explicit context, regardless of how the
  // run was started.
  if (itemSlug) {
    const issue = findIssue(l, itemSlug);
    if (issue) {
      contextInclude = contextInclude ?? {};
      contextInclude.files = [...new Set([...(contextInclude.files ?? []), issue.rel])];
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
  const skipSemantic = excludedSections.has("codebase") || excludedItems.has("semantic:index");
  if (requireProvider && !configuredProviders.has(requireProvider)) {
    fail(`provider "${requireProvider}" is not configured`);
  }

  if (modeFlag !== undefined) {
    fail("--mode was removed; runs execute directly per their agent role");
  }
  const agentNameParsed = normalizedAgent ?? "research";

  // Review binds to the engineer's worktree/commit automatically when the run
  // is attached to an issue. Explicit --review-of still wins.
  let reviewOf = flags.get("review-of");
  if (agentNameParsed === "review" && itemFlag !== undefined && reviewOf === undefined) {
    const item = slugify(itemFlag);
    const active = new Set(["created", "running", "awaiting_input"]);
    const candidate = listRuns(layout())
      .filter(
        (run) =>
          (run.itemId ?? run.packetId) === item &&
          (run.agent === "engineer" || run.agent === "build") &&
          Boolean(run.worktree) &&
          !active.has(run.status),
      )
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))[0];
    if (candidate) {
      reviewOf = candidate.id;
      process.stderr.write(`review bound to engineer run ${candidate.id.slice(-8)} (${candidate.branch ?? "worktree"})\n`);
    } else {
      process.stderr.write(`warning: no engineer worktree for ${item}; review runs against the main tree\n`);
    }
  }

  if (request.length === 0) {
    fail(`run needs a question, e.g. machine_code run "fix the parser panic"`);
  }

  // Probe cooling models with free metadata before a run record exists. A
  // recovered model can rejoin selection; if nothing is ready, block here
  // instead of starting a run that cannot make its first call.
  // Free-model cooldowns are per run: drop persisted free cooldowns first so
  // a free run always starts by looping best fit to worst across every listed
  // free model. Paid cooldowns are still honored here.
  const availabilityState = loadAvailability(l.home);
  try {
    clearFreeModelCooldowns(
      availabilityState,
      catalogueDoc.models.filter((row) => isFreeRow(row)).map((row) => row.key),
    );
  } catch {
    // catalogue scan failure must not block the run
  }
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
  const preflightInput = {
    agent: agentNameParsed,
    policy: policy.agents[agentNameParsed]!,
    machine,
    catalogue: catalogueDoc.models,
    configuredProviders,
    availability: availabilityState,
    fundedProviders: fundedProviderIds(machine.providers),
    contextChars: request.length,
    tier: machine.selection.tier,
    requireProvider,
    requireModel,
  };
  let preflight = pick(preflightInput);
  if ("error" in preflight && (requireModel || requireProvider)) {
    // A pin is a preference: if the pinned model is not ready before start,
    // fall back to auto-selection instead of refusing to start the run.
    const relaxed = pick({ ...preflightInput, requireProvider: undefined, requireModel: undefined });
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
    tier: machine.selection.tier,
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
      : agentNameParsed === "review"
        ? false
        : forceWorktree;
  let toolRoot = l.repoRoot;
  let reusedWorktree = false;
  if (mutating) {
    const issueWorktree = Boolean(itemSlug);
    // Reuse a terminal/paused worktree that already owns this issue branch.
    // A fresh path cannot be created while mc/<slug> is checked out.
    const reuse = reusableWorktreeOwner(
      [
        ...parentChainRuns,
        ...listAllRuns(l.home).filter((run) => run.repoRoot === l.repoRoot),
      ],
      issueWorktree ? `mc/${itemSlug}` : undefined,
    );
    if (reuse) {
      toolRoot = reuse.path;
      reusedWorktree = true;
      const refresh = await refreshReusedWorktree(reuse.path);
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
          // mc/<slug> is already checked out in another worktree: just use it.
          const branch = `mc/${itemSlug}`;
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
          const refresh = ownerActive ? "skipped" : await refreshReusedWorktree(existing);
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
          recorder.finalize("blocked", `${error.code}: ${error.message}`);
          process.stderr.write(`machine_code: ${error.code}: ${error.message}\n`);
          return EXIT.blocked;
        } else {
          throw error;
        }
      }
    }
  }

  // A reused worktree may hold prior commits and uncommitted changes from an
  // earlier run. Tell the agent what's already on the branch so it continues
  // the work instead of starting blind.
  if (reusedWorktree && toolRoot !== l.repoRoot) {
    try {
      const branch = recorder.current.branch ?? "";
      const log = await runProc("git", ["log", "--oneline", "-8"], { cwd: toolRoot, timeoutMs: 15_000 });
      const status = await runProc("git", ["status", "--short", "--branch"], { cwd: toolRoot, timeoutMs: 15_000 });
      const lines = [
        `## Existing branch state`,
        `You are continuing work on branch ${branch || "(unknown)"}, which already exists.`,
      ];
      if (log.code === 0 && log.stdout.trim()) lines.push(`Recent commits:\n${log.stdout.trim()}`);
      if (status.code === 0 && status.stdout.trim()) lines.push(`Working tree:\n${status.stdout.trim()}`);
      lines.push(`Build on this state: keep what works, fix or extend what doesn't. Do not restart from scratch.`);
      request = `${request}\n\n${lines.join("\n\n")}`;
      recorder.event("branch_state_reported", { branch });
    } catch {
      // Best effort: the agent can inspect the tree itself with core:status.
    }
  }

  // Context assembly (Phase 6): hierarchy + explicit artifacts + project
  // sources, written to context.json for provenance.
  const { assembleContext } = await import("../context/assemble.js");
  const { writeJsonAtomic } = await import("../state/run-schema.js");
  const { roleSkillPresets } = await import("../agents.js");
  const contextBundle = await assembleContext({
    layout: l,
    machine,
    agent: agentNameParsed,
    parentRuns: parentChain.length > 0 ? parentChain : undefined,
    ...(contextBudgetChars !== undefined ? { budgetChars: contextBudgetChars } : {}),
    exclude: contextExclude,
    include: contextInclude,
    defaultSkills: defaultSkillsFor({ agent: agentNameParsed }),
    skillPresets: roleSkillPresets(agentNameParsed),
    skillOverrides: skillModeOverrides,
  });
  if (contextBundle.text) {
    writeJsonAtomic(join(recorder.dir, "context.json"), { chars: contextBundle.chars, sources: contextBundle.sources, warnings: contextBundle.warnings, sections: contextBundle.sections });
    recorder.event("context_assembled", { chars: contextBundle.chars, sources: contextBundle.sources, warnings: contextBundle.warnings });
  }
  const contextText = contextBundle.text || undefined;
  // Pin the assembled file sources into the working set so the first prompt
  // already carries the code the run is about, instead of the model paging
  // for it over several turns.
  const seedFiles = contextBundle.sources
    .filter((source) => source.kind === "file" && typeof source.ref === "string")
    .map((source) => source.ref as string);
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

  // A review always judges the worktree/commit the engineer used. This must
  // happen for normal runs too, not only --direct-exec children.
  if (agentNameParsed === "review" && reviewOf) {
    const target = readRun(l, reviewOf);
    if (target?.summary.worktree && existsSync(target.summary.worktree)) {
      toolRoot = target.summary.worktree;
      recorder.patchSummary({
        worktree: target.summary.worktree,
        worktreeOwnerRunId: reviewOf,
        branch: target.summary.branch,
        baseBranch: target.summary.baseBranch,
        ...(target.summary.baseRef ? { baseRef: target.summary.baseRef } : {}),
      });
      recorder.event("review_of", { runId: reviewOf, worktree: target.summary.worktree });
    } else {
      process.stderr.write(`warning: review target ${reviewOf} has no worktree; reviewing the main tree\n`);
    }
  }

  let result: RunLoopResult | OrchestrateResult;
  let autoReview: { slug: string; prompt: string } | undefined;
  if (directExec) {
    // Detached delegated child: one agent, directly. Its prompt is its spec.
    const role = (agentNameParsed ?? "engineer") as AgentName;
    if (role !== "engineer" && role !== "review") {
      recorder.finalize("failed", "--direct-exec requires --agent engineer|review");
      process.stderr.write("machine_code: --direct-exec requires --agent engineer|review\n");
      return EXIT.failed;
    }
    const resolved = resolveAgent(l, role, {
      agentPolicy: policy.agents[role],
      machineOverrides: machine.agents[role],
      runOverrides: agentOverrides,
    });
    recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
    result = await runLoop({
      models,
      catalogue: catalogueDoc.models,
      configuredProviders,
      agent: resolved.def,
      agentConfig: resolved.config,
      agentCapabilities: resolved.capabilities,
      policy: policyFor(l, role, policy),
      layout: l,
      fullPolicy: policy,
      machine,
      request,
      root: l.repoRoot,
      toolRoot,
      home: l.home,
      availability: loadAvailability(l.home),
      recorder,
      commands: allCommands(l),
      requireProvider,
      requireModel,
      contextText,
      ...(seedFiles.length > 0 ? { seedFiles } : {}),
      skipMap,
      skipSemantic,
      skillExcludes,
      signal: abort.signal,
    });
  } else {
    result = await orchestrate({
      models,
      catalogue: catalogueDoc.models,
      configuredProviders,
      availability: loadAvailability(l.home),
      layout: l,
      machine,
      policy,
      agentName: agentNameParsed,
      request,
      root: l.repoRoot,
      toolRoot,
      agentOverrides,
      home: l.home,
      recorder,
      requireProvider,
      requireModel,
      contextText,
      ...(seedFiles.length > 0 ? { seedFiles } : {}),
      skipMap,
      skipSemantic,
      signal: abort.signal,
    });
  }

  // A research run is complete only when it produced at least one feature/bug
  // and every issue it wrote carries an acceptance gate. The model has no
  // move tool, so the runner owns the idea transition.
  if (result.status === "completed" && itemSlug && agentNameParsed === "research") {
    const issue = findIssue(l, itemSlug);
    if (issue?.kind === "ideas" && issue.status === "needs-research") {
      const events = readRun(l, recorder.id)?.events ?? [];
      const written = [...new Set(touchedPaths(events))].filter((path) =>
        /^issues\/(?:features|bugs)\//.test(path),
      );
      const missing = written
        .map((path) => findIssue(l, basename(path, ".md")))
        .filter((created) => created !== null && created.acceptance.length === 0);
      if (written.length > 0 && missing.length === 0) {
        moveIssue(l, issue.slug, "researched");
        await commitPlanningFiles(l, `issues: ${issue.slug} researched`);
        recorder.event("idea_researched", { slug: issue.slug, created: written.length });
      } else if (missing.length > 0) {
        recorder.event("research_missing_acceptance", {
          slug: issue.slug,
          issues: missing.map((created) => created!.slug),
        });
        process.stderr.write(
          `research left ${issue.slug} unresearched: ${missing.length} created issue(s) lack acceptance\n`,
        );
      }
    }
  }

  // A review verdict is a work-item decision, not just prose. Any
  // non-approved verdict on a completed review sends the issue back to
  // blocked/ so approve cannot merge rejected work.
  if (itemSlug && agentNameParsed === "review") {
    const issue = findIssue(l, itemSlug);
    const verdict =
      result.status === "completed"
        ? parseReviewVerdict(result.finalText) ?? inferReviewVerdict(result.finalText)
        : undefined;
    if (verdict) recorder.event("review_verdict", { verdict });
    // Auto-merge when the review agent approves
    if (verdict === "approved" && toolRoot !== l.repoRoot) {
      const branch = recorder.current.branch;
      if (branch) {
        const merged = await mergeBranch(l.repoRoot, toolRoot, branch);
        if (merged) {
          recorder.event("branch_merged", { branch, verdict: "approved" });
        } else {
          result = { ...result, status: "blocked", error: `merge failed: ${branch} into main (conflict or dirty tree)` };
        }
      }
    }
    if (
      issue &&
      issue.status === "done" &&
      (result.status === "blocked" || result.status === "failed" || (verdict !== undefined && verdict !== "approved"))
    ) {
      moveIssue(l, issue.slug, "blocked");
      await commitPlanningFiles(l, `issues: ${issue.slug} review ${verdict ?? result.status}`);
    }
  }

  // Engineer runs are the finish line for an issue: gates, commit, and the
  // directory move happen in the runner, not in the prompt. Without this a
  // "completed" run could leave uncommitted work and the issue in todo/.
  if (
    result.status === "completed" &&
    itemSlug &&
    (agentNameParsed === "engineer" || agentNameParsed === "research") &&
    toolRoot !== l.repoRoot
  ) {
    const issue = findIssue(l, itemSlug);
    if (issue) {
      const commands = allCommands(l);
      const gateOutcome = await runGates(resolveGates(issueToTaskPacket(issue)), {
          root: toolRoot,
          commands,
        });
        const gatesPassed = gateOutcome.passed;
        recorder.event("gates", {
          issue: issue.slug,
          passed: gatesPassed,
          results: gateOutcome.results.map((r) => ({ command: r.command, passed: r.passed, durationMs: r.durationMs })),
        });
        if (!gatesPassed) {
          moveIssue(l, issue.slug, "blocked");
          await commitPlanningFiles(l, `issues: ${issue.slug} blocked`);
          result = {
            ...result,
            status: "blocked",
            error: `acceptance gates failed: ${gateOutcome.results.filter((r) => !r.passed).map((r) => r.command).join(", ")}`,
          };
        }
      if (gatesPassed) {
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
          result = { ...result, status: "blocked", error: "engineer produced no committable change" };
        } else if (commit) {
          recorder.patchSummary({ commit });
          recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, issue: issue.slug });
          // Ideas move to researched (handled above when they produced
          // issues); only features/bugs move to done. "done" is not a
          // legal status for ideas.
          if (issue.kind !== "ideas") {
            moveIssue(l, issue.slug, "done");
            await commitPlanningFiles(l, `issues: ${issue.slug} done`);
          }
          // Auto-merge: if no review required, merge the branch into main
          if (issue.review === "none") {
            const branch = recorder.current.branch;
            if (branch) {
              const merged = await mergeBranch(l.repoRoot, toolRoot, branch);
              if (merged) {
                recorder.event("branch_merged", { branch });
              } else {
                result = { ...result, status: "blocked", error: `merge failed: ${branch} into main (conflict or dirty tree)` };
              }
            }
          }
          if (issue.review === "agent" && !flags.has("no-review")) {
            autoReview = { slug: issue.slug, prompt: issue.prompt };
          }
        }
      }
    }
  }
  recorder.finalize(result.status, result.error, result.finalText);
  if (agentNameParsed === "research") {
    // Research writes issues//knowledge in the main tree; commit
    // them so the map stays the committed source of truth.
    await commitPlanningFiles(l, `plans: ${agentNameParsed} run ${recorder.id.slice(-8)}`);
  }
  printRunOutcome(result, recorder);
  // One-way notification on terminal state (M4).
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
  if (autoReview) {
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "run", "--agent", "review", "--item", autoReview.slug, autoReview.prompt],
      { cwd: l.repoRoot, detached: true, stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
    process.stderr.write(`review ${autoReview.slug} started (review=agent)\n`);
  }
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
  const { machine, policy, models, catalogue, configuredProviders } = runtime;
  const commands = allCommands(l2);

  // Worktree: reuse, recreate from branch, or (with --recreate) start fresh.
  let toolRoot = l2.repoRoot;
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
  }

  const recorder = RunRecorder.reopen(l2, s);
  recorder.setStatus("running", "resume");
  recorder.patchSummary({ pid: process.pid });
  recorder.event("resume_started", { fromStatus: s.status });

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

  const resolved = resolveAgent(l2, resumeAgent, {
    agentPolicy: policy.agents[resumeAgent],
    machineOverrides: machine.agents[resumeAgent],
  });
  const result = await runLoop({
    models,
    catalogue: catalogue.models,
    configuredProviders,
    agent: resolved.def,
    agentConfig: resolved.config,
    agentCapabilities: resolved.capabilities,
    policy: policyFor(l2, resumeAgent, policy),
    layout: l2,
    fullPolicy: policy,
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
  });

  // A resumed Engineer phase still owes the runner its gates, commit, and move.
  let autoReview: { slug: string; prompt: string } | undefined;
  const resumeItem = s.itemId ?? s.packetId;
  if (result.status === "completed" && resumeAgent === "engineer" && resumeItem) {
    const issue = findIssue(l2, resumeItem);
    if (issue) {
      const gateOutcome = await runGates(resolveGates(issueToTaskPacket(issue)), { root: toolRoot, commands });
        recorder.event("gates", {
          issue: issue.slug,
          passed: gateOutcome.passed,
          results: gateOutcome.results.map((r) => ({ command: r.command, passed: r.passed, durationMs: r.durationMs })),
        });
        if (!gateOutcome.passed) {
          moveIssue(l2, issue.slug, "blocked");
          await commitPlanningFiles(l2, `issues: ${issue.slug} blocked`);
          recorder.finalize("blocked", `acceptance gates failed: ${gateOutcome.results.filter((r) => !r.passed).map((r) => r.command).join(", ")}`, result.finalText);
          printRunOutcome({ ...result, status: "blocked" }, recorder);
          return EXIT.blocked;
        }
      if (toolRoot !== l2.repoRoot) {
        try {
          const commit = await ensureCommitted(
            toolRoot,
            recorder.current.baseRef,
            `mc(${issue.slug}): ${issue.prompt}\n\nrun: ${recorder.id}\nissue: ${issue.slug}`,
          );
          if (commit) {
            recorder.patchSummary({ commit });
            recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, issue: issue.slug });
            if (issue.kind !== "ideas") {
              moveIssue(l2, issue.slug, "done");
              await commitPlanningFiles(l2, `issues: ${issue.slug} done`);
            }
            // Auto-merge: if no review required, merge the branch into main
            if (issue.review === "none") {
              const branch = recorder.current.branch;
              if (branch) {
                await mergeBranch(l2.repoRoot, toolRoot, branch);
                recorder.event("branch_merged", { branch });
              }
            }
            if (issue.review === "agent" && !flags.has("no-review")) {
              autoReview = { slug: issue.slug, prompt: issue.prompt };
            }
          }
        } catch (error) {
          recorder.finalize("blocked", `commit failed: ${error instanceof Error ? error.message : String(error)}`, result.finalText);
          printRunOutcome({ ...result, status: "blocked" }, recorder);
          return EXIT.blocked;
        }
      }
    }
  }

  if (resumeAgent === "review" && resumeItem) {
    const issue = findIssue(l2, resumeItem);
    const verdict =
      result.status === "completed"
        ? parseReviewVerdict(result.finalText) ?? inferReviewVerdict(result.finalText)
        : undefined;
    if (verdict) recorder.event("review_verdict", { verdict });
    // Auto-merge when the review agent approves
    if (verdict === "approved" && toolRoot !== l2.repoRoot) {
      const branch = recorder.current.branch;
      if (branch) {
        await mergeBranch(l2.repoRoot, toolRoot, branch);
        recorder.event("branch_merged", { branch, verdict: "approved" });
      }
    }
    if (
      issue &&
      issue.status === "done" &&
      (result.status === "blocked" || result.status === "failed" || (verdict !== undefined && verdict !== "approved"))
    ) {
      moveIssue(l2, issue.slug, "blocked");
      await commitPlanningFiles(l2, `issues: ${issue.slug} review ${verdict ?? result.status}`);
    }
  }

  recorder.finalize(result.status, result.error, result.finalText);
  printRunOutcome(result, recorder);
  const summary = recorder.current;
  process.stderr.write(
    `\nrun ${summary.id}: ${summary.status}${summary.stopReason && summary.stopReason !== "completed" ? ` (${summary.stopReason})` : ""} — ${summary.modelCalls} call(s), ${summary.usage.totalTokens} tokens, $${summary.cost.actual.toFixed(6)} actual\n`,
  );
  if (autoReview) {
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "run", "--agent", "review", "--item", autoReview.slug, autoReview.prompt],
      { cwd: l2.repoRoot, detached: true, stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
    process.stderr.write(`review ${autoReview.slug} started (review=agent)\n`);
  }
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
