/**
 * machine_code — CLI catalogue and model selection.
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
import { RunRecorder, listRuns, listAllRuns, readRun, registerProject, reconcileRun, pruneRuns, listProjects, sendControl, waitForControlAck, isPidAlive, isActiveStatus, type RunStatus, type RunSummary } from "../state/runs.js";
import { appendInbox, readInbox, latestUnansweredQuestion } from "../state/question.js";
import { summarizeRun, readStateView } from "../state/outcome.js";
import { isTimelineEvent } from "../tui/timeline.js";
import { loadTranscript, repairResumeTail } from "../state/transcript.js";
import { runProc } from "../proc.js";
import { agentDef, type AgentName } from "../agents.js";
import { resolveAgent, resolveAgentConfig, type AgentConfig } from "../agents/config.js";
import { runLoop, type RunLoopResult } from "../loop.js";
import { resolveGates, runGates } from "../verify.js";
import { defaultSkillsFor } from "../context/references.js";
import { allCommands } from "../commands/registry.js";
import { createWorktree, removeWorktree, pruneWorktrees, recreateWorktreeFromBranch, branchExists, branchCheckedOutAt, mainWorktreeRoot, reusableWorktreeOwner, WorktreeError } from "../worktree.js";
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

import { fail, parseFlags, loadRuntime, fmtCtx, type Runtime } from "./common.js";

export function parseAxisOverrides(value: string): Partial<Record<import("../config.js").CapabilityAxis, number>> {
  const out: Partial<Record<import("../config.js").CapabilityAxis, number>> = {};
  for (const part of value.split(",").map((v) => v.trim()).filter(Boolean)) {
    const [axis, raw] = part.split("=");
    if (!axis || raw === undefined || !(CAPABILITY_AXES as readonly string[]).includes(axis)) {
      fail(`--min-axes entries must be axis=value (${CAPABILITY_AXES.join(", ")})`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10) fail(`--min-axes ${axis} must be a number in 0-10`);
    out[axis as import("../config.js").CapabilityAxis] = n;
  }
  return out;
}

/* ------------------------------------------------------------------ models */


export function printModelRow(row: CatalogueRow): void {
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
export function cmdModels(argv: string[]): number {
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
    (m) => activeProviders.has(m.providerID) && (all || configured.has(m.providerID)),
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
  if (agent) {
    const def = agentDef(l, agent);
    const contextChars = flags.has("context-chars") ? Number(flags.get("context-chars")) : 16_000;
    if (!Number.isFinite(contextChars) || contextChars <= 0) fail("--context-chars needs a positive number");
    const fitOverride = flags.has("min-fit") ? Number(flags.get("min-fit")) : undefined;
    if (fitOverride !== undefined && (!Number.isFinite(fitOverride) || fitOverride < 0 || fitOverride > 10)) {
      fail("--min-fit needs a number in 0-10");
    }
    def.minFit = fitOverride ?? def.minFit;
    const override = flags.has("min-capability") ? Number(flags.get("min-capability")) : undefined;
    if (override !== undefined && (!Number.isFinite(override) || override < 0 || override > 10)) {
      fail("--min-capability needs a number in 0-10");
    }
    def.minCapability = override ?? def.minCapability;
    const axesOverride = flags.get("min-axes");
    if (axesOverride) def.minAxes = { ...(def.minAxes ?? {}), ...parseAxisOverrides(axesOverride) };
    const dryPrice = (name: string): number | undefined => {
      const raw = flags.get(name);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) fail(`--${name} needs a non-negative number ($ per 1M tokens)`);
      return n;
    };
    const dryMax = dryPrice("max-price");
    const dryMaxIn = dryPrice("max-input-price") ?? dryMax;
    const dryMaxOut = dryPrice("max-output-price") ?? dryMax;
    if (dryMaxIn !== undefined) machine.priceCaps.input = dryMaxIn;
    if (dryMaxOut !== undefined) machine.priceCaps.output = dryMaxOut;
    const result = pick({
      agent,
      agentDef: def,
      machine,
      catalogue: doc.models,
      configuredProviders: configured,
      availability: loadAvailability(l.home),
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars,
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
    const weights = axisWeights(agent, def);
    const floors = CAPABILITY_AXES.filter((axis) => (def.minAxes?.[axis] ?? 0) > 0)
      .map((axis) => `${axis}>=${def.minAxes![axis]}`)
      .join(" ");
    process.stdout.write(
      `agent ${agent}  tier ${machine.selection.tier}  min_context ${def.minContext}  min_fit ${def.minFit}  min_capability ${def.minCapability}  tool_call ${def.toolCall}\n`,
    );
    process.stdout.write(
      `axes ${floors || "(no axis floors)"}\n` +
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
    process.stdout.write("\ntop candidates (cheapest first):\n");
    for (const c of result.candidates) {
      process.stdout.write(
        `  ${c.key.padEnd(58)} fit ${c.fit.toFixed(2).padEnd(5)} ` +
          `~$${c.estimatedCost.toFixed(6)}\n`,
      );
    }
    process.stdout.write(
      `\nfiltered: ${result.rejectedCount} ineligible; eligible ${result.eligibleCount}; showing top ${result.candidates.length}\n`,
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
      `${flags.has("coding") ? "  coding" : ""}${flags.has("tool") ? "  tools" : ""}` +
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


export function writeModelSnapshot(document: CatalogueDocument, rootArg?: string): { modelsDir: string; offersDir: string; files: number } {
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

export function cmdCatalogueSnapshot(pathArg?: string): number {
  const l = layout();
  const document = loadCatalogue(l.catalogueFile);
  if (!document) fail(`no catalogue at ${l.catalogueFile} — run: machine_code catalogue refresh`);
  const written = writeModelSnapshot(document, pathArg);
  process.stdout.write(`model snapshot written to ${written.modelsDir}\n`);
  process.stdout.write(`provider offers written to ${written.offersDir}\n`);
  process.stdout.write(`  ${document.models.length} offers in ${written.files} files\n`);
  return 0;
}

export async function cmdCatalogueRefresh(snapshot = false): Promise<number> {
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
    process.stdout.write(`  ${result.curatedVetoes} row(s) removed by curation vetoes: ${result.curatedVetoKeys.join(", ")}\n`);
    process.stdout.write(`  (vetoes live in ~/.machine_code/curation.toml; remove a stanza to restore the model)\n`);
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

export async function cmdProvider(argv: string[]): Promise<number> {
  const sub = argv[0];
  const name = argv[1];
  if (!sub || !name) fail("usage: machine_code provider disable|enable|cooldown <name> [minutes]|cooldown clear <name>");
  const l = layout();
  const avail = await import("../availability.js");
  const state = avail.loadAvailability(l.home);
  if (sub === "disable") {
    avail.disableProvider(state, name);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${name} disabled (manual re-enable required)\n`);
  } else if (sub === "enable") {
    avail.enableProvider(state, name);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${name} enabled; cooldowns cleared\n`);
  } else if (sub === "cooldown" && (argv[2] === "clear" || argv[1] === "clear")) {
    // Accept both `cooldown clear <name>` (documented) and `cooldown <name> clear`.
    const target = argv[1] === "clear" ? argv[2] : name;
    if (!target) fail("usage: machine_code provider disable|enable|cooldown <name> [minutes]|cooldown clear <name>");
    avail.clearProviderCooldown(state, target);
    avail.saveAvailability(l.home, state);
    process.stdout.write(`provider ${target} cooldown cleared\n`);
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


export async function cmdAvailability(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const l = layout();
  const machine = loadMachineConfig(l);
  const state = loadAvailability(l.home);
  const catalogue = loadCatalogue(l.catalogueFile);
  if (!catalogue) fail("no catalogue; run machine_code catalogue refresh");
  const configured = new Set(providerStatuses(createModelsCollection()).filter((p) => p.configured).map((p) => p.id));
  const now = Date.now();
  if (flags.has("probe")) {
    const targets = probeCoolingCandidates(catalogue.models, state, configured);
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
    `probe ${machine.availability.probe}  interval ${Math.round(machine.availability.intervalMs / 1000)}s  timeout ${Math.round(machine.availability.timeoutMs / 1000)}s\n`,
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

export function probeCoolingCandidates(
  rows: readonly CatalogueRow[],
  state: ReturnType<typeof loadAvailability>,
  configured: ReadonlySet<string>,
) {
  return rows
    .filter((row) => configured.has(row.providerID) && (state.models[row.key]?.cooldownUntil ?? 0) > Date.now())
    .map(targetFor);
}

export async function cmdModel(argv: string[]): Promise<number> {
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
  const avail = await import("../availability.js");
  const state = avail.loadAvailability(l.home);
  avail.clearModelCooldown(state, id);
  avail.resetModelTier(state, id);
  avail.saveAvailability(l.home, state);
  process.stdout.write(`model ${id} cooldown cleared\n`);
  return 0;
}

