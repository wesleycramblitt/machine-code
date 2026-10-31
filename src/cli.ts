#!/usr/bin/env node
/**
 * machine_code — CLI.
 *
 * M0: init, providers, catalogue refresh, run (solo general), log, status.
 * The TUI becomes the default command in M3.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "./paths.js";
import { loadMachineConfig, loadPolicy, ConfigError } from "./config.js";
import { createModelsCollection, availableChatModels, providerStatuses } from "./models.js";
import { refreshCatalogue } from "./catalogue/refresh.js";
import { loadCatalogue } from "./catalogue/load.js";
// agents resolved inside orchestrate.ts
import { orchestrate, type RunMode } from "./orchestrate.js";
import { RunRecorder, listRuns, listAllRuns, readRun, registerProject, reconcileRun, pruneRuns, listProjects, type RunStatus } from "./state/runs.js";
import { loadAvailability } from "./availability.js";
import { runTui } from "./tui.js";
import { SEARCH_EXCLUDES } from "./tools/safety.js";
import { BASE_CLIS, findOnPath, installClis, type InstallMethod } from "./install.js";

const VERSION = "0.0.0";

const HELP = `machine_code ${VERSION}

Usage:
  machine_code run --mode solo --agent general [--provider <id>] "<question>"
  machine_code run --mode direct|verified|redundant "<task>"
  machine_code run --mode solo --agent sudo "<rare task>"
  machine_code init                 Check CLIs, config, and repo layout
  machine_code install [--method download|pacman|apt|dnf|zypper|apk|cargo] [cli...]
                                    Install missing base CLIs (default: pinned static binaries)
  machine_code providers            List providers, key sources, and model counts
  machine_code catalogue refresh    Rebuild ~/.machine_code/catalogue/models.json
  machine_code log <run-id>         Print a run's summary and events
  machine_code status               List runs across projects
  machine_code resume <run-id>      Resume an interrupted/failed/blocked run
  machine_code prune [--days N]     Remove old run dirs (default 7 days)
  machine_code provider disable|enable|cooldown <name>
  machine_code model cooldown clear <id>
  machine_code tui                 Launch the TUI (default when interactive)
  machine_code queue               Process committed packets in .machine_code/tasks/
  machine_code version
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`machine_code: ${message}\n`);
  process.exit(code);
}

function parseFlags(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) fail(`flag ${arg} needs a value`);
        flags.set(arg.slice(2), next);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const EXIT: Record<RunStatus, number> = {
  running: 1,
  done: 0,
  blocked: 2,
  failed: 1,
  interrupted: 130,
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
        `# min_capability = 0\n`,
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
  const configured = statuses.filter((s) => s.configured);
  process.stdout.write("Providers (key sources are environment variable names; values are never shown):\n\n");
  for (const s of statuses) {
    const mark = s.configured ? "configured  " : "unconfigured";
    const keys = s.envKeys.length > 0 ? s.envKeys.join(", ") : "(no env key — OAuth or ambient)";
    const source = s.source ? ` via ${s.source}` : "";
    process.stdout.write(`  ${mark}  ${s.id.padEnd(24)} ${s.modelCount} models  keys: ${keys}${source}\n`);
  }
  process.stdout.write(`\n${configured.length} configured.\n`);
  return configured.length > 0 ? 0 : 1;
}

/* --------------------------------------------------------------- catalogue */

async function cmdCatalogueRefresh(): Promise<number> {
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
  const requireProvider = flags.get("provider");
  const request = positional.join(" ").trim();

  if (request.length === 0) fail(`run needs a question, e.g. machine_code run --mode verified "fix the parser panic"`);

  const l = layout();
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
  const statuses = providerStatuses(models);
  const configuredProviders = new Set(statuses.filter((s) => s.configured).map((s) => s.id));
  if (configuredProviders.size === 0) {
    fail("no configured providers — set a provider key (e.g. OPENROUTER_API_KEY, OPENCODE_API_KEY)");
  }
  if (requireProvider && !configuredProviders.has(requireProvider)) {
    fail(`provider "${requireProvider}" is not configured`);
  }

  let catalogueDoc = loadCatalogue(l.catalogueFile);
  if (!catalogueDoc) {
    process.stderr.write("no catalogue on disk; refreshing (machine_code catalogue refresh to redo later)\n");
    const { models: available, warnings } = await availableChatModels(models);
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    const result = await refreshCatalogue(l, [...available], {
      openRouterKey: process.env.OPENROUTER_API_KEY,
    });
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    catalogueDoc = result.document;
  }

  const mode: import("./orchestrate.js").RunMode =
    modeFlag === "solo" || modeFlag === "direct" || modeFlag === "verified" || modeFlag === "redundant"
      ? modeFlag
      : "solo";

  const agentNameParsed =
    agentName === "general" || agentName === "sudo" || agentName === "architect" || agentName === "build" || agentName === "review"
      ? agentName
      : undefined;

  const recorder = new RunRecorder(l, { agent: agentNameParsed ?? "general", mode, request, repoRoot: l.repoRoot });
  registerProject(l.home, l.repoRoot);
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
  const result = await orchestrate({
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
    home: l.home,
    recorder,
    requireProvider,
    signal: abort.signal,
  });

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
  if (!sub || !name) fail("usage: machine_code provider disable|enable|cooldown clear <name>");
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
  } else {
    fail("usage: machine_code provider disable|enable|cooldown clear <name>");
  }
  return 0;
}

async function cmdModel(argv: string[]): Promise<number> {
  if (argv[0] !== "cooldown" || argv[1] !== "clear" || !argv[2]) {
    fail("usage: machine_code model cooldown clear <id>");
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

async function cmdQueue(): Promise<number> {
  const l = layout();
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
  const statuses = providerStatuses(models);
  const configuredProviders = new Set(statuses.filter((s) => s.configured).map((s) => s.id));
  if (configuredProviders.size === 0) fail("no configured providers");

  let catalogueDoc = loadCatalogue(l.catalogueFile);
  if (!catalogueDoc) {
    const { models: available, warnings } = await availableChatModels(models);
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    const result = await refreshCatalogue(l, [...available], { openRouterKey: process.env.OPENROUTER_API_KEY });
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    catalogueDoc = result.document;
  }

  const { listQueuedPackets, runQueue } = await import("./queue.js");
  const packets = listQueuedPackets(l);
  if (packets.length === 0) {
    process.stdout.write("no queued packets in .machine_code/tasks/\n");
    return 0;
  }
  process.stdout.write(`queue: ${packets.length} packet(s)\n`);
  const progress = await runQueue(l, async (packet) => {
    const recorder = new RunRecorder(l, { agent: packet.agent ?? (packet.mode === "solo" ? "general" : "architect"), mode: packet.mode, request: packet.goal, repoRoot: l.repoRoot, packetId: packet.id });
    registerProject(l.home, l.repoRoot);
    const abort = new AbortController();
    const result = await orchestrate({
      models,
      catalogue: catalogueDoc.models,
      configuredProviders,
      availability: loadAvailability(l.home),
      layout: l,
      machine,
      policy,
      mode: packet.mode as import("./orchestrate.js").RunMode,
      agentName: packet.agent ?? (packet.mode === "solo" ? "general" : undefined),
      request: packet.goal,
      root: l.repoRoot,
      home: l.home,
      recorder,
      packet,
      signal: abort.signal,
    });
    recorder.finalize(result.status, result.error, result.finalText);
    return { status: result.status, runId: recorder.id };
  }, (p) => {
    process.stdout.write(`  ${p.status.padEnd(12)} ${p.packet.id}\n`);
  });
  const done = progress.filter((p) => p.status === "done").length;
  const skipped = progress.filter((p) => p.status === "skipped").length;
  process.stdout.write(`\nqueue finished: ${done} done, ${skipped} skipped, ${progress.length - done - skipped} not done\n`);
  return progress.some((p) => p.status !== "done" && p.status !== "skipped") ? 1 : 0;
}

/* -------------------------------------------------------------------- log */

function fmtEvent(event: Record<string, unknown>): string {
  const t = String(event.t ?? "").slice(11, 19);
  const type = String(event.type);
  const rest = Object.fromEntries(Object.entries(event).filter(([k]) => k !== "t" && k !== "type"));
  let detail = "";
  if (type === "model_select") {
    detail = rest.error
      ? `error: ${rest.error}`
      : `-> ${rest.key}  est ${(rest.estimate as { inputTokens: number }).inputTokens}+${(rest.estimate as { outputTokens: number }).outputTokens} tok`;
  } else if (type === "model_call_end") {
    const u = rest.usage as { totalTokens: number };
    detail = `${rest.provider}/${rest.model}  ${rest.stopReason}  ${u.totalTokens} tok  $${typeof rest.cost === "number" ? rest.cost.toFixed(6) : "?"}`;
  } else if (type === "tool_call") {
    detail = `${rest.tool}  ${rest.isError ? "ERROR" : "ok"}`;
  } else if (type === "run_end") {
    detail = String(rest.status);
  }
  return `  ${t}  ${type.padEnd(18)} ${detail}`;
}

function cmdLog(id: string | undefined): number {
  if (!id) fail("log needs a run id");
  const run = readRun(layout(), id);
  if (!run) fail(`no such run: ${id}`);
  const s = run.summary;
  process.stdout.write(
    `run ${s.id}  ${s.status}\n  agent ${s.agent}  mode ${s.mode}\n  started ${s.startedAt}${s.endedAt ? `  ended ${s.endedAt}` : ""}\n  request: ${s.request}\n` +
      `  calls ${s.modelCalls}  turns ${s.turns}  tokens ${s.usage.totalTokens}  cost $${s.cost.actual.toFixed(6)} actual / $${s.cost.estimated.toFixed(6)} estimated\n`,
  );
  if (s.error) process.stdout.write(`  error: ${s.error}\n`);
  process.stdout.write("events:\n");
  for (const event of run.events) process.stdout.write(fmtEvent(event) + "\n");
  return 0;
}

function cmdStatus(): number {
  const l = layout();
  const runs = listAllRuns(l.home);
  if (runs.length === 0) {
    process.stdout.write("no runs yet\n");
    return 0;
  }
  for (const s of runs.slice(0, 30)) {
    process.stdout.write(
      `${s.status.padEnd(12)} ${s.id}  ${s.agent}  ${s.modelCalls} calls  ${s.usage.totalTokens} tok  $${s.cost.actual.toFixed(4)}  ${s.repoRoot}  ${s.request.slice(0, 40)}\n`,
    );
  }
  return 0;
}

function cmdResume(id: string | undefined): number {
  if (!id) fail("resume needs a run id");
  const l = layout();
  const run = readRun(l, id);
  if (!run) {
    // search other projects
    for (const project of listProjects(l.home)) {
      const rl = layout(project);
      const r = readRun(rl, id);
      if (r) {
        process.stdout.write(`run ${id} lives in ${project}; cd there and re-run, or pass --repo ${project}\n`);
        return 0;
      }
    }
    fail(`no such run: ${id}`);
  }
  const s = reconcileRun(run.summary);
  if (s.status === "running") {
    process.stdout.write(`run ${id} is still running (pid ${s.pid})\n`);
    return 0;
  }
  process.stdout.write(
    `run ${id}: ${s.status}\n  request: ${s.request}\n  worktree: ${s.worktree ?? "(none — solo read-only run)"}\n  packet:   ${join(l.localDir, "tasks", (s.id + ".md"))}\n`,
  );
  process.stdout.write(
    `\nTo resume: re-run the original request; the worktree (if any) is preserved at the path above.\n` +
      `  machine_code run --mode ${s.mode === "solo" ? "solo --agent " + s.agent : s.mode} ${JSON.stringify(s.request)}\n`,
  );
  return 0;
}

function cmdPrune(argv: string[]): number {
  const { flags } = parseFlags(argv);
  const days = Number(flags.get("days") ?? "7");
  if (!Number.isFinite(days) || days < 0) fail("prune --days must be a non-negative number");
  const l = layout();
  const { removed, skipped } = pruneRuns(l.home, days);
  process.stdout.write(`pruned ${removed} run(s) older than ${days} day(s); ${skipped} skipped (active/interrupted/recent).\n`);
  return 0;
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
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
    case "catalogue":
      if (rest[0] !== "refresh") fail("usage: machine_code catalogue refresh");
      code = await cmdCatalogueRefresh();
      break;
    case "log":
      code = cmdLog(rest[0]);
      break;
    case "status":
      code = cmdStatus();
      break;
    case "resume":
      code = cmdResume(rest[0]);
      break;
    case "prune":
      code = cmdPrune(rest);
      break;
    case "provider":
      code = await cmdProvider(rest);
      break;
    case "model":
      code = await cmdModel(rest);
      break;
    case "queue":
      code = await cmdQueue();
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
