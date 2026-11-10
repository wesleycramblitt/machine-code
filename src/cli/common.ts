/**
 * machine_code — CLI shared setup.
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
import { orchestrate, executeIssue } from "../orchestrate.js";
import { RunRecorder, listRuns, listAllRuns, readRun, registerProject, reconcileRun, pruneRuns, listProjects, sendControl, waitForControlAck, isPidAlive, isActiveStatus, type RunStatus, type RunSummary } from "../state/runs.js";
import { appendInbox, readInbox, latestUnansweredQuestion } from "../state/question.js";
import { summarizeRun, readStateView } from "../state/outcome.js";
import { isTimelineEvent } from "../tui/timeline.js";
import { loadTranscript, repairResumeTail } from "../state/transcript.js";
import { runProc } from "../proc.js";
import { agentDef, type AgentName } from "../agents.js";
import { resolveAgent, resolveAgentConfig, type AgentConfig } from "../agents/config.js";
import { runLoop, type RunLoopResult } from "../loop.js";
import { policyFor, type OrchestrateResult } from "../orchestrate.js";
import { resolveGates, runGates } from "../verify.js";
import { defaultSkillsFor } from "../context/references.js";
import { allCommands } from "../commands/registry.js";
import { createWorktree, removeWorktree, pruneWorktrees, recreateWorktreeFromBranch, branchExists, branchCheckedOutAt, mainWorktreeRoot, reusableWorktreeOwner, WorktreeError } from "../worktree.js";
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


export interface Runtime {
  machine: ReturnType<typeof loadMachineConfig>;
  policy: ReturnType<typeof loadPolicy>;
  models: ReturnType<typeof createModelsCollection>;
  catalogue: NonNullable<ReturnType<typeof loadCatalogue>>;
  configuredProviders: Set<string>;
}

/** Shared setup for run/resume: config, providers, catalogue. */
export async function loadRuntime(l: ReturnType<typeof layout>): Promise<Runtime> {
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
  } else {
    // Live listings drift (models added/removed upstream); fold fresh
    // provider data into the catalogue file so selection sees it.
    try {
      const { reconcileCatalogue } = await import("../catalogue/reconcile.js");
      const { providerFetchOk } = await import("../models/providers.js");
      const reconciled = await reconcileCatalogue(l, models, (id) => providerFetchOk(id));
      for (const warning of reconciled.warnings) process.stderr.write(`warning: catalogue reconcile: ${warning}\n`);
      if (reconciled.changed) {
        for (const key of reconciled.added) process.stderr.write(`catalogue: +${key}\n`);
        for (const key of reconciled.removed) process.stderr.write(`catalogue: -${key}\n`);
        catalogue = loadCatalogue(l.catalogueFile) ?? catalogue;
      }
    } catch (error) {
      process.stderr.write(`warning: catalogue reconcile failed (${(error as Error).message}); using cached catalogue\n`);
    }
  }
  return { machine, policy, models, catalogue, configuredProviders };
}

export const VERSION = "0.0.0";

export const HELP = `machine_code ${VERSION}

Usage:
  machine_code run --agent research [--provider <id>] [--model <key>] "<question>"
  machine_code run --agent <role> --item <slug> ["<prompt>"]
                                    Attach the run to an issue; its prompt feeds the objective
                                    when the prompt is empty and the issue file is added to
                                    context. Engineer runs use an isolated worktree:
                                    [--item <slug>] [--base <ref>]
                                    Agent config overrides:
                                    [--approval human|agent] [--ambiguity strict|precise|adaptive|autonomous]
                                    [--tier free|paid] [--min-fit N] [--min-capability N]
                                    [--min-axes code=6.5,agentic=7]
                                    [--max-price $/M] [--max-input-price $/M] [--max-output-price $/M]
                                    [--model <key>] is a preference: auto-selection
                                    takes over if the pinned model fails (same for --provider)
                                    [--context-exclude '<json>'] omit selected context
                                    sections or sources from a run
                                    [--context-include '<json>'] add issue/knowledge/plan files
                                    selected in the composer
                                    [--skill-modes '<json>'] per-skill include|on-demand|exclude
  machine_code init                 Check CLIs, config, and repo layout
  machine_code install [--method download|pacman|apt|dnf|zypper|apk|cargo] [cli...]
                                    Install missing base CLIs (default: pinned static binaries)
  machine_code providers            List providers, key sources, and model counts
  machine_code models [filter]      Inspect the catalogue (--all, --provider, --family, --free,
                                    --coding, --tool, --min-cap, --axis, --sort, --axes, --json)
  machine_code policy [role]        Show effective capability policy (--json)
  machine_code policy edit [--repo] Edit machine defaults or repo overrides
  machine_code models --agent <role> Dry-run selection (--context-chars N, --min-fit N,
                                    --min-capability N, --min-axes code=6.5, --tier free|paid,
                                    --max-price $/M, --max-input-price $/M, --max-output-price $/M)
  machine_code catalogue refresh    Rebuild ~/.machine_code/catalogue/models.json
                                    (listings for Ollama/OpenRouter-style providers
                                    reconcile automatically; refresh re-scores everything)
                                    [--snapshot] also update data/models + data/offers
  machine_code catalogue snapshot   Write committed data/models + data/offers [base-dir]
  machine_code runs [--group all|type|category|status|overall] [--filter ...] [--text Q]
                                    Work tree: All (kind) · By type (kind+status) · By category (tag).
                                    Status/overall group raw runs.
  machine_code runs delete <run-id> [--yes] [--keep-worktree] [--keep-branch]
                                    [--force] [--no-cancel]
                                    Delete a run and its resources; active runs
                                    are cancelled and stopped first
  machine_code show <run-id>        Rich run detail: model, ask, context, state, changes,
                                    related [--events] [--thinking] [--changes] [--context]
                                    [--state] [--json]
  machine_code processes <run-id>   List run-owned processes [--json]
  machine_code processes kill <run-id> <process-id|all>
  machine_code processes logs <run-id> <process-id>
  machine_code context <run-id>     Print the run context manifest
  machine_code eval <run-id>        Score calls, tokens, cost, context, gates [--baseline <id>]
                                    [--max-calls N] [--max-cost N] [--max-tokens N]
                                    [--max-context N] [--gold a.ts,b.ts] [--json]
  machine_code pack                 Preview the curated run context
                                    [--agent <role>] [--model <key>]
                                    [--context-include <json>] [--context] [--json]
  machine_code map [path]           Deterministic repo map (--status, --refresh, --json,
                                    --no-symbols, --semantic (module index))
  machine_code lsp [list|status|install] Language servers, availability, install commands
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
  machine_code provider disable|enable <name>
  machine_code provider cooldown <name> [minutes] | cooldown clear <name>
  machine_code model show <key|name>   Inspect axes, offers, providers for a model
  machine_code model probe <key|name>  Probe model availability (free metadata)
  machine_code model cooldown clear <id>
  machine_code availability [--probe] [--free-only] [--json]
                                    Show or probe cooling model availability
  machine_code tui                 Launch the TUI (default when interactive)
  machine_code plan                 Render the issues tree: kind → status dir → issue (--json)
  machine_code issue list           List issue files under issues/<kind>/<status>/<slug>.md (--json)
  machine_code issue create <ideas|features|bugs> <slug> "<prompt>" [--priority N] [--review none|agent|human] [--verify a,b]
                                     Scaffold an issue file under issues/
  machine_code issue show <slug>    Show an issue file
  machine_code issue move <slug> <todo|blocked|done|researched>  Move an issue
  machine_code issue run <slug>     Research an idea, or build a feature/bug (gates + review)
  machine_code issue review <slug>  Review the issue in its latest engineer worktree
  machine_code build <slug>         Build an issue: engineer → gates → commit → done/
                                     [--review] add an independent review step [--model <key>]
  machine_code build "<goal>"        Self-scope a free-form goal into a feature, then build
  machine_code approve <slug>       Merge the issue branch into main and move it to done/
  machine_code delete <slug>        Remove an issue + branch [--force]
  machine_code batch                Build todo issues across worktrees by priority/deps
                                     [--max-parallel N] [--dry-run] [--auto-approve]
  machine_code version
`;


export function fail(message: string, code = 1): never {
  process.stderr.write(`machine_code: ${message}\n`);
  process.exit(code);
}

export const BOOLEAN_FLAGS = new Set([
  "all",
  "attention",
  "auto-issue",
  "axes",
  "calls",
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
  "json",
  "recreate",
  "status",
  "refresh",
  "no-symbols",
  "semantic",
  "state",
  "no-review",
  "packet",
  "with-review",
  "no-commit",
  "no-merge",
  "no-checks",
  "keep-worktree",
  "keep-branch",
  "retry",
  "resume",
  "cascade",
  "yes",
  "keep-runs",
]);

export function parseFlags(argv: string[]): { flags: Map<string, string>; positional: string[] } {
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
        // A bare switch never consumes the next arg — unless it is an
        // explicit boolean word, so `--auto-issue true "Do X"` does not leak
        // "true" into the positional request.
        const next = argv[i + 1];
        if (next !== undefined && /^(true|false|1|0|yes|no)$/i.test(next)) {
          flags.set(name, next);
          i += 1;
          continue;
        }
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

export const EXIT: Record<RunStatus, number> = {
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

export function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}


export function indentEventLines(text: string, prefix = "      "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function printRunOutcome(result: { status: string; finalText: string }, recorder: RunRecorder): void {
  if (result.finalText.trim().length > 0) process.stdout.write(`${result.finalText}\n`);
  const summary = recorder.current;
  const outcome = summary.summary;
  if (!outcome) return;
  // A simple completed answer is already the outcome; do not repeat it.
  const hasWork = recorder
    .readEvents()
    .some((event) => event.type === "tool_call_start" || event.type === "issue_created" || event.type === "gates");
  if (summary.status === "completed" && result.finalText.trim().length > 0 && !hasWork) return;
  process.stdout.write(`\n--- run summary ---\n${outcome}\n`);
}

export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result);
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const text = obj.content
      .filter(
        (item): item is { type: string; text: string } =>
          Boolean(item) &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      )
      .map((item) => item.text)
      .join("\n");
    if (text) return text;
  }
  if (typeof obj.preview === "string") {
    try {
      const parsed = JSON.parse(obj.preview) as unknown;
      const text = toolResultText(parsed);
      if (text) return text;
    } catch {
      // The capJson preview is often a truncated JSON document. Extract the
      // first text field so the CLI shows the tool output, not escaped JSON.
      const match = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(obj.preview);
      if (match) {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          // fall through to the truncated-text extraction
        }
      }
      const marker = '"text":"';
      const at = obj.preview.indexOf(marker);
      if (at >= 0) {
        return obj.preview
          .slice(at + marker.length)
          .replace(/…$/, "")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    }
    return obj.preview;
  }
  return JSON.stringify(result, null, 2);
}


export function fmtEvent(event: Record<string, unknown>, verbose = false): string {
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
    if (!input) return header;
    const lines = input.split("\n");
    const shown = verbose ? input : lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n…" : "");
    return `${header}\n${indentEventLines(shown)}`;
  }
  if (type === "model_call_end") {
    const u = rest.usage as { totalTokens: number };
    const header = head(type, `${rest.provider}/${rest.model}  ${rest.stopReason}  ${u.totalTokens} tok  $${typeof rest.cost === "number" ? rest.cost.toFixed(6) : "?"}`);
    const text = typeof rest.text === "string" ? rest.text.trim() : "";
    if (!text) return header;
    const lines = text.split("\n");
    const shown = verbose ? text : lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n…" : "");
    return `${header}\n${indentEventLines(shown)}`;
  }
  if (type === "tool_call_start") {
    const args = rest.args === undefined ? "" : `  ${JSON.stringify(rest.args)}`;
    return head(type, `${rest.tool}${args}`);
  }
  if (type === "tool_call") {
    const header = head(type, `${rest.tool}  ${rest.isError ? "ERROR" : "ok"}${typeof rest.durationMs === "number" ? `  ${rest.durationMs}ms` : ""}`);
    const result = rest.result;
    if (result === undefined) return header;
    const text = toolResultText(result);
    return `${header}\n${indentEventLines(text.slice(0, verbose ? 8_000 : 400))}`;
  }
  if (type === "run_end") return head(type, String(rest.status));
  if (type === "run_summary") {
    const body = verbose && typeof rest.text === "string" ? rest.text : "";
    return `${head(type, String(rest.headline ?? rest.stopReason ?? ""))}${body ? `\n${indentEventLines(body)}` : ""}`;
  }
  if (type === "turn_cap") return head(type, `reached ${rest.turns} turns`);
  if (type === "budget_exhausted") return head(type, `${rest.totalTokens} tokens (budget ${rest.budget})`);
  if (type === "loop_blocked") {
    const detail =
      rest.reason === "no-progress"
        ? `no progress after ${rest.noProgressCalls ?? "?"} research call(s)`
        : rest.reason === "next-required"
          ? "no next action recorded"
          : rest.reason === "plan-required"
            ? "no concrete build plan recorded"
            : `${rest.tool} repeated ${rest.repeats ?? "?"} times`;
    return head(type, detail);
  }
  if (type === "issue_created") return head(type, `#${rest.number} ${rest.kind} ${rest.title ?? ""}`);
  if (type === "issue_linked") return head(type, `#${rest.issue} under #${rest.parent}`);
  if (type === "plan_updated") return head(type, `#${rest.issue} ${rest.status} (${rest.verification})`);
  const detail = Object.keys(rest).length > 0 ? `  ${JSON.stringify(rest)}` : "";
  return head(type, detail.trim());
}


/** Find a run by id in this repo first, then across registered projects. */

export function findRunAnywhere(home: string, id: string): { layout: ReturnType<typeof layout>; run: NonNullable<ReturnType<typeof readRun>> } | null {
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

export function visibleWidth(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function cell(value: string, width: number): string {
  const v = visibleWidth(value);
  if (v > width) return value.slice(0, Math.max(0, width - 1)) + "…";
  return value + " ".repeat(width - v);
}

export function runGlyph(status: string): string {
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

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtRunTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtMoney(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function modeSuffix(mode: string | undefined): string {
  return mode ? `/${mode}` : "";
}
