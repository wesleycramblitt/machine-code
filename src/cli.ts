#!/usr/bin/env node
/**
 * machine_code — CLI.
 *
 * M0: init, providers, catalogue refresh, run, log, status.
 * The TUI becomes the default command in M3.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "./paths.js";
import { loadEnvFiles } from "./env.js";
import { loadMachineConfig, loadPolicy, ConfigError, DEFAULT_AGENT_POLICY, AGENT_NAMES, SELECTION_TIERS } from "./config.js";
import { createModelsCollection, availableChatModels, providerStatuses } from "./models.js";
import { refreshCatalogue } from "./catalogue/refresh.js";
import { loadCatalogue } from "./catalogue/load.js";
import { filterModels, siblingOffers, type ModelSort } from "./catalogue/query.js";
import { snapshotFiles } from "./catalogue/snapshot.js";
import { pick, axisWeights } from "./select.js";
import { CAPABILITY_AXES } from "./config.js";
import type { CatalogueDocument, CatalogueRow } from "./catalogue/types.js";
// agents resolved inside orchestrate.ts
import { orchestrate, type RunMode } from "./orchestrate.js";
import { RunRecorder, listRuns, listAllRuns, readRun, registerProject, reconcileRun, pruneRuns, listProjects, sendControl, waitForControlAck, isPidAlive, type RunStatus, type RunSummary } from "./state/runs.js";
import { appendInbox, readInbox, latestUnansweredQuestion } from "./state/question.js";
import { loadTranscript, repairResumeTail } from "./state/transcript.js";
import { packetPath, readPacket } from "./packet.js";
import { agentDef, type AgentName } from "./agents.js";
import { resolveAgent, resolveAgentConfig, type AgentConfig } from "./agents/config.js";
import { issueAccessFromCapabilities } from "./policy/capabilities.js";
import { runLoop, type RunLoopResult } from "./loop.js";
import { policyFor, type OrchestrateResult } from "./orchestrate.js";
import { resolveGates, runGates } from "./verify.js";
import { allCommands } from "./commands/profiles.js";
import { createWorktree, removeWorktree, pruneWorktrees, recreateWorktreeFromBranch, branchExists, WorktreeError } from "./worktree.js";
import { createIssueProvider } from "./issues/index.js";
import { parseIssueRef, type Issue, type IssueRef } from "./issues/provider.js";
import { ensureEpicReserved, ensureFeatureReserved } from "./issues/reserved.js";
import { resolveRunTarget } from "./issues/work.js";
import { checkCompletion, cascadeReserved } from "./issues/completion.js";
import { loadAvailability, saveAvailability } from "./availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "./availability/probe.js";
import { latestProcessRecords } from "./processes/registry.js";
import { readLogTail } from "./processes/logs.js";
import { reconcileProcessRecords } from "./processes/reconcile.js";
import { planSchedule, type OrchestrationScope } from "./orchestrator/scheduler.js";
import { executeTask } from "./orchestrator/execute.js";
import { isRetryableFailure } from "./orchestrator/outcome.js";
import { acquireLease, createOrchestration, listOrchestrations, readOrchestration, releaseLease, updateOrchestration, type OrchestrationState } from "./orchestrator/state.js";
import { terminateAllProcesses, terminateProcessRecord } from "./processes/supervisor.js";
import { filterRuns, sortRuns, type RunFilter } from "./tui/status.js";
import { readIssueCache } from "./issues/cache.js";
import { readSpendSummary, spendDays, spendBar, type SpendBucket } from "./spend.js";
import { buildRunIndex, repoLabel, repoOf, type RunGroup, type RunRow } from "./tui/runs.js";
import { listArtifacts, artifactSummary, resolveArtifact, artifactPath, artifactExists } from "./artifacts/registry.js";
import { artifactPeek } from "./context/preview.js";
import { changesFor, childRuns, contextUsage, readContextManifest, thinkingChunks, touchedPaths } from "./report/run.js";
import { buildSettings, settingsFileFor } from "./tui/settings.js";
import { fundedProviderIds, loadProviderDefinitions, packageDataDir } from "./data.js";
import { runTui } from "./tui.js";
import { SEARCH_EXCLUDES } from "./tools/safety.js";
import { BASE_CLIS, findOnPath, installClis, type InstallMethod } from "./install.js";

/* ---------------------------------------------------------- runtime setup */

interface Runtime {
  machine: ReturnType<typeof loadMachineConfig>;
  policy: ReturnType<typeof loadPolicy>;
  models: ReturnType<typeof createModelsCollection>;
  catalogue: NonNullable<ReturnType<typeof loadCatalogue>>;
  configuredProviders: Set<string>;
}

/** Shared setup for run/queue/resume: config, providers, catalogue. */
async function loadRuntime(l: ReturnType<typeof layout>): Promise<Runtime> {
  let machine;
  let policy;
  try {
    machine = loadMachineConfig(l);
    policy = loadPolicy(l);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  const models = createModelsCollection();
  const definitions = loadProviderDefinitions();
  const dynamicProviders = Object.entries(definitions)
    .filter(([, def]) => def.discovery === "openai-compatible" || def.discovery === "ollama")
    .map(([id]) => id);
  if (dynamicProviders.length > 0) {
    const refreshed = await models.refresh({ allowNetwork: true, providers: dynamicProviders });
    for (const [id, error] of refreshed.errors) {
      const def = definitions[id];
      if (def?.discovery === "ollama") {
        process.stderr.write(`warning: ollama model discovery failed: ${error.message}\n`);
      }
    }
  }
  const statuses = providerStatuses(models);
  const configuredProviders = new Set(statuses.filter((s) => s.configured).map((s) => s.id));
  if (configuredProviders.size === 0) {
    fail("no configured providers — set a provider key (e.g. OPENROUTER_API_KEY, OPENCODE_API_KEY)");
  }
  let catalogue = loadCatalogue(l.catalogueFile);
  if (!catalogue) {
    process.stderr.write("no catalogue on disk; refreshing (machine_code catalogue refresh to redo later)\n");
    const { models: available, warnings } = await availableChatModels(models);
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    const result = await refreshCatalogue(l, [...available], { openRouterKey: process.env.OPENROUTER_API_KEY });
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    catalogue = result.document;
  }
  return { machine, policy, models, catalogue, configuredProviders };
}

const VERSION = "0.0.0";

const HELP = `machine_code ${VERSION}

Usage:
  machine_code run --agent general [--provider <id>] [--model <key>] "<question>"
  machine_code run --agent planner "<plan a project>" [--issue <n>]
  machine_code run --agent architect [--mode direct|verified|redundant] "<task>" [--issue <n> [--auto-issue]]
  machine_code run --agent sudo "<rare task>" [--worktree]
                                    Sudo edits the main tree by default; --worktree isolates it.
                                    Build and orchestrated runs use an isolated worktree:
                                    [--issue <n>] [--auto-issue] [--issue-type task|feature]
                                    [--feature <n>] [--base <ref>]
                                    Agent config overrides:
                                    [--preset plan|orchestrate|implement|review|assistant|unrestricted]
                                    [--delegate true|false] [--verify direct|verified|redundant]
                                    [--issues required|optional|disabled] [--ask true|false]
                                    [--approval human|agent] [--ambiguity strict|precise|adaptive|autonomous]
                                    [--mode <agent mode>] (roles declare their own modes)
                                    [--allow-issue-create] explicit issue:create override
                                    [--allow-artifact-scripts] permit executable artifact scripts
                                    [--tier free|paid] [--min-fit N] [--min-capability N]
                                    [--min-axes code=6.5,agentic=7]
                                    [--context-exclude '<json>'] omit selected context
                                    sections or sources from a run
  machine_code init                 Check CLIs, config, and repo layout
  machine_code install [--method download|pacman|apt|dnf|zypper|apk|cargo] [cli...]
                                    Install missing base CLIs (default: pinned static binaries)
  machine_code providers            List providers, key sources, and model counts
  machine_code models [filter]      Inspect the catalogue (--all, --provider, --family, --free,
                                    --coding, --tool, --min-cap, --axis, --sort, --axes, --json)
  machine_code policy [role]        Show effective capability policy (--json)
  machine_code policy edit [--repo] Edit machine defaults or repo overrides
  machine_code models --agent <role> Dry-run selection (--context-chars N, --min-fit N,
                                    --min-capability N, --min-axes code=6.5, --tier free|paid)
  machine_code catalogue refresh    Rebuild ~/.machine_code/catalogue/models.json
                                    [--snapshot] also update data/models + data/offers
  machine_code catalogue snapshot   Write committed data/models + data/offers [base-dir]
  machine_code runs [--group gh-issue|status|overall] [--filter ...] [--text Q]
                                    Run hierarchy grouped by repo/issue or status
  machine_code show <run-id>        Rich run detail: model, ask, context, state, changes,
                                    children [--events] [--thinking] [--changes] [--context]
                                    [--state] [--json]
  machine_code processes <run-id>   List run-owned processes [--json]
  machine_code processes kill <run-id> <process-id|all>
  machine_code processes logs <run-id> <process-id>
  machine_code context <run-id>     Print the run context manifest
  machine_code map [path]           Deterministic repo map (--status, --refresh, --json,
                                    --no-symbols, --semantic)
  machine_code prompts [role]       Print rendered agent prompts with chars and words (--json)
  machine_code spend [--days N] [--by provider|model|day|agent] [--json]
  machine_code tools [tool|script]  List repo/machine tools and scripts
  machine_code tools new <name>     Create an executable script + manifest
  machine_code tools add <name>     Add a reusable tool manifest
  machine_code tools show <name>    Show manifest and script
  machine_code config [paths|show|edit [machine|repo|file]]
  machine_code correct <run-id> "<correction>"  Interrupt and fork a corrective run
  machine_code log <run-id>         Print a run's summary and events
  machine_code status               List runs across projects
  machine_code resume <run-id>      Resume an interrupted/paused/awaiting run [--recreate]
  machine_code respond <run-id> "<answer>"  Answer a run's pending question
  machine_code pause <run-id>       Pause a running run (resumable)
  machine_code cancel <run-id>      Cancel a running run
  machine_code fork <run-id> "<objective>"  Fork a run as a new objective
                                    [--inherit-worktree]
  machine_code prune [--days N]     Remove old run dirs and worktrees (default 7 days)
  machine_code worktree list        List run worktrees and branches
  machine_code worktree remove <run-id> [--delete-branch] [--force]
  machine_code issue list|view|tree|create|edit|close|reopen|link|ensure
                                    GitHub issue operations (hierarchy enforced)
  machine_code approve <issue|pr>   Approve a pending human close/merge request
  machine_code accept <issue>       Record a human acceptance verdict (needed to close)
  machine_code pr feature <n>       Open the Feature PR to main after tasks/gates
  machine_code pr list|status <n>   Inspect pull requests
  machine_code provider disable|enable <name>
  machine_code provider cooldown <name> [minutes] | cooldown clear <name>
  machine_code model show <key|name>   Inspect axes, offers, providers for a model
  machine_code model probe <key|name>  Probe model availability (free metadata)
  machine_code model cooldown clear <id>
  machine_code availability [--probe] [--free-only] [--json]
                                    Show or probe cooling model availability
  machine_code orchestrate status|tick|start [--dry-run]
                                    [--scope project|epic|feature] [--epic <n>|--feature <n>]
                                    Compute or execute ready issue-graph tasks
  machine_code orchestrate approve --orchestration <id> --task <n> [--result]
                                    Approve a packet or result checkpoint
  machine_code tui                 Launch the TUI (default when interactive)
  machine_code queue               Process committed packets in .machine_code/tasks/
  machine_code version
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`machine_code: ${message}\n`);
  process.exit(code);
}

/** Flags that are switches: bare `--name` is true and never consumes the next arg. */
const BOOLEAN_FLAGS = new Set([
  "all",
  "attention",
  "allow-artifact-scripts",
  "allow-issue-create",
  "auto-issue",
  "axes",
  "changes",
  "context",
  "events",
  "full",
  "thinking",
  "delete-branch",
  "direct-exec",
  "dry-run",
  "force",
  "free",
  "free-only",
  "coding",
  "probe",
  "result",
  "tool",
  "inherit-worktree",
  "worktree",
  "json",
  "recreate",
  "status",
  "refresh",
  "no-symbols",
  "semantic",
  "state",
]);

function parseFlags(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, "true");
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`flag ${arg} needs a value`);
      flags.set(name, next);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const EXIT: Record<RunStatus, number> = {
  created: 1,
  running: 1,
  awaiting_input: 1,
  paused: 1,
  completed: 0,
  blocked: 2,
  failed: 1,
  interrupted: 130,
  cancelled: 1,
};

/* -------------------------------------------------------------------- init */

function cmdInit(): number {
  const l = layout();
  let problems = 0;
  process.stdout.write("machine_code init\n\nBase palette:\n");
  for (const cli of BASE_CLIS) {
    const found = findOnPath(cli.binaries);
    if (found) {
      process.stdout.write(`  ok       ${cli.name} (${cli.purpose})\n`);
    } else {
      process.stdout.write(`  MISSING  ${cli.binaries.join("/")} (${cli.purpose}) — run: machine_code install ${cli.name}\n`);
      problems += 1;
    }
  }
  // Profile dependencies (language servers) — checked, not auto-installed.
  process.stdout.write("\nProfile dependencies:\n");
  const servers = [{ name: "typescript-language-server", purpose: "TypeScript LSP (check/rename/semantic search)" }];
  for (const s of servers) {
    const found = findOnPath([s.name]);
    if (found) process.stdout.write(`  ok       ${s.name} (${s.purpose})\n`);
    else process.stdout.write(`  MISSING  ${s.name} (${s.purpose}) — install: npm i -g ${s.name}\n`);
  }

  process.stdout.write("\nOptional integrations:\n");
  if (findOnPath(["gh"])) {
    process.stdout.write(`  ok       gh (GitHub issues/PRs — machine_code issue ...)\n`);
  } else {
    process.stdout.write(`  MISSING  gh (GitHub issues/PRs) — install: https://cli.github.com (issue tracking disabled without it)\n`);
  }

  mkdirSync(l.localDir, { recursive: true });
  mkdirSync(join(l.home, "catalogue"), { recursive: true });

  // The local-state ignore rule must exist before anything writes there.
  const gitignore = join(l.repoRoot, ".gitignore");
  const rule = ".machine_code/local/";
  let ignored = false;
  if (existsSync(gitignore)) {
    ignored = readFileSync(gitignore, "utf8").split("\n").some((line) => line.trim() === rule);
  }
  if (!ignored) {
    writeFileSync(gitignore, `${existsSync(gitignore) ? readFileSync(gitignore, "utf8").replace(/\n*$/, "\n") : ""}${rule}\n`, "utf8");
    process.stdout.write(`\nadded ${rule} to .gitignore\n`);
  }

  if (!existsSync(l.policyFile)) {
    mkdirSync(l.repoDir, { recursive: true });
    writeFileSync(
      l.policyFile,
      `# machine_code repo policy (committed). Unknown keys are ignored.\n` +
        `\n` +
        `# Excluded from every search, in addition to the built-in set:\n` +
        `#   ${SEARCH_EXCLUDES.join(", ")}\n` +
        `# search_exclude = ["fixtures/large"]\n` +
        `\n[agents.general]\n` +
        `# min_context = 32000\n` +
        `# expected_output_tokens = 2000\n` +
        `# max_output_tokens = 8000\n` +
        `# budget_tokens = 200000\n` +
        `# min_fit = 7.0\n` +
        `# min_capability = 0\n` +
        `# [agents.general.axes]\n` +
        `# reasoning = 7.2\n` +
        `# code = 6.0\n` +
        `# agentic = 6.0\n` +
        `# general = 6.0\n`,
      "utf8",
    );
    process.stdout.write(`wrote ${l.policyFile}\n`);
  }

  try {
    loadMachineConfig(l);
    loadPolicy(l);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  if (!existsSync(l.catalogueFile)) {
    process.stdout.write(`\nno catalogue yet — run: machine_code catalogue refresh\n`);
  }
  if (problems > 0) {
    process.stdout.write(`\n${problems} base CLI(s) missing; run: machine_code install\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ install */

const INSTALL_METHODS: readonly InstallMethod[] = ["download", "pacman", "apt", "dnf", "zypper", "apk", "cargo"];

async function cmdInstall(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const method = (flags.get("method") ?? "download") as InstallMethod;
  if (!INSTALL_METHODS.includes(method)) {
    fail(`unknown method ${method}; choose from ${INSTALL_METHODS.join(", ")}`);
  }
  const l = layout();
  return installClis({ method, home: l.home, only: positional.length > 0 ? positional : undefined });
}

/* --------------------------------------------------------------- providers */

function cmdProviders(): number {
  const models = createModelsCollection();
  const statuses = providerStatuses(models);
  const l = layout();
  const catalogue = loadCatalogue(l.catalogueFile);
  let funded = new Set<string>();
  try {
    funded = fundedProviderIds(loadMachineConfig(l).providers);
  } catch {
    funded = fundedProviderIds({});
  }
  const catalogueCounts = new Map<string, number>();
  for (const row of catalogue?.models ?? []) {
    catalogueCounts.set(row.providerID, (catalogueCounts.get(row.providerID) ?? 0) + 1);
  }
  const configured = statuses.filter((s) => s.configured);
  process.stdout.write("Providers (key sources are environment variable names; values are never shown):\n\n");
  process.stdout.write(`  ${"status".padEnd(13)} ${"provider".padEnd(24)} ${"models".padStart(6)}  ${"funding".padEnd(9)} ${"modes".padEnd(20)} ${"price range $/M".padEnd(30)} keys\n`);
  for (const s of statuses) {
    const mark = s.configured ? "configured  " : "unconfigured";
    const keys = s.envKeys.length > 0 ? s.envKeys.join(", ") : "(no env key — OAuth or ambient)";
    const source = s.source ? ` via ${s.source}` : "";
    const count = catalogueCounts.get(s.id) ?? s.modelCount;
    const cp = catalogue?.providers?.[s.id];
    const funding = funded.has(s.id) ? "funded" : "unfunded";
    const modes = cp?.modes?.join("/") ?? "-";
    const fmt = (n: number) => String(Number(n.toFixed(6)));
    const price = cp?.pricing
      ? `in ${fmt(cp.pricing.minInput ?? 0)}–${fmt(cp.pricing.maxInput ?? 0)}, out ${fmt(cp.pricing.minOutput ?? 0)}–${fmt(cp.pricing.maxOutput ?? 0)}`
      : cp?.billing?.kind === "free_tier"
        ? "free"
        : "-";
    process.stdout.write(
      `  ${mark.padEnd(13)} ${s.id.padEnd(24)} ${String(count).padStart(6)}  ${funding.padEnd(9)} ${modes.padEnd(20)} ${price.padEnd(30)} ${keys}${source}\n`,
    );
  }
  const notes: string[] = [];
  for (const status of statuses) {
    const billing = catalogue?.providers?.[status.id]?.billing;
    if (!billing) continue;
    if (typeof billing.monthlyUsd === "number") {
      notes.push(
        `${status.id}: $${billing.monthlyUsd}/mo → $${billing.includedUsd ?? "?"} included` +
          `${billing.fallback ? `, then ${billing.fallback} prices` : ""}`,
      );
    } else if (billing.kind === "free_tier") {
      notes.push(`${status.id}: free tier`);
    }
  }
  if (notes.length > 0) process.stdout.write(`\nbilling: ${notes.join("   ")}\n`);
  process.stdout.write(`\n${configured.length} configured.\n`);
  return configured.length > 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ policy */

function policyTemplate(kind: "machine" | "repo"): string {
  if (kind === "machine") {
    return `# machine_code machine config (global defaults; repo policy wins)
[selection]
tier = "paid"              # free | paid
# first_token_timeout_ms = 60000   # abandon a stalled call; cool it and retry
# min_fit = 7.0            # global role-weighted capability floor
# min_capability = 0       # neutral composite safety floor (optional)
# min_context = 32000
# tool_call = true
# [selection.axes]         # global per-axis floors
# reasoning = 7.0
# code = 6.0
# [selection.weights]      # global role-agnostic axis weights
# reasoning = 0.25

[providers.opencode-go]
# Subscription quota is worth ~6x list; 0.5 is a conservative 2x discount.
cost_multiplier = 0.5
funded = true
`;
  }
  return `# machine_code repo policy (committed; overrides machine config)
# [agents.build]
# min_fit = 7.0           # primary role-weighted gate
# [agents.build.axes]
# code = 6.5
# agentic = 6.5
# reasoning = 5.5
# general = 3.0
# [agents.build.weights]
# code = 0.40
`;
}

/** Show effective selector policy or open its source file in $EDITOR. */
function cmdPolicy(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const l = layout();

  if (positional[0] === "edit") {
    const target = flags.has("repo") ? l.policyFile : l.machineConfig;
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, policyTemplate(flags.has("repo") ? "repo" : "machine"), "utf8");
    }
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const result = spawnSync(editor, [target], { stdio: "inherit" });
    if (result.error) fail(`could not launch editor ${editor}: ${result.error.message}`);
    return result.status ?? 0;
  }

  const machine = loadMachineConfig(l);
  const policy = loadPolicy(l);
  const issueAccessFor = (name: string): string =>
    resolveAgentConfig({
      role: name,
      agentPolicy: policy.agents[name],
      machineOverrides: machine.agents[name],
    }).issueAccess ?? agentDef(l, name).issueAccess;

  if (flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tier: machine.selection.tier,
          providers: machine.providers,
          builtIn: DEFAULT_AGENT_POLICY,
          agents: policy.agents,
          modes: Object.fromEntries(AGENT_NAMES.map((name) => {
            const def = agentDef(l, name);
            return [name, { modes: def.modes, default: def.defaultMode ?? null, config: def.modeConfig }];
          })),
          issueAccess: Object.fromEntries(AGENT_NAMES.map((name) => [name, issueAccessFor(name)])),
          files: { machine: l.machineConfig, repo: l.policyFile },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const role = positional[0];
  if (role !== undefined && !(AGENT_NAMES as readonly string[]).includes(role)) {
    fail(`unknown agent "${role}"; choose one of ${AGENT_NAMES.join(", ")}`);
  }

  process.stdout.write(`selection tier: ${machine.selection.tier}  (${SELECTION_TIERS.join(" | ")})\n`);
  const funded = [...fundedProviderIds(machine.providers)].sort();
  process.stdout.write(`funded providers: ${funded.join(", ") || "(none — free rows only)"}\n`);
  const multipliers = Object.entries(machine.providers).filter(([, v]) => v.costMultiplier !== undefined);
  if (multipliers.length > 0) {
    process.stdout.write(
      `provider multipliers: ${multipliers.map(([id, v]) => `${id} ×${v.costMultiplier}`).join("  ")}\n`,
    );
  }
  process.stdout.write(`machine defaults: ${l.machineConfig}  [selection] / [agents.<role>]\n`);
  process.stdout.write(`repo overrides:   ${l.policyFile}  [agents.<role>]\n`);
  process.stdout.write(`built-in:         min_fit ${DEFAULT_AGENT_POLICY.minFit}  min_capability ${DEFAULT_AGENT_POLICY.minCapability}  min_context ${DEFAULT_AGENT_POLICY.minContext}  expected_out ${DEFAULT_AGENT_POLICY.expectedOutputTokens}\n`);

  const names = role ? [role] : [...AGENT_NAMES];
  for (const name of names) {
    const ap = policy.agents[name]!;
    const floors = CAPABILITY_AXES.filter((axis) => (ap.minAxes?.[axis] ?? 0) > 0)
      .map((axis) => `${axis}≥${ap.minAxes![axis]}`)
      .join(" ");
    const freeFloors = CAPABILITY_AXES.filter((axis) => (ap.freeMinAxes?.[axis] ?? 0) > 0)
      .map((axis) => `${axis}≥${ap.freeMinAxes![axis]}`)
      .join(" ");
    const effectiveWeights = axisWeights(name, ap);
    const weights = CAPABILITY_AXES.map((axis) => `${axis} ${effectiveWeights[axis].toFixed(2)}`).join("  ");
    process.stdout.write(`\n[${name}]\n`);
    process.stdout.write(`  min_fit ${ap.minFit}   min_capability ${ap.minCapability}   min_context ${ap.minContext}   expected_out ${ap.expectedOutputTokens}   tool_call ${ap.toolCall}\n`);
    process.stdout.write(`  free     min_fit ${ap.freeMinFit ?? ap.minFit}   min_capability ${ap.freeMinCapability ?? ap.minCapability}   axes ${freeFloors || "(inherits paid)"}\n`);
    const def = agentDef(l, name);
    process.stdout.write(`  issue_access ${issueAccessFor(name)}\n`);
    process.stdout.write(`  modes ${def.modes.length ? `${def.modes.join(", ")}${def.defaultMode ? ` (default ${def.defaultMode})` : ""}` : "single-agent"}\n`);
    process.stdout.write(`  axes ${floors || "(none)"}\n`);
    process.stdout.write(`  weights ${weights}${ap.axisWeights ? "" : " (role defaults)"}\n`);
  }
  process.stdout.write("\nedit: machine_code policy edit [--repo]\n");
  return 0;
}

function parseAxisOverrides(value: string): Partial<Record<import("./config.js").CapabilityAxis, number>> {
  const out: Partial<Record<import("./config.js").CapabilityAxis, number>> = {};
  for (const part of value.split(",").map((v) => v.trim()).filter(Boolean)) {
    const [axis, raw] = part.split("=");
    if (!axis || raw === undefined || !(CAPABILITY_AXES as readonly string[]).includes(axis)) {
      fail(`--min-axes entries must be axis=value (${CAPABILITY_AXES.join(", ")})`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10) fail(`--min-axes ${axis} must be a number in 0-10`);
    out[axis as import("./config.js").CapabilityAxis] = n;
  }
  return out;
}

/* ------------------------------------------------------------------ models */

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function printModelRow(row: CatalogueRow): void {
  const cap = row.scores.capability.toFixed(1).padStart(4);
  const est = row.provenance.estimated ? " est" : "    ";
  const flags = `${row.toolCall ? "T" : "-"}${row.reasoning ? "R" : "-"}${row.image ? "I" : "-"}`;
  const kind = row.kind && row.kind !== "chat" ? `  ${row.kind.toUpperCase()}` : "";
  process.stdout.write(
    `  ${cap}  ${row.key.padEnd(58)} ctx ${fmtCtx(row.context).padStart(5)}  ${flags}  ` +
      `in $${row.pricing.input.toFixed(3).padStart(7)}  out $${row.pricing.output.toFixed(3).padStart(7)}${est}` +
      `${row.free ? "  FREE" : ""}${kind}\n`,
  );
}

/**
 * Inspect the generated catalogue and, with --agent, dry-run the selector.
 * Read-only: never refreshes and never needs a provider key.
 */
function cmdModels(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const l = layout();
  const machine = loadMachineConfig(l);
  const policy = loadPolicy(l);
  const doc = loadCatalogue(l.catalogueFile);
  if (!doc) {
    fail(`no catalogue at ${l.catalogueFile} — run: machine_code catalogue refresh`);
  }

  const statuses = providerStatuses(createModelsCollection());
  const configured = new Set(statuses.filter((s) => s.configured).map((s) => s.id));
  // Disabled providers are removed from the runtime collection; keep their
  // stale catalogue rows out of every listing too.
  const activeProviders = new Set(statuses.map((s) => s.id));
  const known = new Set(doc.models.map((m) => m.providerID));
  for (const id of configured) {
    if (!known.has(id)) {
      process.stderr.write(`warning: ${id} is configured but absent from the catalogue; run: machine_code catalogue refresh\n`);
    }
  }
  const provider = flags.get("provider");
  const minCap = flags.has("min-cap") ? Number(flags.get("min-cap")) : undefined;
  if (minCap !== undefined && !Number.isFinite(minCap)) fail("--min-cap needs a number (0-10)");
  const query = (positional[0] ?? flags.get("filter") ?? "").toLowerCase();
  const all = flags.has("all");

  // A free-only query is a catalogue question, not a configured-provider
  // question: surface free offers from every provider.
  let rows = doc.models.filter(
    (m) => activeProviders.has(m.providerID) && (all || flags.has("free") || configured.has(m.providerID)),
  );
  if (provider) rows = rows.filter((m) => m.providerID === provider);
  const family = flags.get("family");
  const sortFlag = (flags.get("sort") ?? "capability") as ModelSort;
  const sorts: ModelSort[] = ["capability", "fit", "reasoning", "code", "agentic", "general", "context", "price-in", "price-out", "name"];
  if (!sorts.includes(sortFlag)) fail(`--sort must be one of ${sorts.join(", ")}`);
  const axisFloor = flags.get("axis") ? parseAxisOverrides(flags.get("axis")!) : {};
  rows = filterModels(rows, {
    text: query,
    minCapability: minCap !== undefined && Number.isFinite(minCap) ? minCap : undefined,
    families: family ? [family] : undefined,
    freeOnly: flags.has("free"),
    codingOnly: flags.has("coding"),
    toolCall: flags.has("tool"),
    minAxes: axisFloor,
    sort: sortFlag,
  });

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  const agent = flags.get("agent");
  const tierFlag = flags.get("tier");
  if (tierFlag !== undefined && tierFlag !== "free" && tierFlag !== "paid") {
    fail("--tier must be free|paid");
  }
  if (agent) {
    const ap = policy.agents[agent];
    if (!ap) fail(`unknown agent "${agent}"; choose one of ${Object.keys(policy.agents).join(", ")}`);
    const contextChars = flags.has("context-chars") ? Number(flags.get("context-chars")) : 16_000;
    if (!Number.isFinite(contextChars) || contextChars <= 0) fail("--context-chars needs a positive number");
    const fitOverride = flags.has("min-fit") ? Number(flags.get("min-fit")) : undefined;
    if (fitOverride !== undefined && (!Number.isFinite(fitOverride) || fitOverride < 0 || fitOverride > 10)) {
      fail("--min-fit needs a number in 0-10");
    }
    if (fitOverride !== undefined) ap.minFit = fitOverride;
    const override = flags.has("min-capability") ? Number(flags.get("min-capability")) : undefined;
    if (override !== undefined && (!Number.isFinite(override) || override < 0 || override > 10)) {
      fail("--min-capability needs a number in 0-10");
    }
    if (override !== undefined) ap.minCapability = override;
    const axesOverride = flags.get("min-axes");
    if (axesOverride) ap.minAxes = { ...(ap.minAxes ?? {}), ...parseAxisOverrides(axesOverride) };
    const result = pick({
      agent,
      policy: ap,
      machine,
      catalogue: doc.models,
      configuredProviders: configured,
      availability: loadAvailability(l.home),
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars,
      tier: tierFlag as import("./config.js").SelectionTier | undefined,
      requireProvider: provider,
      requireModel: flags.get("model"),
    });
    if ("error" in result) {
      process.stdout.write(`${result.error}\n`);
      const byReason = Object.entries(result.rejectedByReason).sort((a, b) => b[1] - a[1]);
      if (byReason.length > 0) {
        process.stdout.write(`  by reason: ${byReason.map(([reason, n]) => `${reason} ${n}`).join("  ")}\n`);
      }
      for (const r of result.rejected.slice(0, 10)) process.stdout.write(`  e.g. ${r.key}: ${r.reason}\n`);
      if (result.rejectedCount > result.rejected.length) {
        process.stdout.write(`  … ${result.rejectedCount - result.rejected.length} more\n`);
      }
      return 1;
    }
    const weights = axisWeights(agent, ap);
    const floors = CAPABILITY_AXES.filter((axis) => (ap.minAxes?.[axis] ?? 0) > 0)
      .map((axis) => `${axis}>=${ap.minAxes![axis]}`)
      .join(" ");
    const freeFloors = CAPABILITY_AXES.filter((axis) => (ap.freeMinAxes?.[axis] ?? 0) > 0)
      .map((axis) => `${axis}>=${ap.freeMinAxes![axis]}`)
      .join(" ");
    process.stdout.write(
      `agent ${agent}  tier ${result.tier}  min_context ${ap.minContext}  min_fit ${ap.minFit}  min_capability ${ap.minCapability}  tool_call ${ap.toolCall}\n`,
    );
    process.stdout.write(
      `axes ${floors || "(no axis floors)"}\n` +
        `free floors min_fit ${ap.freeMinFit ?? ap.minFit}  min_capability ${ap.freeMinCapability ?? ap.minCapability}  axes ${freeFloors || "(inherits paid)"}\n` +
        `weights ${CAPABILITY_AXES.map((axis) => `${axis} ${weights[axis].toFixed(2)}`).join("  ")}\n`,
    );
    if (machine.priceCaps.input !== undefined || machine.priceCaps.output !== undefined) {
      process.stdout.write(
        `  caps in $${machine.priceCaps.input ?? "-"}/out $${machine.priceCaps.output ?? "-"} per M`,
      );
    }
    process.stdout.write(`\ncontext ${contextChars} chars -> ~${result.estimate.inputTokens} in / ${result.estimate.outputTokens} out tokens\n`);
    process.stdout.write(`selected: ${result.selected.key}\n`);
    printModelRow(result.selected);
    process.stdout.write(
      `  axes      ${CAPABILITY_AXES.map((axis) => `${axis} ${result.selected.scores[axis].toFixed(2)}`).join("  ")}\n`,
    );
    const selected = result.selected;
    process.stdout.write(`  kind      ${selected.kind ?? "chat"}  coding ${selected.coding === false ? "no" : "yes"}\n`);
    process.stdout.write(`  modes     ${selected.modes.join(", ") || "-"}\n`);
    process.stdout.write(
      `  io        ${selected.capabilities.input.join("+")} → ${selected.capabilities.output.join("+")}   ` +
        `ctx ${fmtCtx(selected.capabilities.contextWindow)}   max out ${fmtCtx(selected.capabilities.maxOutputTokens)}\n`,
    );
    process.stdout.write("\ntop candidates (lower is better):\n");
    for (const c of result.candidates) {
      process.stdout.write(
        `  ${String(c.score).padEnd(9)} ${c.key.padEnd(58)} ` +
          `fit ${c.fit.toFixed(2).padEnd(5)} pen ${String(c.terms.capability).padEnd(6)} cost ${String(c.terms.cost).padEnd(6)} ` +
          `speed ${String(c.terms.speed).padEnd(6)} head ${String(c.terms.headroom).padEnd(6)} conf ${String(c.terms.confidence).padEnd(4)} ` +
          `~$${c.estimatedCost.toFixed(6)}\n`,
      );
    }
    process.stdout.write(
      `\nfiltered: ${result.rejectedCount} ineligible; showing top ${result.candidates.length}\n`,
    );
    const byReason = Object.entries(result.rejectedByReason).sort((a, b) => b[1] - a[1]);
    if (byReason.length > 0) {
      process.stdout.write(`  by reason: ${byReason.map(([reason, n]) => `${reason} ${n}`).join("  ")}\n`);
    }
    for (const r of result.rejected.slice(0, 3)) process.stdout.write(`  e.g. ${r.key}: ${r.reason}\n`);
    return 0;
  }

  const funded = [...fundedProviderIds(machine.providers)].sort();
  process.stdout.write(
    `${rows.length} model(s)  tier ${machine.selection.tier}  funded: ${funded.join(", ") || "(none)"}  ` +
      `${all ? "all providers" : `configured: ${[...configured].join(", ") || "(none)"}`}` +
      `${provider ? `  provider ${provider}` : ""}${family ? `  family ${family}` : ""}${minCap !== undefined ? `  cap >= ${minCap}` : ""}` +
      `${flags.has("free") ? "  free" : ""}${flags.has("coding") ? "  coding" : ""}${flags.has("tool") ? "  tools" : ""}` +
      `${query ? `  filter "${query}"` : ""}  sort ${sortFlag}\n`,
  );
  process.stdout.write("   cap  key                                                        context  T/R/I       in $/M       out $/M\n");
  const limit = flags.has("limit") ? Number(flags.get("limit")) : 25;
  if (!Number.isInteger(limit) || limit < 0) fail("--limit needs a non-negative integer");
  for (const row of rows.slice(0, limit)) {
    printModelRow(row);
    if (flags.has("axes")) {
      process.stdout.write(
        `        axes reasoning ${row.scores.reasoning.toFixed(2)}  code ${row.scores.code.toFixed(2)}  ` +
          `agentic ${row.scores.agentic.toFixed(2)}  general ${row.scores.general.toFixed(2)}\n`,
      );
    }
  }
  if (rows.length > limit) process.stdout.write(`  … ${rows.length - limit} more (--limit N, --all, --json)\n`);
  return 0;
}

/* --------------------------------------------------------------- catalogue */

function writeModelSnapshot(document: CatalogueDocument, rootArg?: string): { modelsDir: string; offersDir: string; files: number } {
  const root = rootArg ? resolve(rootArg) : packageDataDir();
  const modelsDir = join(root, "models");
  const offersDir = join(root, "offers");
  rmSync(modelsDir, { recursive: true, force: true });
  rmSync(offersDir, { recursive: true, force: true });
  const files = snapshotFiles(document);
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  return { modelsDir, offersDir, files: files.length };
}

function cmdCatalogueSnapshot(pathArg?: string): number {
  const l = layout();
  const document = loadCatalogue(l.catalogueFile);
  if (!document) fail(`no catalogue at ${l.catalogueFile} — run: machine_code catalogue refresh`);
  const written = writeModelSnapshot(document, pathArg);
  process.stdout.write(`model snapshot written to ${written.modelsDir}\n`);
  process.stdout.write(`provider offers written to ${written.offersDir}\n`);
  process.stdout.write(`  ${document.models.length} offers in ${written.files} files\n`);
  return 0;
}

async function cmdCatalogueRefresh(snapshot = false): Promise<number> {
  const l = layout();
  const models = createModelsCollection();
  const { models: available, warnings } = await availableChatModels(models);
  if (available.length === 0) {
    fail("no configured providers — set a provider key (e.g. OPENROUTER_API_KEY, OPENCODE_API_KEY)");
  }
  const result = await refreshCatalogue(l, [...available], {
    openRouterKey: process.env.OPENROUTER_API_KEY,
  });
  for (const warning of [...warnings, ...result.warnings]) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  process.stdout.write(`catalogue written to ${result.file}\n`);
  process.stdout.write(`generated ${result.document.generatedAt}\n`);
  if (snapshot) {
    const written = writeModelSnapshot(result.document);
    process.stdout.write(`model snapshot written to ${written.modelsDir} + ${written.offersDir}\n`);
  }
  if (result.curatedVetoes > 0) {
    process.stdout.write(`  ${result.curatedVetoes} row(s) removed by curation vetoes\n`);
  }
  for (const source of result.document.sources) {
    process.stdout.write(`  ${source.id}: ${source.models} models\n`);
  }
  const top = [...result.document.models]
    .sort((a, b) => b.scores.capability - a.scores.capability)
    .slice(0, 8);
  process.stdout.write("\ntop by capability:\n");
  for (const row of top) {
    const est = row.provenance.estimated ? " (estimated)" : "";
    process.stdout.write(
      `  ${row.key}  cap ${row.scores.capability}  ctx ${Math.round(row.context / 1000)}k  $${row.pricing.input}/$${row.pricing.output} per M${est}\n`,
    );
  }
  return 0;
}

/* ---------------------------------------------------------------------- run */

async function cmdRun(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const modeFlag = flags.get("mode");
  const agentName = flags.get("agent");
  if (agentName !== undefined && !(AGENT_NAMES as readonly string[]).includes(agentName)) {
    fail(`unknown agent "${agentName}"; choose one of ${AGENT_NAMES.join(", ")}`);
  }
  const requireProvider = flags.get("provider");
  const requireModel = flags.get("model");
  const issueFlag = flags.get("issue");
  const issueTypeFlag = flags.get("issue-type") ?? "task";
  const featureFlag = flags.get("feature");
  const baseFlag = flags.get("base");
  const request = positional.join(" ").trim();

  if (request.length === 0) fail(`run needs a question, e.g. machine_code run --agent architect --mode verified "fix the parser panic"`);
  if (issueTypeFlag !== "task" && issueTypeFlag !== "feature") fail(`--issue-type must be task or feature`);

  let issueNumber: number | undefined;
  if (issueFlag !== undefined) {
    const n = Number(issueFlag);
    if (!Number.isInteger(n) || n <= 0) fail(`--issue must be a positive issue number`);
    issueNumber = n;
  }
  let featureNumber: number | undefined;
  if (featureFlag !== undefined) {
    const n = Number(featureFlag);
    if (!Number.isInteger(n) || n <= 0) fail(`--feature must be a positive issue number`);
    featureNumber = n;
  }

  // Run-level agent configuration overrides (Phase 3).
  const agentOverrides: Partial<AgentConfig> = {};
  const presetFlag = flags.get("preset");
  if (presetFlag !== undefined) {
    const valid = ["plan", "orchestrate", "implement", "review", "assistant", "unrestricted"] as readonly string[];
    if (!valid.includes(presetFlag)) fail(`--preset must be one of ${valid.join(", ")}`);
    agentOverrides.preset = presetFlag as AgentConfig["preset"];
  }
  const boolFlag = (name: string): boolean | undefined => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
    fail(`--${name} must be true|false`);
  };
  const delegateFlag = boolFlag("delegate");
  if (delegateFlag !== undefined) agentOverrides.delegate = delegateFlag;
  const verifyFlag = flags.get("verify");
  if (verifyFlag !== undefined) {
    if (verifyFlag !== "direct" && verifyFlag !== "verified" && verifyFlag !== "redundant") {
      fail("--verify must be direct|verified|redundant");
    }
    agentOverrides.verification = verifyFlag;
  }
  const issuesFlag = flags.get("issues");
  if (issuesFlag !== undefined) {
    if (issuesFlag !== "required" && issuesFlag !== "optional" && issuesFlag !== "disabled") {
      fail("--issues must be required|optional|disabled");
    }
    agentOverrides.issues = issuesFlag;
  }
  const askFlag = boolFlag("ask");
  if (askFlag !== undefined) agentOverrides.ask = askFlag;
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
  if (flags.has("allow-issue-create")) agentOverrides.issueAccess = "create";
  if (flags.has("allow-artifact-scripts")) agentOverrides.artifactScripts = true;
  // A detached delegated child runs a single agent directly (task tool spawn).
  const directExec = flags.has("direct-exec");

  const l = layout();
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
  if (minAxes !== undefined) {
    const axes = parseAxisOverrides(minAxes);
    for (const ap of Object.values(policy.agents)) ap.minAxes = { ...(ap.minAxes ?? {}), ...axes };
  }
  const contextExcludeFlag = flags.get("context-exclude");
  let contextExclude: import("./context/assemble.js").ContextExclusion | undefined;
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
  const excludedSections = new Set(contextExclude?.sections ?? []);
  const excludedItems = new Set(contextExclude?.items ?? []);
  const skipMap = excludedSections.has("codebase") || excludedItems.has("map:index");
  const skipSemantic = excludedSections.has("codebase") || excludedItems.has("semantic:index");
  if (requireProvider && !configuredProviders.has(requireProvider)) {
    fail(`provider "${requireProvider}" is not configured`);
  }

  // The agent's data file owns the mode vocabulary. No global mode list is
  // hardcoded here: a role with no modes simply runs alone (there is no
  // special "solo" value), and a role with modes may declare a default.
  const agentNameParsed = (agentName as AgentName | undefined) ?? (modeFlag ? "architect" : "general");
  const selectedDef = agentDef(l, agentNameParsed);
  if (modeFlag !== undefined) {
    if (!selectedDef.modes.includes(modeFlag)) {
      const hint = selectedDef.modes.length === 0
        ? `agent ${agentNameParsed} runs alone; omit --mode`
        : `choose one of ${selectedDef.modes.join(", ")}`;
      fail(`agent ${agentNameParsed} does not offer mode "${modeFlag}" (${hint})`);
    }
  }
  const mode: string | undefined =
    modeFlag ??
    (selectedDef.modes.length > 0 ? selectedDef.defaultMode ?? selectedDef.modes[0] : undefined);

  const runIssueAccess =
    resolveAgentConfig({
      role: agentNameParsed,
      agentPolicy: policy.agents[agentNameParsed],
      machineOverrides: machine.agents[agentNameParsed],
      runOverrides: agentOverrides,
    }).issueAccess ?? agentDef(l, agentNameParsed).issueAccess;
  if (flags.has("auto-issue") && runIssueAccess !== "create") {
    fail(
      `--auto-issue requires issue_access=create; ${agentNameParsed} has issue_access=${runIssueAccess}. ` +
        "Select an existing Task or use an agent with issue creation access.",
    );
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
  const preflight = pick({
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
  });
  if ("error" in preflight) {
    fail(`no model is ready before run start: ${preflight.error}${preflight.rejected[0] ? ` (${preflight.rejected[0].key}: ${preflight.rejected[0].reason})` : ""}`);
  }

  // Fork lineage: resolve the parent before the recorder exists so the child
  // is born with its lineage (never patched in after the fact).
  const parentFlag = flags.get("parent");
  const inheritWorktree = flags.has("inherit-worktree");
  let parentRun: import("./state/runs.js").RunSummary | undefined;
  /** Parent, grandparent, … nearest first, so a fork of a fork keeps the whole chain. */
  const parentChain: Array<{ id: string; request: string; finalText?: string }> = [];
  if (parentFlag !== undefined) {
    const allRuns = listAllRuns(l.home);
    parentRun = allRuns.find((r) => r.id === parentFlag);
    if (!parentRun) fail(`no such parent run: ${parentFlag}`);
    const byId = new Map(allRuns.map((run) => [run.id, run]));
    const seen = new Set<string>();
    let cursor: import("./state/runs.js").RunSummary | undefined = parentRun;
    while (cursor && parentChain.length < 4 && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parentChain.push({
        id: cursor.id,
        request: cursor.request,
        ...(cursor.finalText ? { finalText: cursor.finalText } : {}),
      });
      cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) : undefined;
    }
  }

  const recorder = new RunRecorder(l, {
    agent: agentNameParsed,
    mode: mode ?? "",
    request,
    repoRoot: l.repoRoot,
    ...(parentRun
      ? {
          parentRunId: parentRun.id,
          rootRunId: parentRun.rootRunId ?? parentRun.id,
          forkReason: "manual" as const,
        }
      : {}),
  });
  registerProject(l.home, l.repoRoot);
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

  // Issue association: runs attach to Tasks only. Epic/Feature input resolves
  // to the reserved Task 0 for planning/review; implementation runs require a
  // deliverable Task.
  let issueRef: IssueRef | undefined;
  const issueBundle = await createIssueProvider(l, machine);
  if (issueFlag !== undefined) {
    const bundle = issueBundle;
    if (bundle.provider.kind === "none") {
      if (machine.issues.policy === "required") {
        fail(`issue tracking is required but unavailable: ${bundle.reason ?? "unknown reason"}`);
      }
      process.stderr.write(`warning: issue tracking unavailable (${bundle.reason ?? "unknown"}); --issue ignored for association\n`);
    } else {
      const rawRef = parseIssueRef(issueFlag, bundle.repo, "github");
      const role = agentNameParsed;
      let resolved;
      try {
        resolved = await resolveRunTarget({
          provider: bundle.provider,
          ref: rawRef,
          request,
          agent: role,
          autoCreate: flags.has("auto-issue"),
          reserved: { runCounts: new Map(), autoCloseEmpty: true },
        });
      } catch (error) {
        if (error instanceof Error && "code" in error) fail((error as { message: string }).message);
        throw error;
      }
      const resolvedIssue = resolved.issue;
      issueRef = resolvedIssue.ref;
      issueNumber = resolvedIssue.ref.number;
      if (featureNumber === undefined && resolvedIssue.parent?.number) featureNumber = resolvedIssue.parent.number;
      recorder.patchSummary({ issue: issueRef });
      recorder.event("issue_linked", { issue: resolvedIssue.ref.number, kind: resolvedIssue.kind, source: "cli" });
      for (const created of resolved.created) {
        recorder.event("issue_created", {
          issue: created.ref.number,
          kind: created.kind,
          parent: created.parent?.number,
          auto: true,
        });
      }
    }
  }

  // Build and orchestrated runs work in an isolated worktree on an issue
  // branch. Sudo edits the main tree by default; --worktree opts it in.
  // General and review never create one: General is read-only, and Review
  // reads the worktree it inspects.
  const forceWorktree = flags.has("worktree");
  const mutating =
    agentNameParsed === "general" || agentNameParsed === "review"
      ? false
      : forceWorktree || agentNameParsed === "build" || (!directExec && mode !== undefined);
  let toolRoot = l.repoRoot;
  if (mutating) {
    try {
      const spec = await createWorktree({
        layout: l,
        runId: recorder.id,
        kind: issueRef ? "task" : "run",
        issueNumber: issueRef?.number,
        featureNumber,
        base: baseFlag ?? (inheritWorktree && parentRun?.branch ? parentRun.branch : undefined),
      });
      recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
      if (inheritWorktree && parentRun?.worktree) {
        // Inherit the parent's uncommitted work explicitly; conflicts fail.
        try {
          const { inheritWorktreePatch } = await import("./worktree.js");
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
      if (error instanceof WorktreeError) {
        recorder.finalize("blocked", `${error.code}: ${error.message}`);
        process.stderr.write(`machine_code: ${error.code}: ${error.message}\n`);
        return EXIT.blocked;
      }
      throw error;
    }
  }

  // Context assembly (Phase 6): hierarchy + explicit artifacts + project
  // sources, written to context.json for provenance.
  const { assembleContext } = await import("./context/assemble.js");
  const { writeJsonAtomic } = await import("./state/run-schema.js");
  const contextBundle = await assembleContext({
    layout: l,
    machine,
    provider: issueBundle.provider.kind === "none" ? undefined : issueBundle.provider,
    issue: issueRef,
    parentRuns: parentChain.length > 0 ? parentChain : undefined,
    exclude: contextExclude,
  });
  if (contextBundle.text) {
    writeJsonAtomic(join(recorder.dir, "context.json"), { chars: contextBundle.chars, sources: contextBundle.sources });
    recorder.event("context_assembled", { chars: contextBundle.chars, sources: contextBundle.sources });
  }
  const contextText = contextBundle.text || undefined;

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

  let result: RunLoopResult | OrchestrateResult;
  if (directExec) {
    // Detached delegated child: one agent, directly. Its prompt is its spec.
    const role = (agentNameParsed ?? "build") as AgentName;
    if (role !== "build" && role !== "review" && role !== "sudo") {
      recorder.finalize("failed", "--direct-exec requires --agent build|review|sudo");
      process.stderr.write("machine_code: --direct-exec requires --agent build|review|sudo\n");
      return EXIT.failed;
    }
    const resolved = resolveAgent(l, role, {
      agentPolicy: policy.agents[role],
      machineOverrides: machine.agents[role],
      runOverrides: agentOverrides,
    });
    recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
    if (role === "review") {
      // A delegated review may target a specific build worktree.
      const reviewOf = flags.get("review-of");
      if (reviewOf) {
        const target = readRun(l, reviewOf);
        if (target?.summary.worktree) {
          toolRoot = target.summary.worktree;
          recorder.patchSummary({
            worktree: target.summary.worktree,
            worktreeOwnerRunId: reviewOf,
            branch: target.summary.branch,
            baseBranch: target.summary.baseBranch,
          });
          recorder.event("review_of", { runId: reviewOf, worktree: target.summary.worktree });
        }
      }
    }
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
      skipMap,
      skipSemantic,
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
      mode,
      agentName: agentNameParsed,
      request,
      root: l.repoRoot,
      toolRoot,
      issueNumber,
      agentOverrides,
      home: l.home,
      recorder,
      requireProvider,
      requireModel,
      contextText,
      skipMap,
      skipSemantic,
      signal: abort.signal,
    });
  }

  // Publish is runner-owned: the direct-exec path publishes too.
  if (directExec && result.status === "completed" && toolRoot !== l.repoRoot) {
    const { maybePublish } = await import("./pr/publish.js");
    await maybePublish({
      layout: l,
      machine,
      recorder,
      defaultApproval: agentOverrides.approval ?? "human",
      title: `Task: ${request.split("\n")[0]!.slice(0, 120)}`,
    });
  }

  recorder.finalize(result.status, result.error, result.finalText);
  if (result.finalText.trim().length > 0) {
    process.stdout.write(`${result.finalText}\n`);
  }
  // One-way notification on terminal state (M4).
  if (machine.notify.webhookUrl || machine.notify.command) {
    const { notify } = await import("./notify.js");
    await notify(machine.notify, {
      event: "run_terminal",
      status: result.status,
      runId: recorder.id,
      repoRoot: l.repoRoot,
      agent: agentNameParsed ?? "general",
      request,
      tokens: recorder.current.usage.totalTokens,
      cost: recorder.current.cost.actual,
      error: result.error,
    }).catch(() => undefined);
  }
  const summary = recorder.current;
  process.stderr.write(
    `\nrun ${summary.id}: ${summary.status} — ${summary.modelCalls} call(s), ${summary.usage.totalTokens} tokens, $${summary.cost.actual.toFixed(6)} actual\n`,
  );
  return EXIT[result.status];
}

/* ----------------------------------------------------------------- provider/model health */

async function cmdProvider(argv: string[]): Promise<number> {
  const sub = argv[0];
  const name = argv[1];
  if (!sub || !name) fail("usage: machine_code provider disable|enable|cooldown <name> [minutes]|cooldown clear <name>");
  const l = layout();
  const avail = await import("./availability.js");
  const state = avail.loadAvailability(l.home);
  if (sub === "disable") {
    avail.disableProvider(state, name);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${name} disabled (manual re-enable required)\n`);
  } else if (sub === "enable") {
    avail.enableProvider(state, name);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${name} enabled; cooldowns cleared\n`);
  } else if (sub === "cooldown" && argv[2] === "clear") {
    avail.clearProviderCooldown(state, name);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${name} cooldown cleared\n`);
  } else if (sub === "cooldown") {
    const minutes = argv[2] === undefined ? 60 : Number(argv[2]);
    if (!Number.isFinite(minutes) || minutes <= 0) fail("provider cooldown needs a positive number of minutes");
    const until = avail.coolProvider(state, name, minutes * 60_000);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${name} cooled for ${minutes}m (until ${new Date(until).toISOString()})\n`);
  } else {
    fail("usage: machine_code provider disable|enable|cooldown clear <name>");
  }
  return 0;
}

async function cmdAvailability(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const l = layout();
  const machine = loadMachineConfig(l);
  const state = loadAvailability(l.home);
  const catalogue = loadCatalogue(l.catalogueFile);
  if (!catalogue) fail("no catalogue; run machine_code catalogue refresh");
  const configured = new Set(providerStatuses(createModelsCollection()).filter((p) => p.configured).map((p) => p.id));
  const now = Date.now();
  if (flags.has("probe")) {
    const targets = probeCoolingCandidates(catalogue.models, state, configured, flags.has("free-only"));
    if (targets.length === 0) {
      process.stdout.write("no cooling models to probe\n");
      return 0;
    }
    const results = [];
    for (const target of targets) {
      const result = await probeTarget(target, machine.availability, state);
      applyProbeResult(state, result);
      results.push(result);
    }
    saveAvailability(l.home, state);
    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      return 0;
    }
    for (const result of results) {
      process.stdout.write(
        `${result.key}  ${result.status}  ${result.source}  ${result.latencyMs}ms` +
          `${result.retryAfterMs ? `  retry ${Math.ceil(result.retryAfterMs / 1000)}s` : ""}` +
          `${result.message ? `  ${result.message}` : ""}\n`,
      );
    }
    return 0;
  }

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ config: machine.availability, state }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `probe ${machine.availability.probe}  interval ${Math.round(machine.availability.intervalMs / 1000)}s  timeout ${Math.round(machine.availability.timeoutMs / 1000)}s  free budget ${machine.availability.freeCompletionMaxPerHour}/h\n`,
  );
  const cooling = Object.entries(state.models)
    .filter(([, health]) => typeof health.cooldownUntil === "number" && health.cooldownUntil > now)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (cooling.length === 0) {
    process.stdout.write("no cooling models\n");
  } else {
    process.stdout.write("cooling models:\n");
    for (const [key, health] of cooling) {
      process.stdout.write(
        `  ${key}  until ${new Date(health.cooldownUntil!).toISOString()}  tier ${health.tier ?? 0}` +
          `${health.lastProbeResult ? `  last ${health.lastProbeResult}` : ""}\n`,
      );
    }
  }
  const providers = Object.entries(state.providers).filter(([, health]) => health.disabled || health.needsAuth || (health.cooldownUntil ?? 0) > now);
  if (providers.length > 0) {
    process.stdout.write("provider health:\n");
    for (const [id, health] of providers.sort(([a], [b]) => (a < b ? -1 : 1))) {
      const bits = [
        health.disabled ? "disabled" : "",
        health.needsAuth ? "needs-auth" : "",
        (health.cooldownUntil ?? 0) > now ? `cooling until ${new Date(health.cooldownUntil!).toISOString()}` : "",
      ].filter(Boolean);
      process.stdout.write(`  ${id}  ${bits.join(" · ")}\n`);
    }
  }
  return 0;
}

function probeCoolingCandidates(
  rows: readonly CatalogueRow[],
  state: ReturnType<typeof loadAvailability>,
  configured: ReadonlySet<string>,
  freeOnly: boolean,
) {
  return rows
    .filter((row) => configured.has(row.providerID) && (state.models[row.key]?.cooldownUntil ?? 0) > Date.now())
    .filter((row) => !freeOnly || row.free || (row.pricing.input === 0 && row.pricing.output === 0))
    .map(targetFor);
}

async function cmdModel(argv: string[]): Promise<number> {
  if (argv[0] === "show") {
    const query = argv[1];
    if (!query) fail("usage: machine_code model show <key|name>");
    const l = layout();
    const doc = loadCatalogue(l.catalogueFile);
    if (!doc) fail("no catalogue; run machine_code catalogue refresh");
    const rows = filterModels(doc.models, { text: query, sort: "capability" });
    const row = rows[0];
    if (!row) fail(`no model matches "${query}"`);
    printModelRow(row);
    process.stdout.write(`  provider ${row.providerID}  family ${row.family}  kind ${row.kind}  coding ${row.coding ? "yes" : "no"}\n`);
    process.stdout.write(`  axes ${CAPABILITY_AXES.map((axis) => `${axis} ${row.scores[axis].toFixed(2)}`).join("  ")}\n`);
    process.stdout.write(`  modes ${row.modes.join(", ") || "-"}  tools ${row.toolCall ? "yes" : "no"}  free ${row.free ? "yes" : "no"}\n`);
    process.stdout.write(`  offers\n`);
    for (const offer of siblingOffers(doc.models, row).sort((a, b) => a.pricing.input - b.pricing.input)) {
      process.stdout.write(`    ${offer.providerID.padEnd(18)} in $${offer.pricing.input}/M out $${offer.pricing.output}/M  ctx ${fmtCtx(offer.context)}${offer.free ? "  free" : ""}\n`);
    }
    return 0;
  }
  if (argv[0] === "probe") {
    const query = argv[1];
    if (!query) fail("usage: machine_code model probe <key|name>");
    const l = layout();
    const doc = loadCatalogue(l.catalogueFile);
    if (!doc) fail("no catalogue; run machine_code catalogue refresh");
    const row = filterModels(doc.models, { text: query, sort: "capability" })[0];
    if (!row) fail(`no model matches "${query}"`);
    const machine = loadMachineConfig(l);
    const state = loadAvailability(l.home);
    const result = await probeTarget(targetFor(row), machine.availability, state);
    applyProbeResult(state, result);
    saveAvailability(l.home, state);
    process.stdout.write(
      `${result.key}  ${result.status}  ${result.source}  ${result.latencyMs}ms` +
        `${result.retryAfterMs ? `  retry ${Math.ceil(result.retryAfterMs / 1000)}s` : ""}` +
        `${result.message ? `  ${result.message}` : ""}\n`,
    );
    return 0;
  }
  if (argv[0] !== "cooldown" || argv[1] !== "clear" || !argv[2]) {
    fail("usage: machine_code model show <key|name> | model probe <key|name> | model cooldown clear <id>");
  }
  const id = argv[2];
  const l = layout();
  const avail = await import("./availability.js");
  const state = avail.loadAvailability(l.home);
  avail.clearModelCooldown(state, id);
  avail.saveAvailability(l.home, state);
  process.stdout.write(`model ${id} cooldown cleared\n`);
  return 0;
}

/* -------------------------------------------------------------------- queue */

async function cmdQueue(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const l = layout();
  const { machine, policy, models, catalogue: catalogueDoc, configuredProviders } = await loadRuntime(l);
  const requireModel = flags.get("model");

  const { listQueuedPackets, runQueue } = await import("./queue.js");
  const packets = listQueuedPackets(l);
  if (packets.length === 0) {
    process.stdout.write("no queued packets in .machine_code/tasks/\n");
    return 0;
  }
  process.stdout.write(`queue: ${packets.length} packet(s)\n`);
  const progress = await runQueue(l, async (packet) => {
    const packetAgent = packet.agent ?? (packet.mode ? "architect" : "general");
    const recorder = new RunRecorder(l, { agent: packetAgent, mode: packet.mode ?? "", request: packet.goal, repoRoot: l.repoRoot, packetId: packet.id });
    registerProject(l.home, l.repoRoot);
    const abort = new AbortController();
    // Queued packets always carry their packet id, so the worktree gets the
    // snapshot materialized for Build to read. Sudo packets run on the main
    // tree unless they carry an orchestration mode; General/Review never
    // create one.
    const mutating =
      packet.agent === "general" || packet.agent === "review"
        ? false
        : packet.mode !== undefined || packet.agent === "build";
    let toolRoot = l.repoRoot;
    if (mutating) {
      try {
        const spec = await createWorktree({ layout: l, runId: recorder.id, kind: "run", packetId: packet.id });
        recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
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
      } catch (error) {
        if (error instanceof WorktreeError) {
          recorder.finalize("blocked", `${error.code}: ${error.message}`);
          return { status: "blocked" as const, runId: recorder.id };
        }
        throw error;
      }
    }
    // Queue context: the packet itself is the primary context source.
    const { assembleContext } = await import("./context/assemble.js");
    const { writeJsonAtomic } = await import("./state/run-schema.js");
    const queueContext = await assembleContext({ layout: l, machine, packetId: packet.id });
    if (queueContext.text) {
      writeJsonAtomic(join(recorder.dir, "context.json"), { chars: queueContext.chars, sources: queueContext.sources });
      recorder.event("context_assembled", { chars: queueContext.chars, sources: queueContext.sources });
    }
    const result = await orchestrate({
      models,
      catalogue: catalogueDoc.models,
      configuredProviders,
      availability: loadAvailability(l.home),
      layout: l,
      machine,
      policy,
      mode: packet.mode as import("./orchestrate.js").RunMode,
      agentName: packet.agent ?? (packet.mode ? undefined : "general"),
      request: packet.goal,
      root: l.repoRoot,
      toolRoot,
      home: l.home,
      recorder,
      packet,
      requireModel,
      contextText: queueContext.text || undefined,
      signal: abort.signal,
    });
    recorder.finalize(result.status, result.error, result.finalText);
    return { status: result.status, runId: recorder.id };
  }, (p) => {
    process.stdout.write(`  ${p.status.padEnd(12)} ${p.packet.id}\n`);
  });
  const done = progress.filter((p) => p.status === "completed").length;
  const skipped = progress.filter((p) => p.status === "skipped").length;
  process.stdout.write(`\nqueue finished: ${done} completed, ${skipped} skipped, ${progress.length - done - skipped} not done\n`);
  return progress.some((p) => p.status !== "completed" && p.status !== "skipped") ? 1 : 0;
}

/* -------------------------------------------------------------------- log */

function indentEventLines(text: string, prefix = "      "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function fmtEvent(event: Record<string, unknown>): string {
  const t = String(event.t ?? "").slice(11, 19);
  const type = String(event.type);
  const rest = Object.fromEntries(Object.entries(event).filter(([k]) => k !== "t" && k !== "type"));
  const head = (label: string, detail: string): string => `  ${t}  ${label.padEnd(18)} ${detail}`;
  // Streaming deltas are coalesced into model_call_end; printing each chunk
  // split the response into unreadable fragments.
  if (type === "model_delta") return "";
  if (type === "model_select") {
    const detail = rest.error
      ? `error: ${rest.error}`
      : `-> ${rest.key}  est ${(rest.estimate as { inputTokens: number }).inputTokens}+${(rest.estimate as { outputTokens: number }).outputTokens} tok`;
    return head(type, detail);
  }
  if (type === "model_request") {
    const header = head(type, `${rest.provider}/${rest.model}  ${rest.messages} msg  ${rest.chars} chars`);
    const input = typeof rest.input === "string" ? rest.input : "";
    return input ? `${header}\n${indentEventLines(input)}` : header;
  }
  if (type === "model_call_end") {
    const u = rest.usage as { totalTokens: number };
    const header = head(type, `${rest.provider}/${rest.model}  ${rest.stopReason}  ${u.totalTokens} tok  $${typeof rest.cost === "number" ? rest.cost.toFixed(6) : "?"}`);
    const text = typeof rest.text === "string" ? rest.text.trim() : "";
    return text ? `${header}\n${indentEventLines(text)}` : header;
  }
  if (type === "tool_call_start") {
    const args = rest.args === undefined ? "" : `  ${JSON.stringify(rest.args)}`;
    return head(type, `${rest.tool}${args}`);
  }
  if (type === "tool_call") {
    const header = head(type, `${rest.tool}  ${rest.isError ? "ERROR" : "ok"}${typeof rest.durationMs === "number" ? `  ${rest.durationMs}ms` : ""}`);
    const result = rest.result;
    if (result === undefined) return header;
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return `${header}\n${indentEventLines(text.slice(0, 8_000))}`;
  }
  if (type === "run_end") return head(type, String(rest.status));
  const detail = Object.keys(rest).length > 0 ? `  ${JSON.stringify(rest)}` : "";
  return head(type, detail.trim());
}

function cmdLog(id: string | undefined): number {
  if (!id) fail("log needs a run id");
  const run = readRun(layout(), id);
  if (!run) fail(`no such run: ${id}`);
  const s = run.summary;
  process.stdout.write(
    `run ${s.id}  ${s.status}\n  agent ${s.agent}  mode ${s.mode || "-"}\n  started ${s.startedAt}${s.endedAt ? `  ended ${s.endedAt}` : ""}\n  request: ${s.request}\n` +
      `  calls ${s.modelCalls}  turns ${s.turns}  tokens ${s.usage.totalTokens}  cost $${s.cost.actual.toFixed(6)} actual / $${s.cost.estimated.toFixed(6)} estimated\n`,
  );
  if (s.error) process.stdout.write(`  error: ${s.error}\n`);
  process.stdout.write("events:\n");
  for (const event of run.events) {
    const line = fmtEvent(event);
    if (line) process.stdout.write(line + "\n");
  }
  return 0;
}

function cmdStatus(): number {
  return cmdRuns(["--group", "overall"]);
}

/** Find a run by id in this repo first, then across registered projects. */
function findRunAnywhere(home: string, id: string): { layout: ReturnType<typeof layout>; run: NonNullable<ReturnType<typeof readRun>> } | null {
  const l = layout();
  const local = readRun(l, id);
  if (local) return { layout: l, run: local };
  for (const project of listProjects(home)) {
    const rl = layout(project);
    const r = readRun(rl, id);
    if (r) return { layout: rl, run: r };
  }
  // Convenience: accept a unique id suffix (the TUI shows the last 8 chars).
  if (id.length >= 4) {
    const matches = listAllRuns(home).filter((run) => run.id.endsWith(id) || run.id.includes(id));
    if (matches.length === 1) {
      const match = matches[0]!;
      const rl = layout(match.repoRoot);
      const r = readRun(rl, match.id);
      if (r) return { layout: rl, run: r };
    }
    if (matches.length > 1) {
      process.stderr.write(`machine_code: run id "${id}" is ambiguous: ${matches.slice(0, 4).map((run) => run.id).join(", ")}\n`);
    }
  }
  return null;
}

/* ------------------------------------------------------------------- issues */

async function cmdIssue(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  const l = layout();
  const machine = loadMachineConfig(l);
  const bundle = await createIssueProvider(l, machine);
  if (bundle.provider.kind === "none") {
    fail(`issue tracking unavailable: ${bundle.reason ?? "unknown reason"}`);
  }
  const provider = bundle.provider;
  const refArg = positional[0];
  const ref = (label: string) => {
    if (!refArg) fail(`usage: machine_code issue ${sub} <${label}>`);
    return parseIssueRef(refArg, bundle.repo, "github");
  };

  switch (sub) {
    case "list": {
      const state = (flags.get("state") ?? "all") as "open" | "closed" | "all";
      const issues = await provider.list({ state, limit: Number(flags.get("limit") ?? 100) });
      for (const issue of issues) {
        process.stdout.write(
          `#${issue.ref.number}  ${issue.kind.padEnd(7)} ${issue.state.padEnd(6)} ${issue.title}${issue.reserved ? "  [reserved]" : ""}${issue.parent ? `  parent=#${issue.parent.number}` : ""}\n`,
        );
      }
      if (issues.length === 0) process.stdout.write("no issues\n");
      return 0;
    }
    case "view": {
      const issue = await provider.get(ref("issue"));
      if (!issue) fail(`issue not found: ${refArg}`);
      process.stdout.write(
        `#${issue.ref.number}  ${issue.kind}  ${issue.state}  ${issue.title}\n` +
          `approval: ${issue.approval ?? "human (default)"}  parent: ${issue.parent ? `#${issue.parent.number}` : "-"}\n` +
          `labels: ${issue.labels.join(", ") || "-"}\n\n${issue.body}\n`,
      );
      return 0;
    }
    case "tree": {
      const root = await provider.get(ref("issue"));
      if (!root) fail(`issue not found: ${refArg}`);
      const depth = Math.max(0, Number(flags.get("depth") ?? 2));
      const walk = async (issue: typeof root, level: number): Promise<void> => {
        process.stdout.write(
          `${"  ".repeat(level)}#${issue.ref.number} ${issue.kind} ${issue.state} ${issue.title}${issue.reserved ? " [reserved]" : ""}\n`,
        );
        if (level >= depth) return;
        for (const child of await provider.children(issue.ref)) await walk(child, level + 1);
      };
      await walk(root, 0);
      return 0;
    }
    case "create": {
      const kind = flags.get("kind") as "epic" | "feature" | "task" | undefined;
      const title = flags.get("title");
      if (!kind || !title) fail("usage: machine_code issue create --kind epic|feature|task --title <t> [--parent <ref>] [--body <b>]");
      const parent = flags.get("parent") ? parseIssueRef(flags.get("parent")!, bundle.repo, "github") : undefined;
      if (kind === "task" && !parent) fail("creating a Task requires --parent <feature>");
      if (kind === "feature" && !parent) fail("creating a Feature requires --parent <epic>");
      if (parent) {
        const parentIssue = await provider.get(parent);
        if (!parentIssue) fail(`parent not found: ${flags.get("parent")}`);
        if (kind === "task" && parentIssue.kind !== "feature") fail("a Task's parent must be a Feature");
        if (kind === "feature" && parentIssue.kind !== "epic") fail("a Feature's parent must be an Epic");
        if (kind === "task") await ensureFeatureReserved(provider, parentIssue.ref);
        if (kind === "feature") await ensureEpicReserved(provider, parentIssue.ref);
      }
      const body = flags.get("body") ?? "";
      const created = await provider.create({ title, body, kind, parent });
      if (created.kind === "epic") {
        const reserved = await ensureEpicReserved(provider, created.ref);
        process.stdout.write(`created epic #${created.ref.number}; reserved Feature 0 #${reserved.feature0.ref.number}, Task 0 #${reserved.task0.ref.number}\n`);
      } else if (created.kind === "feature") {
        const task0 = await ensureFeatureReserved(provider, created.ref);
        process.stdout.write(`created feature #${created.ref.number}; reserved Task 0 #${task0.ref.number}\n`);
      } else {
        process.stdout.write(`created task #${created.ref.number}\n`);
      }
      return 0;
    }
    case "edit": {
      const issue = await provider.get(ref("issue"));
      if (!issue) fail(`issue not found: ${refArg}`);
      const updated = await provider.update(issue.ref, {
        ...(flags.get("title") !== undefined ? { title: flags.get("title") } : {}),
        ...(flags.get("body") !== undefined ? { body: flags.get("body") } : {}),
      });
      process.stdout.write(`updated #${updated.ref.number}: ${updated.title}\n`);
      return 0;
    }
    case "close": {
      const issue = await provider.get(ref("issue"));
      if (!issue) fail(`issue not found: ${refArg}`);
      const completion = await checkCompletion(provider, l, issue);
      if (!completion.ok) fail(`cannot close #${issue.ref.number}: ${completion.reason}`);
      await provider.close(issue.ref, flags.get("reason") ?? "completed");
      const cascaded = await cascadeReserved(provider, issue, "close");
      process.stdout.write(`closed #${issue.ref.number}${cascaded.length ? ` (reserved: ${cascaded.map((n) => `#${n}`).join(", ")})` : ""}\n`);
      return 0;
    }
    case "reopen": {
      const issue = await provider.get(ref("issue"));
      if (!issue) fail(`issue not found: ${refArg}`);
      await provider.reopen(issue.ref);
      const cascaded = await cascadeReserved(provider, issue, "reopen");
      process.stdout.write(`reopened #${issue.ref.number}${cascaded.length ? ` (reserved: ${cascaded.map((n) => `#${n}`).join(", ")})` : ""}\n`);
      return 0;
    }
    case "link": {
      const issue = await provider.get(ref("issue"));
      if (!issue) fail(`issue not found: ${refArg}`);
      const parentArg = flags.get("parent");
      if (!parentArg) fail("usage: machine_code issue link <issue> --parent <ref>");
      const parent = await provider.get(parseIssueRef(parentArg, bundle.repo, "github"));
      if (!parent) fail(`parent not found: ${parentArg}`);
      const valid =
        (issue.kind === "feature" && parent.kind === "epic") || (issue.kind === "task" && parent.kind === "feature");
      if (!valid) fail(`invalid hierarchy: ${issue.kind} cannot be a child of ${parent.kind} (Feature→Epic, Task→Feature)`);
      if (issue.kind === "task") await ensureFeatureReserved(provider, parent.ref);
      if (issue.kind === "feature") await ensureEpicReserved(provider, parent.ref);
      await provider.linkParent(issue.ref, parent.ref);
      process.stdout.write(`linked #${issue.ref.number} under #${parent.ref.number}\n`);
      return 0;
    }
    case "ensure": {
      const issue = await provider.get(ref("issue"));
      if (!issue) fail(`issue not found: ${refArg}`);
      if (issue.kind === "epic") {
        const reserved = await ensureEpicReserved(provider, issue.ref);
        process.stdout.write(`epic #${issue.ref.number}: Feature 0 #${reserved.feature0.ref.number}, Task 0 #${reserved.task0.ref.number}\n`);
      } else if (issue.kind === "feature") {
        const task0 = await ensureFeatureReserved(provider, issue.ref);
        process.stdout.write(`feature #${issue.ref.number}: Task 0 #${task0.ref.number}\n`);
      } else {
        process.stdout.write(`task #${issue.ref.number}: nothing to ensure\n`);
      }
      return 0;
    }
    default:
      fail("usage: machine_code issue list|view|tree|create|edit|close|reopen|link|ensure");
  }
}

/** Human approval for a pending close/merge request. */
async function cmdApprove(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) fail("usage: machine_code approve <issue|pr>");
  const l = layout();
  const machine = loadMachineConfig(l);
  const ref = parseIssueRef(target, (await createIssueProvider(l, machine)).repo, "github");

  // A PR number merges; otherwise treat it as an issue-close approval.
  const { createPrProviderFor } = await import("./pr/factory.js");
  const prs = await createPrProviderFor(l);
  if (prs.provider.kind !== "none") {
    const pr = await prs.provider.status(ref.number);
    if (pr && pr.state === "open") {
      await prs.provider.merge(pr.number, "squash");
      const runs = listRuns(l).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      for (const run of runs) {
        const detail = readRun(l, run.id);
        if (!detail) continue;
        const requested = detail.events.some(
          (e) => e.type === "approval_requested" && (e as { action?: string; pr?: number }).action === "merge" && (e as { pr?: number }).pr === pr.number,
        );
        if (!requested) continue;
        const recorder = RunRecorder.reopen(l, detail.summary);
        recorder.event("approval_granted", { pr: pr.number, by: "human" });
        recorder.event("pr_merged", { pr: pr.number, by: run.id, approval: "human" });
        break;
      }
      process.stdout.write(`approved and merged PR #${pr.number} (squash)\n`);
      return 0;
    }
  }

  const bundle = await createIssueProvider(l, machine);
  if (bundle.provider.kind === "none") fail(`issue tracking unavailable: ${bundle.reason ?? "unknown"}`);
  const issue = await bundle.provider.get(ref);
  if (!issue) fail(`issue not found: ${target}`);

  // Find the newest run in this repo that requested approval for the issue.
  const runs = listRuns(l).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  let requestingRunId: string | undefined;
  for (const run of runs) {
    const detail = readRun(l, run.id);
    if (!detail) continue;
    const requested = detail.events.some(
      (e) => e.type === "approval_requested" && (e as { issue?: number }).issue === issue.ref.number,
    );
    const granted = detail.events.some(
      (e) => e.type === "approval_granted" && (e as { issue?: number }).issue === issue.ref.number,
    );
    if (requested && !granted) {
      requestingRunId = run.id;
      break;
    }
  }
  if (!requestingRunId) {
    process.stdout.write(`no pending approval for #${issue.ref.number}\n`);
    return 0;
  }
  await bundle.provider.close(issue.ref, "completed");
  const cascaded = await cascadeReserved(bundle.provider, issue, "close");
  const recorder = RunRecorder.reopen(l, readRun(l, requestingRunId)!.summary);
  recorder.event("approval_granted", { issue: issue.ref.number, by: "human", cascaded });
  recorder.event("issue_closed", { issue: issue.ref.number, by: requestingRunId, approval: "human" });
  process.stdout.write(`approved and closed #${issue.ref.number} (requested by run ${requestingRunId})\n`);
  return 0;
}

/* ---------------------------------------------------------------------- pr */

async function cmdPr(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  const l = layout();
  const machine = loadMachineConfig(l);
  if (sub === "feature") {
    const n = Number(positional[0]);
    if (!Number.isInteger(n) || n <= 0) fail("usage: machine_code pr feature <feature#> [--gates cmd1,cmd2] [--approval human|agent]");
    const bundle = await createIssueProvider(l, machine);
    if (bundle.provider.kind === "none") fail(`issue tracking unavailable: ${bundle.reason ?? "unknown"}`);
    const gates = (flags.get("gates") ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
      .map((command) => ({ command }));
    const recorder = new RunRecorder(l, {
      agent: "architect",
      mode: "",
      request: `publish feature #${n}`,
      repoRoot: l.repoRoot,
    });
    registerProject(l.home, l.repoRoot);
    const { publishFeature } = await import("./pr/feature.js");
    try {
      const result = await publishFeature({
        layout: l,
        machine,
        recorder,
        feature: { provider: "github", repo: bundle.repo ?? "", number: n },
        gates,
        defaultApproval: flags.get("approval") === "agent" ? "agent" : "human",
      });
      recorder.finalize(
        result.status === "merged" || result.status === "awaiting_approval" ? "completed" : "blocked",
        result.error,
        result.pr ? `PR #${result.pr.number} ${result.pr.url}` : result.error,
      );
      if (result.pr) process.stdout.write(`PR #${result.pr.number} ${result.status}: ${result.pr.url}
`);
      else process.stdout.write(`${result.status}: ${result.error ?? ""}
`);
      return result.status === "blocked" || result.status === "failed" ? EXIT.blocked : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recorder.finalize("failed", message);
      fail(message);
    }
  }
  if (sub === "list" || sub === "status") {
    const { createPrProviderFor } = await import("./pr/factory.js");
    const bundle = await createPrProviderFor(l);
    if (bundle.provider.kind === "none") fail(`pull requests unavailable: ${bundle.reason ?? "unknown"}`);
    if (sub === "list") {
      const prs = await bundle.provider.list({ state: (flags.get("state") as "open" | "closed" | "all") ?? "all" });
      if (prs.length === 0) process.stdout.write("no pull requests\n");
      for (const pr of prs) process.stdout.write(`#${pr.number} ${pr.state} ${pr.head} → ${pr.base}  ${pr.title}\n`);
      return 0;
    }
    const n = Number(positional[0]);
    if (!Number.isInteger(n) || n <= 0) fail("usage: machine_code pr status <number>");
    const pr = await bundle.provider.status(n);
    if (!pr) fail(`pull request #${n} not found`);
    process.stdout.write(`#${pr.number} ${pr.state}${pr.isDraft ? " draft" : ""} ${pr.head} → ${pr.base}\n${pr.title}\n${pr.url}\n`);
    return 0;
  }
  fail("usage: machine_code pr feature <n> | list | status <n>");
}

/* ------------------------------------------------------------------ accept */

/** Record a human acceptance verdict for an issue (required before closure). */
async function cmdAccept(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) fail("usage: machine_code accept <issue>");
  const l = layout();
  const machine = loadMachineConfig(l);
  const bundle = await createIssueProvider(l, machine);
  if (bundle.provider.kind === "none") fail(`issue tracking unavailable: ${bundle.reason ?? "unknown"}`);
  const ref = parseIssueRef(target, bundle.repo, "github");
  const issue = await bundle.provider.get(ref);
  if (!issue) fail(`issue not found: ${target}`);

  const runs = listRuns(l)
    .filter((r) => r.issue && r.issue.number === ref.number && r.issue.repo === ref.repo)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const latest = runs[0];
  if (!latest) fail(`no run is associated with #${ref.number}; acceptance must be recorded by a run`);
  const detail = readRun(l, latest.id);
  if (!detail) fail(`run ${latest.id} is unreadable`);
  const recorder = RunRecorder.reopen(l, detail.summary);
  recorder.event("acceptance_verified", {
    issue: ref.number,
    by: "human",
    criteria: issue.acceptance,
    evidence: `accepted via CLI on run ${latest.id}`,
  });
  process.stdout.write(`acceptance recorded for #${ref.number} (run ${latest.id})\n`);
  return 0;
}

/* ------------------------------------------------------------ pause/cancel */

function controlCommand(action: "pause" | "cancel", argv: string[]): number {
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

function cmdRespond(argv: string[]): number {
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

/* --------------------------------------------------------------------- fork */

async function cmdFork(argv: string[]): Promise<number> {
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
    parent.agent,
    ...(parent.mode ? ["--mode", parent.mode] : []),
    ...(flags.has("inherit-worktree") && parent.worktree ? ["--inherit-worktree"] : []),
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

async function cmdResume(id: string | undefined, argv: string[]): Promise<number> {
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

  // Transcript + tail repair.
  const transcript = loadTranscript(runDir);
  const inbox = readInbox(runDir);
  let startMode: "prompt" | "continue" = "prompt";
  let initialMessages: import("@earendil-works/pi-agent-core").AgentMessage[] | undefined;
  let resumeAgent: AgentName = (s.agent as AgentName) ?? "general";
  let resumeRequest = s.request;

  if (transcript && transcript.messages.length > 0) {
    resumeAgent = (transcript.agent as AgentName) ?? resumeAgent;
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
    signal: undefined,
    initialMessages,
    startMode,
  });

  // A resumed Build phase still owes the runner its gates.
  if (result.status === "completed" && resumeAgent === "build" && s.packetId) {
    const packet = readPacket(l2, s.packetId);
    if (packet) {
      const gateOutcome = await runGates(resolveGates(packet), { root: toolRoot, commands });
      recorder.event("gates", {
        packet: packet.id,
        passed: gateOutcome.passed,
        results: gateOutcome.results.map((r) => ({ command: r.command, passed: r.passed, durationMs: r.durationMs })),
      });
      if (!gateOutcome.passed) {
        recorder.finalize("blocked", `acceptance gates failed: ${gateOutcome.results.filter((r) => !r.passed).map((r) => r.command).join(", ")}`, result.finalText);
        process.stdout.write(`${result.finalText}\n`);
        return EXIT.blocked;
      }
    }
  }

  recorder.finalize(result.status, result.error, result.finalText);
  if (result.finalText.trim().length > 0) process.stdout.write(`${result.finalText}\n`);
  const summary = recorder.current;
  process.stderr.write(
    `\nrun ${summary.id}: ${summary.status} — ${summary.modelCalls} call(s), ${summary.usage.totalTokens} tokens, $${summary.cost.actual.toFixed(6)} actual\n`,
  );
  return EXIT[result.status];
}

async function cmdPrune(argv: string[]): Promise<number> {
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

async function cmdWorktree(argv: string[]): Promise<number> {
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

function visibleWidth(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function cell(value: string, width: number): string {
  const v = visibleWidth(value);
  if (v > width) return value.slice(0, Math.max(0, width - 1)) + "…";
  return value + " ".repeat(width - v);
}

function healthGlyph(health: string): string {
  switch (health) {
    case "attention": return "✗";
    case "blocked": return "⊘";
    case "awaiting-human": return "?";
    case "paused": return "⏸";
    case "review": return "◎";
    case "stalled": return "◌";
    case "done": return "✓";
    default: return "●";
  }
}

function runGlyph(status: string): string {
  switch (status) {
    case "running": return "●";
    case "awaiting_input": return "?";
    case "paused": return "⏸";
    case "interrupted": return "◯";
    case "blocked": return "⊘";
    case "failed": return "✗";
    case "completed": return "✓";
    case "cancelled": return "⃠";
    default: return "○";
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function fmtRunTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtMoney(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function modeSuffix(mode: string | undefined): string {
  return mode ? `/${mode}` : "";
}

function rowText(row: RunRow, width: number, group: RunGroup): string {
  const indent = "  ".repeat(row.depth);
  if (row.kind === "repo") {
    const fold = row.collapsed ? "▸" : "▾";
    const head = `${fold} ${row.label} (${row.count})`;
    const tail = width < 100 ? "" : `  ${row.repoRoot}`;
    return cell(head, Math.max(24, width - visibleWidth(tail))) + tail;
  }
  if (row.kind === "section") {
    return `${indent}${row.collapsed ? "▸" : "▾"} ${row.label} (${row.count})`;
  }
  if (row.kind === "issue") {
    const fold = row.collapsible ? (row.collapsed ? "▸" : "▾") : " ";
    const pct = row.rollup.pct === undefined ? "—" : `${row.rollup.pct}%`;
    const badge = row.issue.reserved ? " [P&R]" : "";
    const runs = row.rollup.runsTotal > 0 ? `runs ${row.rollup.runsTotal}` : "runs 0";
    const head = `${indent}${fold} ${healthGlyph(row.rollup.health)} #${row.issue.ref.number} ${row.issue.kind}${badge} ${row.issue.title}`;
    const tail = `  ${pct} ${row.rollup.tasksClosed}/${row.rollup.tasksTotal} · ${runs}${row.rollup.runsActive ? ` (${row.rollup.runsActive})` : ""} · ${fmtMoney(row.rollup.cost)}`;
    if (width < 100) return cell(head, Math.max(20, width - 22)) + tail;
    return cell(head, width - visibleWidth(tail)) + tail;
  }
  const run = row.run;
  const pr = run.prNumber ? ` PR#${run.prNumber}${run.prState ? `:${run.prState}` : ""}` : "";
  const ask = run.status === "awaiting_input" ? " ASK" : "";
  const repo = group === "overall" ? ` [${repoLabel(run.repoRoot)}]` : "";
  const head = `${indent}${runGlyph(run.status)} ${run.id.slice(-8)} ${run.agent}${modeSuffix(run.mode)}${ask}${pr}${repo}`;
  const tail = ` ${fmtTokens(run.usage.totalTokens)}tok ${fmtMoney(run.cost.actual)} ${run.request.replace(/\s+/g, " ").slice(0, width < 100 ? 28 : 60)}`;
  return cell(head, Math.max(24, width - visibleWidth(tail))) + tail;
}

function parseRunGroup(value: string): RunGroup | null {
  switch (value.toLowerCase()) {
    case "gh":
    case "gh-issue":
    case "issue":
    case "issues":
    case "project":
      return "gh-issue";
    case "status":
      return "status";
    case "overall":
    case "all":
    case "all-status":
    case "machine":
      return "overall";
    default:
      return null;
  }
}

function cmdRuns(argv: string[]): number {
  const { flags } = parseFlags(argv);
  const l = layout();
  const group = parseRunGroup(flags.get("group") ?? "gh-issue");
  if (!group) fail("--group must be gh-issue|status|overall");
  const filter = (flags.get("filter") ?? "all") as RunFilter;
  if (!["all", "active", "awaiting", "paused", "completed"].includes(filter)) {
    fail("--filter must be all|active|awaiting|paused|completed");
  }
  const text = flags.get("text") ?? flags.get("q");
  const attention = flags.has("attention");
  const projectFilter = flags.get("project");
  const allRuns = listAllRuns(l.home);
  const selected = projectFilter ? allRuns.filter((run) => run.repoRoot === projectFilter) : allRuns;
  const runs = filterRuns(selected, filter);

  const issuesByRepo = new Map<string, readonly Issue[]>();
  for (const repoRoot of new Set([l.repoRoot, ...runs.map(repoOf)])) {
    if (!repoRoot) continue;
    const cache = readIssueCache(layout(repoRoot));
    if (cache) issuesByRepo.set(repoRoot, cache.issues);
  }

  const index = buildRunIndex({
    runs,
    issuesByRepo,
    group,
    text,
    attentionOnly: attention,
    preferredRepo: l.repoRoot,
  });

  if (flags.has("json")) {
    const rows = index.rows.map((row) => {
      if (row.kind === "repo") {
        return { kind: row.kind, depth: row.depth, repoRoot: row.repoRoot, label: row.label, count: row.count };
      }
      if (row.kind === "section") {
        return { kind: row.kind, depth: row.depth, id: row.id, label: row.label, count: row.count };
      }
      if (row.kind === "issue") {
        return { kind: row.kind, depth: row.depth, issue: row.issue, rollup: row.rollup };
      }
      return { kind: row.kind, depth: row.depth, run: row.run };
    });
    process.stdout.write(`${JSON.stringify({ group, count: index.runs.length, rows }, null, 2)}\n`);
    return 0;
  }

  if (index.rows.length === 0) {
    process.stdout.write("no runs or issues\n");
    return 0;
  }
  const width = process.stdout.columns || 120;
  for (const row of index.rows) process.stdout.write(`  ${rowText(row, width, group)}\n`);
  return 0;
}

/* ------------------------------------------------------------------- show */

function tailFile(path: string, max = 600): string {
  return readLogTail(path, max);
}

async function cmdProcesses(argv: string[]): Promise<number> {
  const args = argv.filter((value) => !value.startsWith("--"));
  const json = argv.includes("--json");
  const l = layout();
  const find = (runId: string) => {
    const found = findRunAnywhere(l.home, runId);
    if (!found) fail(`no such run: ${runId}`);
    return { ...found, runDir: join(found.layout.runsDir, found.run.summary.id) };
  };

  if (args[0] === "kill") {
    const runId = args[1];
    const target = args[2];
    if (!runId || !target) fail("usage: machine_code processes kill <run-id> <process-id|all>");
    const found = find(runId);
    const records = reconcileProcessRecords(found.runDir);
    if (target === "all") {
      const outcome = await terminateAllProcesses(records);
      process.stdout.write(
        `terminated ${outcome.terminated} process(es)` +
          `${outcome.killed ? `; ${outcome.killed} required SIGKILL` : ""} for ${found.run.summary.id}\n`,
      );
      return 0;
    }
    const record = latestProcessRecords(records).find((entry) => entry.id === target);
    if (!record) fail(`no process ${target} for ${found.run.summary.id}`);
    try {
      const outcome = await terminateProcessRecord(record);
      process.stdout.write(
        `${outcome === "kill" ? "SIGKILL" : "SIGTERM"} for ${record.id} (${record.name})\n`,
      );
    } catch (error) {
      fail((error as Error).message);
    }
    return 0;
  }

  if (args[0] === "logs") {
    const runId = args[1];
    const target = args[2];
    if (!runId || !target) fail("usage: machine_code processes logs <run-id> <process-id>");
    const found = find(runId);
    const record = reconcileProcessRecords(found.runDir).find((entry) => entry.id === target);
    if (!record) fail(`no process ${target} for ${found.run.summary.id}`);
    process.stdout.write(`${record.id} ${record.name}  ${record.status}\n`);
    const stdout = tailFile(record.stdoutLog, 20_000);
    const stderr = tailFile(record.stderrLog, 20_000);
    if (stdout) process.stdout.write(`\n--- stdout ---\n${stdout}\n`);
    if (stderr) process.stdout.write(`\n--- stderr ---\n${stderr}\n`);
    if (!stdout && !stderr) process.stdout.write("(no output recorded)\n");
    return 0;
  }

  const runId = args[0];
  if (!runId) fail("usage: machine_code processes <run-id> [--json] | processes kill <run-id> <id|all> | processes logs <run-id> <id>");
  const found = find(runId);
  const records = reconcileProcessRecords(found.runDir);
  if (json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write(`no processes recorded for ${found.run.summary.id}\n`);
    return 0;
  }
  for (const record of records) {
    const pid = record.pid ? `pid ${record.pid}` : "pid -";
    const exit = record.exitCode === undefined ? "" : ` exit ${record.exitCode}`;
    process.stdout.write(
      `${record.id}  ${record.status.padEnd(10)} ${record.origin.padEnd(8)} ${record.name.padEnd(24)} ${pid}${exit}\n`,
    );
    const tail = tailFile(record.stdoutLog, 180).trim().split("\n").at(-1);
    if (tail) process.stdout.write(`   ${tail}\n`);
  }
  return 0;
}

async function cmdOrchestrate(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0] ?? "status";
  if (sub !== "status" && sub !== "tick" && sub !== "start" && sub !== "approve") {
    fail("usage: machine_code orchestrate status|tick|start|approve [--dry-run] [--scope project|epic|feature]");
  }
  const dryRun = flags.has("dry-run") || flags.has("json") || sub === "status";
  const l = layout();
  const machine = loadMachineConfig(l);
  if (sub === "approve") {
    const id = flags.get("orchestration");
    const task = Number(flags.get("task"));
    if (!id || !Number.isInteger(task) || task <= 0) {
      fail("usage: machine_code orchestrate approve --orchestration <id> --task <number>");
    }
    const state = readOrchestration(l, id);
    if (!state) fail(`no such orchestration: ${id}`);
    if (state.stopReason) fail(`orchestration ${id} is stopped: ${state.stopReason}`);
    const resultApproval = flags.has("result");
    const current = resultApproval ? state.approvedResults ?? [] : state.approvedPackets ?? [];
    const approved = [...new Set([...current, task])].sort((a, b) => a - b);
    updateOrchestration(l, id, {
      ...(resultApproval ? { approvedResults: approved } : { approvedPackets: approved }),
      checkpoint: resultApproval ? "result_approved" : "packet_approved",
    });
    process.stdout.write(`approved ${resultApproval ? "result" : "packet"} for task #${task} in orchestration ${id}\n`);
    return 0;
  }
  const bundle = await createIssueProvider(l, machine);
  if (bundle.provider.kind === "none") fail(`issue tracking unavailable: ${bundle.reason ?? "unknown reason"}`);

  let scope: OrchestrationScope =
    flags.get("scope") === "project" || flags.get("scope") === "feature" || flags.get("scope") === "epic"
      ? (flags.get("scope") as OrchestrationScope)
      : flags.has("feature")
        ? "feature"
        : "epic";
  let scopeRef: IssueRef | undefined;
  if (scope === "epic") {
    const epic = flags.get("epic");
    if (!epic) fail("epic scope needs --epic <number>");
    scopeRef = parseIssueRef(epic, bundle.repo, "github");
  } else if (scope === "feature") {
    const feature = flags.get("feature");
    if (!feature) fail("feature scope needs --feature <number>");
    scopeRef = parseIssueRef(feature, bundle.repo, "github");
  }

  let orchestration: OrchestrationState | undefined;
  const requestedId = flags.get("orchestration");
  if (requestedId) {
    orchestration = readOrchestration(l, requestedId) ?? undefined;
    if (!orchestration) fail(`no such orchestration: ${requestedId}`);
    scope = orchestration.scope;
    scopeRef = orchestration.scopeRef;
  } else if (!dryRun) {
    if (sub === "tick") {
      orchestration = listOrchestrations(l).find(
        (state) =>
          state.scope === scope &&
          ((!scopeRef && !state.scopeRef) ||
            (scopeRef && state.scopeRef && scopeRef.repo === state.scopeRef.repo && scopeRef.number === state.scopeRef.number)),
      );
    }
    orchestration ??= createOrchestration(l, scope, scopeRef);
  }
  if (orchestration?.stopReason) fail(`orchestration ${orchestration.id} stopped: ${orchestration.stopReason}`);

  const maxParallelRaw = flags.get("max-parallel");
  const maxParallel = maxParallelRaw === undefined ? 2 : Number(maxParallelRaw);
  if (!Number.isInteger(maxParallel) || maxParallel < 0) fail("--max-parallel must be a non-negative integer");

  const issues = await bundle.provider.list({ state: "all", limit: 500 });
  const runs = listRuns(l);
  const result = planSchedule({ issues, scope, ...(scopeRef ? { scopeRef } : {}), runs, maxParallel });
  if (flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          orchestration: orchestration?.id ?? null,
          scope: result.scope,
          scopeRef: result.scopeRef ?? null,
          tasks: result.tasks.map((task) => ({
            number: task.issue.ref.number,
            title: task.issue.title,
            ready: task.ready,
            order: task.order,
            ...(task.reason ? { reason: task.reason } : {}),
            plan: task.plan ?? null,
          })),
          dispatch: result.dispatch.map((task) => task.issue.ref.number),
          errors: result.errors,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const scopeText = result.scopeRef ? `${result.scope} #${result.scopeRef.number}` : result.scope;
  process.stdout.write(`orchestration${orchestration ? ` ${orchestration.id}` : ""} ${scopeText}: ${result.tasks.length} task(s), ${result.ready.length} ready, ${result.dispatch.length} dispatch\n`);
  for (const task of result.tasks) {
    const mark = task.ready ? "READY" : "BLOCK";
    process.stdout.write(
      `  ${mark.padEnd(5)} #${task.issue.ref.number}  ${task.plan ? `${task.plan.status}/${task.plan.verification}` : "no-plan"}  ${task.issue.title}` +
        `${task.reason ? `\n         ${task.reason}` : ""}\n`,
    );
  }
  for (const error of result.errors) process.stderr.write(`orchestrate: ${error}\n`);

  if (dryRun) {
    if (result.dispatch.length > 0) {
      process.stdout.write(`dispatch: ${result.dispatch.map((task) => `#${task.issue.ref.number}`).join(", ")}\n`);
    }
    return 0;
  }
  if (!orchestration) fail("orchestration state missing");
  const runtime = await loadRuntime(l);
  const owner = `cli:${process.pid}`;
  if (!acquireLease(l, orchestration.id, owner, 120_000)) {
    fail(`orchestration ${orchestration.id} is leased by another process`);
  }
  const executed: Array<{ issue: number; runId: string; status: string; error?: string }> = [];
  let stopReason: string | undefined;
  let checkpoint: string | undefined;
  try {
    for (const task of result.dispatch) {
      if (!task.plan) continue;
      if (task.plan.role !== "build") {
        stopReason = `task #${task.issue.ref.number} has role ${task.plan.role}; review dispatch is not implemented`;
        process.stdout.write(`  HOLD  #${task.issue.ref.number}  ${stopReason}\n`);
        break;
      }
      if (task.plan.planReview === "human" && !(orchestration.approvedPackets ?? []).includes(task.issue.ref.number)) {
        checkpoint = "awaiting_packet_approval";
        process.stdout.write(`  HOLD  #${task.issue.ref.number}  awaiting packet approval\n`);
        break;
      }
      const priorAttempts = runs.filter((run) => {
        const assigned = run.taskIssue ?? run.issue;
        return assigned?.repo === task.issue.ref.repo && assigned.number === task.issue.ref.number;
      }).length;
      let retryEvidence: string | undefined;
      let taskDone = false;
      let failureStop: string | undefined;
      let resultHold = false;
      for (let retry = 0; retry <= task.plan.retriesBeforeReplan; retry++) {
        const attempt = priorAttempts + retry + 1;
        process.stdout.write(`  RUN   #${task.issue.ref.number}  attempt ${attempt}${retry > 0 ? ` (retry ${retry})` : ""}\n`);
        let outcome;
        try {
          outcome = await executeTask({
            layout: l,
            machine: runtime.machine,
            policy: runtime.policy,
            models: runtime.models,
            catalogue: runtime.catalogue.models,
            configuredProviders: runtime.configuredProviders,
            home: l.home,
            provider: bundle.provider,
            issue: task.issue,
            plan: task.plan,
            orchestrationId: orchestration.id,
            orchestrationScope: scope,
            ...(scopeRef ? { scopeRef } : {}),
            attempt,
            requireModel: flags.get("model"),
            ...(retryEvidence ? { retryEvidence } : {}),
          });
        } catch (error) {
          failureStop = `task #${task.issue.ref.number} crashed: ${(error as Error).message}`;
          process.stdout.write(`  STOP  #${task.issue.ref.number}  ${failureStop}\n`);
          break;
        }
        executed.push({ issue: task.issue.ref.number, runId: outcome.runId, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
        process.stdout.write(`  ${outcome.status === "completed" ? "DONE" : "STOP"}  #${task.issue.ref.number}  ${outcome.runId}  ${outcome.status}${outcome.error ? `  ${outcome.error}` : ""}\n`);
        if (outcome.status === "completed") {
          taskDone = true;
          if (task.plan.resultReview === "human" && !(orchestration.approvedResults ?? []).includes(task.issue.ref.number)) {
            resultHold = true;
            checkpoint = "awaiting_result_approval";
            process.stdout.write(`  HOLD  #${task.issue.ref.number}  awaiting result approval\n`);
          }
          break;
        }
        retryEvidence = outcome.error ?? outcome.status;
        const retryable = isRetryableFailure(retryEvidence);
        if (!retryable) {
          failureStop = `task #${task.issue.ref.number} ${outcome.status}: ${retryEvidence}`;
          break;
        }
        if (retry >= task.plan.retriesBeforeReplan) {
          failureStop = `task #${task.issue.ref.number} needs_planning after ${task.plan.retriesBeforeReplan + 1} attempt(s)`;
          break;
        }
        process.stdout.write(`  RETRY #${task.issue.ref.number}  evidence: ${retryEvidence.slice(0, 200)}\n`);
      }
      if (resultHold) break;
      if (!taskDone) {
        stopReason = failureStop ?? `task #${task.issue.ref.number} did not complete`;
        break;
      }
    }
    updateOrchestration(l, orchestration.id, {
      lastTickAt: new Date().toISOString(),
      checkpoint: checkpoint ?? (executed.length > 0 ? "after-build" : "preflight"),
      ...(stopReason ? { stopReason } : {}),
    });
  } finally {
    releaseLease(l, orchestration.id, owner);
  }
  return stopReason ? 1 : 0;
}

function cmdShow(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  if (!id) fail("show needs a run id");
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const run = found.run;
  const s = reconcileRun(run.summary);
  const runDir = join(found.layout.runsDir, s.id);
  const context = readContextManifest(runDir);
  const allRuns = listAllRuns(found.layout.home);
  const children = childRuns(allRuns, s.id);
  const thinking = thinkingChunks(run.events);
  const touched = touchedPaths(run.events);
  const changes = s.worktree ? changesFor(s.worktree) : null;
  const pending = latestUnansweredQuestion(
    run.events.filter((event) => event.type === "question") as Array<{ questionId?: string; text?: string }>,
    readInbox(runDir),
  );
  const lastModel = [...run.events].reverse().find((event) => event.type === "model_select" && !event.error);
  const lastActivity = [...run.events].reverse().find((event) => event.type === "tool_call_start" || event.type === "model_call_end");

  if (flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify({
        summary: s,
        context,
        children,
        thinking,
        touched,
        changes,
        pendingQuestion: pending ?? null,
        lastModel: lastModel?.key ?? null,
        lastActivity: lastActivity ?? null,
      }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(`${runGlyph(s.status)} ${s.id}  ${s.status.toUpperCase()}  ${s.agent}${modeSuffix(s.mode)}\n`);
  process.stdout.write(`  ${s.repoRoot}\n`);
  process.stdout.write(`  request  ${s.request.replace(/\s+/g, " ")}\n`);
  process.stdout.write(`  model    ${String(lastModel?.key ?? "(not selected yet)")}\n`);
  const ctx = contextUsage(s.usage, run.events);
  process.stdout.write(
    `  context  ${fmtRunTokens(ctx.tokens)} ctx  ${fmtRunTokens(s.usage.totalTokens)} total  ${fmtRunTokens(ctx.peakTokens)} peak\n`,
  );
  process.stdout.write(`  spend    ${s.modelCalls} calls  ${fmtTokens(s.usage.totalTokens)} tok  ${fmtMoney(s.cost.actual)} actual / ${fmtMoney(s.cost.estimated)} estimated\n`);
  if (s.issue) process.stdout.write(`  issue    #${s.issue.number}${s.branch ? `  branch ${s.branch}` : ""}${s.prNumber ? `  PR #${s.prNumber} ${s.prState ?? ""}` : ""}\n`);
  const runAccess = s.capabilities
    ? issueAccessFromCapabilities(s.capabilities)
    : agentDef(found.layout, s.agent).issueAccess;
  process.stdout.write(`  issues   ${runAccess}\n`);
  if (s.parentRunId) process.stdout.write(`  parent   ${s.parentRunId}\n`);
  if (s.worktree) process.stdout.write(`  worktree ${s.worktree}\n`);
  if (s.error) process.stdout.write(`  error    ${s.error}\n`);
  if (pending) process.stdout.write(`  \x1b[33m? AWAITING INPUT\x1b[0m ${pending.text ?? ""}\n`);

  if (context) {
    process.stdout.write(`\ncontext ${context.chars.toLocaleString()} chars, ${context.sources.length} source(s)\n`);
    for (const source of context.sources.slice(0, flags.has("context") ? 100 : 12)) {
      process.stdout.write(`  ${source.kind.padEnd(10)} ${String(source.bytes).padStart(6)}b ${source.origin.padEnd(9)} ${source.ref}${source.warning ? `  (${source.warning})` : ""}\n`);
    }
    if (!flags.has("context") && context.sources.length > 12) process.stdout.write(`  … ${context.sources.length - 12} more (--context)\n`);
  }

  const stateFile = join(runDir, "state.md");
  if (existsSync(stateFile)) {
    const stateLines = readFileSync(stateFile, "utf8").trim().split("\n");
    process.stdout.write(`\nstate${flags.has("state") ? "" : ` (first ${Math.min(stateLines.length, 24)} lines; --state for all)`}\n`);
    for (const line of stateLines.slice(0, flags.has("state") ? stateLines.length : 24)) {
      process.stdout.write(`  ${line}\n`);
    }
  }

  if (touched.length > 0) {
    process.stdout.write(`\nchanged paths\n`);
    for (const path of touched) process.stdout.write(`  ${path}\n`);
  }

  if (thinking.length > 0) {
    process.stdout.write(`\nlatest response\n`);
    const chunks = flags.has("thinking") ? thinking : thinking.slice(-1);
    for (const chunk of chunks) {
      for (const line of chunk.text.split("\n").slice(0, flags.has("thinking") ? 200 : 12)) process.stdout.write(`  ${line}\n`);
    }
  }

  if (changes) {
    process.stdout.write(`\nchanges\n`);
    if (changes.error) process.stdout.write(`  ${changes.error}\n`);
    if (changes.status) process.stdout.write(changes.status.split("\n").map((line) => `  ${line}`).join("\n") + "\n");
    if (changes.diffStat) process.stdout.write(changes.diffStat.split("\n").map((line) => `  ${line}`).join("\n") + "\n");
    if (changes.recent) process.stdout.write(`  recent commits:\n${changes.recent.split("\n").map((line) => `    ${line}`).join("\n")}\n`);
  }

  if (children.length > 0) {
    process.stdout.write(`\nchildren (${children.length})\n`);
    for (const child of children) {
      process.stdout.write(`  ${runGlyph(child.status)} ${child.id}  ${child.agent}${modeSuffix(child.mode)}  ${fmtMoney(child.cost.actual)}  ${child.request.slice(0, 60)}\n`);
    }
  }

  const events = flags.has("events") || flags.has("full") ? run.events : run.events.slice(-12);
  process.stdout.write(`\nevents${events.length < run.events.length ? ` (last ${events.length} of ${run.events.length})` : ""}\n`);
  if (events.length === 0) process.stdout.write("  no events\n");
  for (const event of events) {
    const line = fmtEvent(event as Record<string, unknown>);
    if (line) process.stdout.write(line + "\n");
  }
  if (!flags.has("events") && !flags.has("full") && run.events.length > 12) process.stdout.write(`  … ${run.events.length - 12} more (--events)\n`);
  return 0;
}

function cmdContext(argv: string[]): number {
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (!id) fail("context needs a run id");
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const manifest = readContextManifest(join(found.layout.runsDir, found.run.summary.id));
  if (!manifest) {
    process.stdout.write("no context manifest recorded for this run\n");
    return 0;
  }
  process.stdout.write(`context ${manifest.chars.toLocaleString()} chars  ${manifest.sources.length} source(s)\n`);
  for (const source of manifest.sources) {
    process.stdout.write(
      `  ${source.kind.padEnd(10)} ${String(source.bytes).padStart(7)}b ${source.origin.padEnd(9)} ${source.ref}${source.truncated ? " [truncated]" : ""}${source.warning ? ` (${source.warning})` : ""}\n`,
    );
  }
  return 0;
}

/* ------------------------------------------------------------------ spend */

function printSpendBucket(label: string, bucket: SpendBucket): void {
  const perMillion = bucket.tokens > 0 ? bucket.actual / (bucket.tokens / 1_000_000) : 0;
  process.stdout.write(
    `  ${cell(label, 42)} ${String(bucket.calls).padStart(5)} calls  ${fmtTokens(bucket.tokens).padStart(7)} tok  ${fmtTokens(bucket.freeTokens).padStart(7)} free  ${fmtMoney(bucket.actual)}  ${perMillion > 0 ? `${fmtMoney(perMillion)}/Mtok` : ""}\n`,
  );
}

function cmdSpend(argv: string[]): number {
  const { flags } = parseFlags(argv);
  const days = flags.has("days") ? Number(flags.get("days")) : 30;
  if (!Number.isFinite(days) || days < 0) fail("--days needs a non-negative number");
  const summary = readSpendSummary(layout().home, {
    days: days > 0 ? days : undefined,
    provider: flags.get("provider"),
    model: flags.get("model"),
    agent: flags.get("agent"),
    project: flags.get("project"),
  });
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`spend (${days ? `last ${days} days` : "all time"})\n`);
  process.stdout.write(`  actual ${fmtMoney(summary.totalActual)}   estimated ${fmtMoney(summary.totalEstimated)}   tokens ${fmtTokens(summary.totalTokens)}   free ${fmtTokens(summary.freeTokens)}\n`);
  const by = flags.get("by") ?? "provider";
  if (by === "provider") {
    process.stdout.write(`\nby provider\n`);
    for (const [key, bucket] of Object.entries(summary.byProvider).sort((a, b) => b[1].actual - a[1].actual)) printSpendBucket(key, bucket);
  } else if (by === "model") {
    process.stdout.write(`\nby model\n`);
    for (const [key, bucket] of Object.entries(summary.byModel).sort((a, b) => b[1].actual - a[1].actual).slice(0, 50)) printSpendBucket(key, bucket);
  } else if (by === "agent") {
    process.stdout.write(`\nby agent\n`);
    for (const [key, bucket] of Object.entries(summary.byAgent).sort((a, b) => b[1].actual - a[1].actual)) {
      printSpendBucket(key === "map" ? "map (semantic)" : key, bucket);
    }
  } else if (by === "day") {
    process.stdout.write(`\nby day\n`);
    const series = spendDays(summary, Math.min(days || 30, 90));
    const max = Math.max(0, ...series.map((entry) => entry.bucket.actual));
    for (const { day, bucket } of series) {
      process.stdout.write(`  ${day} ${spendBar(bucket.actual, max, 24)} ${fmtMoney(bucket.actual)}  ${fmtTokens(bucket.tokens)} tok  ${fmtTokens(bucket.freeTokens)} free\n`);
    }
  } else {
    fail("--by must be provider|model|day|agent");
  }
  return 0;
}

/* ------------------------------------------------------------- prompts */

function cmdPrompts(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const requested = positional[0];
  if (requested && !AGENT_NAMES.includes(requested)) {
    fail(`unknown agent "${requested}"; choose one of ${AGENT_NAMES.join(", ")}`);
  }
  const l = layout();
  const roles = requested ? [requested] : [...AGENT_NAMES];
  const rows = roles.map((role) => {
    const resolved = resolveAgent(l, role);
    return {
      role,
      chars: resolved.prompt.length,
      words: resolved.prompt.trim().split(/\s+/).filter(Boolean).length,
      prompt: resolved.prompt,
    };
  });
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(`\n# ${row.role} · ${row.chars} chars · ${row.words} words\n${row.prompt}\n`);
  }
  return 0;
}

/* --------------------------------------------------------------- map */

async function cmdMap(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const action = flags.has("status") ? "status" : flags.has("refresh") ? "refresh" : "render";
  const path = positional[0] ?? flags.get("path");
  const l = layout();
  if (flags.has("semantic") && flags.has("refresh")) {
    const runtime = await loadRuntime(l);
    const { buildRepoMap } = await import("./map/deterministic.js");
    const { ensureSemanticMap } = await import("./map/ensure.js");
    const built = await buildRepoMap(l.repoRoot);
    await ensureSemanticMap({
      root: l.repoRoot,
      map: built.map,
      models: runtime.models,
      catalogue: runtime.catalogue.models,
      configuredProviders: runtime.configuredProviders,
      fundedProviders: fundedProviderIds(runtime.machine.providers),
      policy: policyFor(l, "architect", runtime.policy),
      machine: runtime.machine,
      availability: loadAvailability(l.home),
      home: l.home,
      runId: "map-cli",
      force: true,
      recorder: {
        event: (type, data) => {
          if (type === "map_semantic") process.stderr.write(`map semantic ${JSON.stringify(data)}\n`);
        },
      },
    });
  }
  const { runMapCommand } = await import("./commands/map.js");
  const result = await runMapCommand(
    {
      action,
      ...(path ? { path } : {}),
      ...(flags.has("json") ? { json: true } : {}),
      ...(flags.has("no-symbols") ? { symbols: false } : {}),
      ...(flags.has("semantic") ? { semantic: true } : {}),
      ...(flags.has("refresh") ? { refresh: true } : {}),
    },
    l.repoRoot,
  );
  if (result.isError) fail(result.text);
  process.stdout.write(`${result.text}\n`);
  return 0;
}

/* ------------------------------------------------------------- tools/config */

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function cmdTools(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const l = layout();
  const sub = positional[0];

  if (sub === "add" || sub === "new") {
    const name = positional[1];
    if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      fail("usage: machine_code tools add <name> [--description D] [--command C] [--tags a,b] [--kind tool|script]");
    }
    const kind = flags.get("kind") === "script" ? "script" : "tool";
    if (sub === "new") {
      const lang = flags.get("lang") ?? "sh";
      if (!/^[a-z0-9]+$/i.test(lang)) fail("--lang must be a simple extension, e.g. sh|js|py");
      const dir = join(l.repoDir, "scripts");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${name}.${lang}`);
      if (existsSync(file)) fail(`script already exists: ${file}`);
      const body = lang === "sh"
        ? `#!/usr/bin/env bash\n# ${flags.get("description") ?? name}\nset -euo pipefail\n\n# arguments: $@\n`
        : `# ${flags.get("description") ?? name}\n`;
      writeFileSync(file, body, { encoding: "utf8", mode: 0o755 });
      const rel = file.slice(l.repoRoot.length + 1);
      const manifest = join(l.repoDir, "tools", `${name}.toml`);
      mkdirSync(join(l.repoDir, "tools"), { recursive: true });
      writeFileSync(
        manifest,
        [
          `name = ${tomlString(name)}`,
          `kind = "script"`,
          `description = ${tomlString(flags.get("description") ?? name)}`,
          `command = ${tomlString(rel)}`,
          `tags = ${JSON.stringify((flags.get("tags") ?? "script").split(",").map((tag) => tag.trim()).filter(Boolean))}`,
          "readonly = true",
          "",
        ].join("\n"),
        "utf8",
      );
      process.stdout.write(`created ${rel}\nmanifest ${manifest.slice(l.repoRoot.length + 1)}\n`);
      return 0;
    }
    const dir = join(l.repoDir, "tools");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.toml`);
    if (existsSync(file) && !flags.has("force")) fail(`tool already exists: ${file} (--force to replace)`);
    const command = flags.get("command") ?? flags.get("script");
    const tags = (flags.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
    writeFileSync(
      file,
      [
        `name = ${tomlString(name)}`,
        `kind = ${tomlString(kind)}`,
        `description = ${tomlString(flags.get("description") ?? name)}`,
        ...(command ? [`command = ${tomlString(command)}`] : []),
        `tags = ${JSON.stringify(tags)}`,
        `readonly = ${flags.get("readonly") === "false" ? "false" : "true"}`,
        "",
      ].join("\n"),
      "utf8",
    );
    process.stdout.write(`created ${file.slice(l.repoRoot.length + 1)}\nreference it from an issue with: mc:context {"tools":["${name}"]}\n`);
    return 0;
  }

  if (sub === "show") {
    const name = positional[1];
    if (!name) fail("usage: machine_code tools show <name>");
    const artifact = resolveArtifact(l, name);
    if (!artifact) fail(`no such tool/script: ${name}`);
    process.stdout.write(`${artifact.kind} ${artifact.name}\n${artifactSummary(artifact)}\nsource ${artifact.source}\n`);
    if (artifactExists(l, artifact)) {
      process.stdout.write(`\n${artifactPeek(l, artifact)}\n`);
    }
    return 0;
  }

  const kind = flags.get("kind") ?? (sub === "tool" || sub === "script" ? sub : undefined);
  let artifacts = listArtifacts(l);
  if (kind) artifacts = artifacts.filter((artifact) => artifact.kind === kind);
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
    return 0;
  }
  if (artifacts.length === 0) {
    process.stdout.write("no repo tools/scripts. Add .machine_code/tools/<name>.toml or .machine_code/scripts/<name>.\n");
    process.stdout.write("  machine_code tools new <name>        # script + manifest\n  machine_code tools add <name> --command 'scripts/x.sh'\n");
    return 0;
  }
  for (const artifact of artifacts) {
    process.stdout.write(`${artifact.kind.padEnd(7)} ${artifact.name.padEnd(24)} ${artifact.description || "(no description)"}\n`);
    process.stdout.write(`        ${artifact.command ?? artifact.path ?? "-"}  ${artifact.origin} ${artifact.source}${artifact.tags.length ? `  [${artifact.tags.join(", ")}]` : ""}\n`);
  }
  return 0;
}

function cmdConfig(argv: string[]): number {
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0] ?? "show";
  const l = layout();
  let machine;
  let policy;
  try { machine = loadMachineConfig(l); } catch { machine = undefined; }
  try { policy = loadPolicy(l); } catch { policy = undefined; }
  const rows = buildSettings(l, machine, policy);
  if (sub === "paths") {
    for (const row of rows.filter((entry) => entry.section === "paths")) process.stdout.write(`${row.label.padEnd(18)} ${row.value}\n`);
    return 0;
  }
  if (sub === "show" || sub === "list") {
    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    let section = "";
    for (const row of rows) {
      if (row.section !== section) {
        section = row.section;
        process.stdout.write(`\n${section.toUpperCase()}\n`);
      }
      process.stdout.write(`  ${row.label.padEnd(28)} ${row.value}${row.detail ? `  (${row.detail})` : ""}\n`);
      if (row.file) process.stdout.write(`  ${"".padEnd(28)} ${row.file}\n`);
    }
    return 0;
  }
  if (sub === "edit") {
    const targetArg = positional[1] ?? "machine";
    const target =
      targetArg === "machine" ? l.machineConfig :
      targetArg === "repo" ? l.policyFile :
      targetArg === "catalogue" ? l.catalogueFile :
      targetArg === "tools" ? join(l.repoDir, "tools") :
      targetArg === "scripts" ? join(l.repoDir, "scripts") :
      resolve(targetArg);
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) {
      process.stdout.write(`${target}\n`);
      return 0;
    }
    const result = spawnSync(`${editor}`, [target], { stdio: "inherit", shell: false });
    return result.status ?? 0;
  }
  fail("usage: machine_code config [paths|show|edit [machine|repo|catalogue|tools|scripts|path]]");
}

/* --------------------------------------------------------------- correction */

async function cmdCorrect(argv: string[]): Promise<number> {
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
  if (parent.worktree && existsSync(parent.worktree)) args.push("--inherit-worktree");
  if (parent.issue) args.push("--issue", String(parent.issue.number), "--auto-issue");
  args.push("--agent", parent.agent);
  if (parent.mode) args.push("--mode", parent.mode);
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

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  loadEnvFiles();
  const [command, ...rest] = process.argv.slice(2);
  let code: number;
  switch (command) {
    case "run":
      code = await cmdRun(rest);
      break;
    case "init":
      code = cmdInit();
      break;
    case "install":
      code = await cmdInstall(rest);
      break;
    case "providers":
      code = cmdProviders();
      break;
    case "models":
      code = cmdModels(rest);
      break;
    case "policy":
      code = cmdPolicy(rest);
      break;
    case "catalogue":
      if (rest[0] === "refresh") {
        code = await cmdCatalogueRefresh(rest.includes("--snapshot"));
      } else if (rest[0] === "snapshot") {
        code = cmdCatalogueSnapshot(rest[1]);
      } else {
        fail("usage: machine_code catalogue refresh [--snapshot] | snapshot [path]");
      }
      break;
    case "runs":
      code = cmdRuns(rest);
      break;
    case "show":
      code = cmdShow(rest);
      break;
    case "processes":
      code = await cmdProcesses(rest);
      break;
    case "context":
      code = cmdContext(rest);
      break;
    case "spend":
      code = cmdSpend(rest);
      break;
    case "prompts":
      code = cmdPrompts(rest);
      break;
    case "map":
      code = await cmdMap(rest);
      break;
    case "tools":
      code = cmdTools(rest);
      break;
    case "config":
    case "settings":
      code = cmdConfig(rest);
      break;
    case "correct":
      code = await cmdCorrect(rest);
      break;
    case "log":
      code = cmdLog(rest[0]);
      break;
    case "status":
      code = cmdStatus();
      break;
    case "resume":
      code = await cmdResume(rest[0], rest.slice(1));
      break;
    case "respond":
      code = cmdRespond(rest);
      break;
    case "pause":
      code = controlCommand("pause", rest);
      break;
    case "cancel":
      code = controlCommand("cancel", rest);
      break;
    case "fork":
      code = await cmdFork(rest);
      break;
    case "prune":
      code = await cmdPrune(rest);
      break;
    case "worktree":
      code = await cmdWorktree(rest);
      break;
    case "issue":
      code = await cmdIssue(rest);
      break;
    case "approve":
      code = await cmdApprove(rest);
      break;
    case "accept":
      code = await cmdAccept(rest);
      break;
    case "pr":
      code = await cmdPr(rest);
      break;
    case "provider":
      code = await cmdProvider(rest);
      break;
    case "model":
      code = await cmdModel(rest);
      break;
    case "availability":
      code = await cmdAvailability(rest);
      break;
    case "orchestrate":
      code = await cmdOrchestrate(rest);
      break;
    case "queue":
      code = await cmdQueue(rest);
      break;
    case "version":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      code = 0;
      break;
    case "tui":
      await runTui();
      code = 0;
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      code = 0;
      break;
    case undefined:
      await runTui();
      code = 0;
      break;
    default:
      process.stdout.write(HELP);
      fail(`unknown command: ${command}`);
  }
  process.exit(code);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
