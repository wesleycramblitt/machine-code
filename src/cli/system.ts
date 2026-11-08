/**
 * machine_code — CLI environment and tooling commands.
 *
 * Split from `src/cli.ts`; behavior unchanged. See `src/cli/common.ts` for
 * shared setup (flags, runtime, formatting, run lookup).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
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
import { orchestrate, executePacket } from "../orchestrate.js";
import { RunRecorder, listRuns, listAllRuns, readRun, registerProject, reconcileRun, pruneRuns, listProjects, sendControl, waitForControlAck, isPidAlive, isActiveStatus, type RunStatus, type RunSummary } from "../state/runs.js";
import { appendInbox, readInbox, latestUnansweredQuestion } from "../state/question.js";
import { summarizeRun, readStateView } from "../state/outcome.js";
import { isTimelineEvent } from "../tui/timeline.js";
import { loadTranscript, repairResumeTail } from "../state/transcript.js";
import { packetPath, parseVerificationCommands, readPacket } from "../packet.js";
import { runProc } from "../proc.js";
import { agentDef, type AgentName } from "../agents.js";
import { resolveAgent, resolveAgentConfig, type AgentConfig } from "../agents/config.js";
import { runLoop, type RunLoopResult } from "../loop.js";
import { policyFor, type OrchestrateResult } from "../orchestrate.js";
import { resolveGates, runGates } from "../verify.js";
import { defaultSkillsFor } from "../context/references.js";
import { allCommands } from "../commands/profiles.js";
import { createWorktree, removeWorktree, pruneWorktrees, recreateWorktreeFromBranch, branchExists, branchCheckedOutAt, mainWorktreeRoot, reusableWorktreeOwner, WorktreeError } from "../worktree.js";
import { loadAvailability, saveAvailability, clearFreeModelCooldowns } from "../availability.js";
import { applyProbeResult, probeCoolingModels, probeTarget, targetFor } from "../availability/probe.js";
import { isFreeRow } from "../select.js";
import { latestProcessRecords } from "../processes/registry.js";
import { readLogTail } from "../processes/logs.js";
import { reconcileProcessRecords } from "../processes/reconcile.js";
import { approvePacket, commitPlanningFiles, deletePacket, planBatchWaves } from "../tasks/packet.js";
import { deleteRun } from "../state/run-delete.js";
import {
  addIndexEntry,
  isBuildable,
  isValidSlug,
  listPacketFiles,
  PACKET_STATUSES,
  PACKET_REVIEWS,
  readPacketFile,
  renderPacketFile,
  slugify,
  writePacketFile,
  type PacketFile,
  type PacketReview,
  type PacketStatus,
} from "../plan/packets.js";
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

import { fail, parseFlags, loadRuntime, type Runtime } from "./common.js";

export function cmdInit(): number {
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
  // Language servers are checked, not auto-installed. A missing server only
  // disables LSP for that language; map/outline/text search still work.
  process.stdout.write("\nLanguage servers (install only the ones your repos use):\n");
  for (const spec of allServers()) {
    if (serverAvailable(spec.id)) {
      process.stdout.write(`  ok       ${spec.id.padEnd(12)} ${spec.name}\n`);
    } else {
      process.stdout.write(`  MISSING  ${spec.id.padEnd(12)} ${spec.name} — ${spec.install}\n`);
    }
  }

  process.stdout.write("\nOptional integrations:\n");
  if (findOnPath(["gh"])) {
    process.stdout.write(`  ok       gh (GitHub CLI — available)\n`);
  } else {
    process.stdout.write(`  MISSING  gh (GitHub CLI) — install: https://cli.github.com\n`);
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
        `\n[agents.research]\n` +
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

export const INSTALL_METHODS: readonly InstallMethod[] = ["download", "pacman", "apt", "dnf", "zypper", "apk", "cargo"];

export async function cmdInstall(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const method = (flags.get("method") ?? "download") as InstallMethod;
  if (!INSTALL_METHODS.includes(method)) {
    fail(`unknown method ${method}; choose from ${INSTALL_METHODS.join(", ")}`);
  }
  const l = layout();
  return installClis({ method, home: l.home, only: positional.length > 0 ? positional : undefined });
}

/* --------------------------------------------------------------- providers */


export function cmdProviders(): number {
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


export function policyTemplate(kind: "machine" | "repo"): string {
  if (kind === "machine") {
    return `# machine_code machine config (global defaults; repo policy wins)
[selection]
tier = "paid"              # free | paid
# first_token_timeout_ms = 60000   # abandon a stalled call; cool it and retry
# ollama_first_token_timeout_ms = 300000  # local Ollama waits far longer; it may be busy
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
export function cmdPolicy(argv: string[]): number {
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
    process.stdout.write(`  modes ${def.modes.length ? `${def.modes.join(", ")}${def.defaultMode ? ` (default ${def.defaultMode})` : ""}` : "single-agent"}\n`);
    process.stdout.write(`  axes ${floors || "(none)"}\n`);
    process.stdout.write(`  weights ${weights}${ap.axisWeights ? "" : " (role defaults)"}\n`);
  }
  process.stdout.write("\nedit: machine_code policy edit [--repo]\n");
  return 0;
}


export async function cmdMap(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const action = flags.has("status") ? "status" : flags.has("refresh") ? "refresh" : "render";
  const path = positional[0] ?? flags.get("path");
  const l = layout();
  if (flags.has("semantic") && flags.has("refresh")) {
    const runtime = await loadRuntime(l);
    const { buildRepoMap } = await import("../map/deterministic.js");
    const { ensureSemanticMap } = await import("../map/ensure.js");
    const built = await buildRepoMap(l.repoRoot);
    await ensureSemanticMap({
      root: l.repoRoot,
      map: built.map,
      models: runtime.models,
      catalogue: runtime.catalogue.models,
      configuredProviders: runtime.configuredProviders,
      fundedProviders: fundedProviderIds(runtime.machine.providers),
      policy: policyFor(l, "research", runtime.policy),
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
  const { runMapCommand } = await import("../commands/map.js");
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

/* -------------------------------------------------------------------- lsp */


export async function cmdLsp(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const action = positional[0] ?? "list";

  if (action === "list") {
    const specs = allServers();
    if (flags.has("json")) {
      process.stdout.write(
        JSON.stringify(
          specs.map((spec) => ({
            id: spec.id,
            name: spec.name,
            binary: spec.binary,
            available: serverAvailable(spec.id),
            extensions: spec.extensions,
            filenames: spec.filenames ?? [],
            install: spec.install,
            ...(spec.installCommand ? { installCommand: `${spec.installCommand.binary} ${spec.installCommand.args.join(" ")}` } : {}),
          })),
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    process.stdout.write(`${formatServerList()}\n`);
    return 0;
  }

  if (action === "status") {
    const l = layout();
    const { buildRepoMap } = await import("../map/deterministic.js");
    const built = await buildRepoMap(l.repoRoot);
    const entries = lspStatusForPaths(built.map.files.map((file) => file.path));
    if (flags.has("json")) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write("no matching language servers\n");
      return 0;
    }
    for (const entry of entries) {
      process.stdout.write(
        `${entry.language.padEnd(12)} ${entry.available ? "ready" : "missing"}  ${entry.name}` +
        `${entry.available ? "" : `  install: ${entry.install}`}\n`,
      );
    }
    return 0;
  }

  if (action === "install") {
    const ids = positional.slice(1);
    if (ids.length === 0) {
      for (const spec of allServers()) {
        if (!spec.installCommand) continue;
        process.stdout.write(
          `${spec.id.padEnd(12)} ${spec.installCommand.binary} ${spec.installCommand.args.join(" ")}\n`,
        );
      }
      return 0;
    }
    let code = 0;
    for (const id of ids) {
      const spec = serverForLanguage(id);
      if (!spec) {
        process.stderr.write(`unknown language "${id}"\n`);
        code = 1;
        continue;
      }
      if (serverAvailable(id)) {
        process.stdout.write(`${id}: ready\n`);
        continue;
      }
      if (!spec.installCommand) {
        process.stdout.write(`${id}: install: ${spec.install}\n`);
        code = 1;
        continue;
      }
      const command = `${spec.installCommand.binary} ${spec.installCommand.args.join(" ")}`;
      if (!flags.has("run")) {
        process.stdout.write(`${id}: ${command}\n  run with --run\n`);
        continue;
      }
      process.stdout.write(`${id}: ${command}\n`);
      const result = spawnSync(spec.installCommand.binary, spec.installCommand.args, { stdio: "inherit" });
      if (result.status !== 0) {
        process.stderr.write(`${id}: install failed (${result.status ?? "spawn error"})\n`);
        code = 1;
      }
    }
    return code;
  }

  fail("usage: machine_code lsp [list|status|install] [--json] [--run]");
  return 1;
}

/* ------------------------------------------------------------- tools/config */


export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function cmdTools(argv: string[]): number {
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


export function cmdConfig(argv: string[]): number {
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

