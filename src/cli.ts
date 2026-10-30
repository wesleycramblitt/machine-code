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
import { generalAgent } from "./agents.js";
import { runLoop } from "./loop.js";
import { RunRecorder, listRuns, readRun, type RunStatus } from "./state/runs.js";
import { SEARCH_EXCLUDES } from "./tools/safety.js";

const VERSION = "0.0.0";

const HELP = `machine_code ${VERSION}

Usage:
  machine_code run --mode solo --agent general [--provider <id>] "<question>"
  machine_code init                 Check CLIs, config, and repo layout
  machine_code providers            List providers, key sources, and model counts
  machine_code catalogue refresh    Rebuild ~/.machine_code/catalogue/models.json
  machine_code log <run-id>         Print a run's summary and events
  machine_code status               List runs (full status arrives in M2)
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

const BASE_CLIS: Array<{ names: string[]; purpose: string }> = [
  { names: ["git"], purpose: "worktrees, branches, status, diff, history" },
  { names: ["rg"], purpose: "text search and filtered file listing" },
  { names: ["sg", "ast-grep"], purpose: "structural code search and rewrites" },
  { names: ["jq"], purpose: "JSON queries" },
  { names: ["yq"], purpose: "YAML queries" },
  { names: ["sd"], purpose: "regex-by-default / literal bulk replacement" },
];

function commandExists(names: string[]): string | null {
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const name of names) {
    for (const dir of pathDirs) {
      if (dir && existsSync(join(dir, name))) return name;
    }
  }
  return null;
}

function cmdInit(): number {
  const l = layout();
  let problems = 0;
  process.stdout.write("machine_code init\n\nBase palette:\n");
  for (const cli of BASE_CLIS) {
    const found = commandExists(cli.names);
    if (found) {
      process.stdout.write(`  ok       ${cli.names[0]} (${cli.purpose})\n`);
    } else {
      process.stdout.write(`  MISSING  ${cli.names.join("/")} (${cli.purpose}) — configuration gap; install before runs that need it\n`);
      problems += 1;
    }
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
    process.stdout.write(`\n${problems} base CLI(s) missing; the affected tools report configuration gaps until installed.\n`);
  }
  return 0;
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
  const mode = flags.get("mode");
  const agentName = flags.get("agent");
  const requireProvider = flags.get("provider");
  const request = positional.join(" ").trim();

  if (mode !== "solo") fail(`M0 supports only --mode solo (packet modes arrive in M1)`);
  if (agentName !== "general") {
    fail(`solo mode requires --agent general (architect/build/review arrive in M1; sudo is not available in M0)`);
  }
  if (request.length === 0) fail(`run needs a question, e.g. machine_code run --mode solo --agent general "summarize README.md"`);

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

  const recorder = new RunRecorder(l, { agent: "general", mode: "solo", request });
  const agent = generalAgent(l);
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
  const result = await runLoop({
    models,
    catalogue: catalogueDoc.models,
    configuredProviders,
    agent,
    policy: policy.agents.general!,
    machine,
    request,
    root: l.repoRoot,
    recorder,
    requireProvider,
    signal: abort.signal,
  });

  recorder.finalize(result.status, result.error);
  if (result.finalText.trim().length > 0) {
    process.stdout.write(`${result.finalText}\n`);
  }
  const summary = recorder.current;
  process.stderr.write(
    `\nrun ${summary.id}: ${summary.status} — ${summary.modelCalls} call(s), ${summary.usage.totalTokens} tokens, $${summary.cost.actual.toFixed(6)} actual\n`,
  );
  return EXIT[result.status];
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
  const runs = listRuns(layout());
  if (runs.length === 0) {
    process.stdout.write("no runs yet\n");
    return 0;
  }
  for (const s of runs.slice(0, 20)) {
    process.stdout.write(
      `${s.status.padEnd(12)} ${s.id}  ${s.agent}  ${s.modelCalls} calls  ${s.usage.totalTokens} tok  $${s.cost.actual.toFixed(4)}  ${s.request.slice(0, 60)}\n`,
    );
  }
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
    case "version":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      code = 0;
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
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
