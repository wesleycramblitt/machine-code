/**
 * machine_code — CLI run observability.
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
  planCategories,
  readPacketFile,
  renderPacketFile,
  renderPlan,
  slugify,
  toTaskPacket,
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

import { fail, parseFlags, loadRuntime, findRunAnywhere, visibleWidth, cell, runGlyph, fmtTokens, fmtRunTokens, fmtMoney, fmtCtx, modeSuffix, packetGlyph, fmtEvent, indentEventLines, type Runtime } from "./common.js";

export function cmdLog(id: string | undefined): number {
  if (!id) fail("log needs a run id");
  const run = readRun(layout(), id);
  if (!run) fail(`no such run: ${id}`);
  const s = run.summary;
  process.stdout.write(
    `run ${s.id}  ${s.status}\n  agent ${s.agent}  mode ${s.mode || "-"}\n  started ${s.startedAt}${s.endedAt ? `  ended ${s.endedAt}` : ""}\n  request: ${s.request}\n` +
      `  calls ${s.modelCalls}  turns ${s.turns}  tokens ${s.usage.totalTokens}  cost $${s.cost.actual.toFixed(6)} actual / $${s.cost.estimated.toFixed(6)} estimated\n`,
  );
  if (s.error) process.stdout.write(`  error: ${s.error}\n`);
  if (s.summary) process.stdout.write(`summary:\n${indentEventLines(s.summary)}\n`);
  process.stdout.write("events:\n");
  for (const event of run.events) {
    const line = fmtEvent(event);
    if (line) process.stdout.write(line + "\n");
  }
  return 0;
}

export async function cmdStatus(): Promise<number> {
  return cmdRuns(["--group", "overall"]);
}


export function rowText(row: RunRow, width: number, group: RunGroup): string {
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
  if (row.kind === "packet") {
    const fold = row.collapsible ? (row.collapsed ? "▸" : "▾") : " ";
    const runs = row.directRuns > 0 ? `runs ${row.directRuns}` : "";
    const head = `${indent}${fold} ${packetGlyph(row.packet.status)} ${row.slug} [${row.packet.status}]`;
    const tail = `  ${row.packet.deliverable.replace(/\s+/g, " ").slice(0, width < 100 ? 24 : 48)}${runs ? `  ${runs}` : ""}`;
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

export function parseRunGroup(value: string): RunGroup | null {
  switch (value.toLowerCase()) {
    case "packet":
    case "packets":
    case "plan":
    case "plans":
      return "packets";
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

export async function cmdRuns(argv: string[]): Promise<number> {
  if (argv[0] === "delete") {
    const { flags, positional } = parseFlags(argv.slice(1));
    if (!flags.has("yes")) fail("runs delete is destructive; rerun with --yes");
    const id = positional[0];
    if (!id) fail("usage: machine_code runs delete <run-id> [--yes] [--keep-worktree] [--keep-branch] [--force] [--no-cancel]");
    const found = findRunAnywhere(layout().home, id);
    if (!found) fail(`no such run: ${id}`);
    const result = await deleteRun({
      layout: found.layout,
      run: found.run.summary,
      deleteWorktree: !flags.has("keep-worktree"),
      deleteBranch: !flags.has("keep-branch"),
      force: flags.has("force"),
      terminate: !flags.has("no-cancel"),
    });
    process.stdout.write(
      `deleted run ${result.runId}` +
        `${result.cancelled ? "; cancelled active run" : ""}` +
        `${result.removedWorktree ? "; worktree removed" : ""}` +
        `${result.deletedBranch ? "; branch deleted" : ""}\n`,
    );
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    return 0;
  }
  const { flags } = parseFlags(argv);
  const l = layout();
  const group = parseRunGroup(flags.get("group") ?? "packets");
  if (!group) fail("--group must be packets|gh-issue|status|overall");
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

  const index = buildRunIndex({
    runs,
    group,
    text,
    attentionOnly: attention,
    preferredRepo: l.repoRoot,
    ...(group === "packets"
      ? { packetRepo: l.repoRoot, packets: listPacketFiles(l), planCategories: planCategories(l) }
      : {}),
  });

  if (flags.has("json")) {
    const rows = index.rows.map((row) => {
      if (row.kind === "repo") {
        return { kind: row.kind, depth: row.depth, repoRoot: row.repoRoot, label: row.label, count: row.count };
      }
      if (row.kind === "section") {
        return { kind: row.kind, depth: row.depth, id: row.id, label: row.label, count: row.count };
      }
      if (row.kind === "packet") {
        return { kind: row.kind, slug: row.slug, status: row.packet.status, depth: row.depth, directRuns: row.directRuns, deliverable: row.packet.deliverable };
      }
      return { kind: row.kind, depth: row.depth, run: row.run };
    });
    process.stdout.write(`${JSON.stringify({ group, count: index.runs.length, rows }, null, 2)}\n`);
    return 0;
  }

  if (index.rows.length === 0) {
    process.stdout.write("no runs\n");
    return 0;
  }
  const width = process.stdout.columns || 120;
  for (const row of index.rows) process.stdout.write(`  ${rowText(row, width, group)}\n`);
  return 0;
}

/* ------------------------------------------------------------------- show */


export function tailFile(path: string, max = 600): string {
  return readLogTail(path, max);
}

export async function cmdProcesses(argv: string[]): Promise<number> {
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


export function cmdShow(argv: string[]): number {
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
  const related = relatedRuns(allRuns, s);
  const thinking = thinkingChunks(run.events);
  const touched = touchedPaths(run.events);
  const changes = s.worktree ? changesFor(s.worktree) : null;
  const pending = latestUnansweredQuestion(
    run.events.filter((event) => event.type === "question") as Array<{ questionId?: string; text?: string }>,
    readInbox(runDir),
  );
  const lastModel = [...run.events].reverse().find((event) => event.type === "model_select" && !event.error);
  const lastActivity = [...run.events].reverse().find((event) => event.type === "tool_call_start" || event.type === "model_call_end");
  const derived = s.summary
    ? null
    : summarizeRun({
        summary: s,
        events: run.events,
        state: readStateView(runDir),
        finalText: s.finalText,
      });
  const outcome = s.summary ?? derived!.text;
  const stopReason = s.stopReason ?? derived?.stopReason ?? null;

  if (flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify({
        summary: s,
        context,
        related,
        thinking,
        touched,
        changes,
        pendingQuestion: pending ?? null,
        lastModel: lastModel?.key ?? null,
        lastActivity: lastActivity ?? null,
        outcome,
        stopReason,
      }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(`${runGlyph(s.status)} ${s.id}  ${s.status.toUpperCase()}${s.stopReason && s.stopReason !== "completed" ? ` (${s.stopReason})` : ""}  ${s.agent}${modeSuffix(s.mode)}\n`);
  process.stdout.write(`  ${s.repoRoot}\n`);
  process.stdout.write(`  request  ${s.request.replace(/\s+/g, " ")}\n`);
  process.stdout.write(`  model    ${String(lastModel?.key ?? "(not selected yet)")}\n`);
  const ctx = contextUsage(s.usage, run.events);
  process.stdout.write(
    `  context  ${fmtRunTokens(ctx.tokens)} ctx  ${fmtRunTokens(s.usage.totalTokens)} total  ${fmtRunTokens(ctx.peakTokens)} peak\n`,
  );
  process.stdout.write(`  spend    ${s.modelCalls} calls  ${fmtTokens(s.usage.totalTokens)} tok  ${fmtMoney(s.cost.actual)} actual / ${fmtMoney(s.cost.estimated)} estimated\n`);
  if (s.packetId) process.stdout.write(`  packet   ${s.packetId}${s.branch ? `  branch ${s.branch}` : ""}${s.prNumber ? `  PR #${s.prNumber} ${s.prState ?? ""}` : ""}\n`);
  if (s.parentRunId) process.stdout.write(`  parent   ${s.parentRunId}\n`);
  if (s.worktree) process.stdout.write(`  worktree ${s.worktree}\n`);
  if (s.error) process.stdout.write(`  error    ${s.error}\n`);
  if (pending) process.stdout.write(`  \x1b[33m? AWAITING INPUT\x1b[0m ${pending.text ?? ""}\n`);
  process.stdout.write(`\nsummary\n${outcome.split("\n").map((line) => `  ${line}`).join("\n")}\n`);

  if (context) {
    process.stdout.write(`\ncontext ${context.chars.toLocaleString()} chars, ${context.sources.length} source(s)\n`);
    for (const source of context.sources.slice(0, flags.has("context") ? 100 : 12)) {
      process.stdout.write(`  ${source.kind.padEnd(10)} ${String(source.bytes).padStart(6)}b ${source.origin.padEnd(9)} ${source.ref}${source.warning ? `  (${source.warning})` : ""}\n`);
    }
    if (!flags.has("context") && context.sources.length > 12) process.stdout.write(`  … ${context.sources.length - 12} more (--context)\n`);
    for (const warning of context.warnings) process.stdout.write(`  warning: ${warning}\n`);
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
    process.stdout.write(`\nlatest thinking / text\n`);
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

  if (s.orchestrationId || related.length > 0) {
    process.stdout.write(`\nrelated\n`);
    if (s.orchestrationId) {
      process.stdout.write(
        `  orchestration ${s.orchestrationId}${s.orchestrationScope ? ` (${s.orchestrationScope})` : ""}\n`,
      );
    }
    if (s.attempt !== undefined) process.stdout.write(`  attempt       ${s.attempt}\n`);
    if (s.phase) process.stdout.write(`  phase         ${s.phase}\n`);
    if (s.planReview) process.stdout.write(`  plan review   ${s.planReview}\n`);
    if (s.resultReview) process.stdout.write(`  result review ${s.resultReview}\n`);
    if (s.parentRunId) process.stdout.write(`  parent        ${s.parentRunId}\n`);
    if (s.resumedFrom) process.stdout.write(`  resumed from  ${s.resumedFrom}\n`);
    if (s.forkReason) process.stdout.write(`  fork reason   ${s.forkReason}\n`);
    for (const run of related) {
      process.stdout.write(
        `  ${runGlyph(run.status)} ${run.id}  ${run.agent}${modeSuffix(run.mode)}  ${fmtMoney(run.cost.actual)}  ${run.request.slice(0, 60)}\n`,
      );
    }
  }

  const showAll = flags.has("events") || flags.has("full");
  const visibleEvents = showAll ? run.events : run.events.filter((event) => isTimelineEvent(event, false));
  const events = showAll ? visibleEvents : visibleEvents.slice(-12);
  process.stdout.write(`\nevents${events.length < visibleEvents.length ? ` (last ${events.length} of ${visibleEvents.length} key events)` : ""}${showAll ? "" : "  (--events for all)"}\n`);
  if (events.length === 0) process.stdout.write("  no key events\n");
  for (const event of events) {
    const line = fmtEvent(event as Record<string, unknown>, showAll);
    if (line) process.stdout.write(line + "\n");
  }
  if (!showAll && visibleEvents.length > 12) process.stdout.write(`  … ${visibleEvents.length - 12} more (--events)\n`);
  return 0;
}

export async function cmdEval(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  if (!id) fail("eval needs a run id");
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const metrics = runMetrics(found.run.summary, found.run.events);
  const baselineId = flags.get("baseline");
  const baselineFound = baselineId ? findRunAnywhere(layout().home, baselineId) : null;
  if (baselineId && !baselineFound) fail(`no such baseline run: ${baselineId}`);
  const baseline = baselineFound
    ? runMetrics(baselineFound.run.summary, baselineFound.run.events)
    : undefined;
  const limits = {
    ...(flags.has("max-calls") ? { maxCalls: Number(flags.get("max-calls")) } : {}),
    ...(flags.has("max-cost") ? { maxCost: Number(flags.get("max-cost")) } : {}),
    ...(flags.has("max-tokens") ? { maxTokens: Number(flags.get("max-tokens")) } : {}),
    ...(flags.has("max-context") ? { maxContextTokens: Number(flags.get("max-context")) } : {}),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) fail(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} needs a non-negative number`);
  }
  const failures = exceededLimits(metrics, limits);
  const delta = baseline
    ? {
        calls: metrics.modelCalls - baseline.modelCalls,
        toolCalls: metrics.toolCalls - baseline.toolCalls,
        tokens: metrics.totalTokens - baseline.totalTokens,
        cost: metrics.costActual - baseline.costActual,
        peakContext: metrics.peakContextTokens - baseline.peakContextTokens,
        wallMs: metrics.wallMs - baseline.wallMs,
      }
    : undefined;

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ metrics, baseline, delta, limits, failures }, null, 2)}\n`);
    return failures.length > 0 ? 1 : 0;
  }

  process.stdout.write(
    `${metrics.id}  ${metrics.agent}  ${metrics.status}${metrics.stopReason && metrics.stopReason !== "completed" ? ` (${metrics.stopReason})` : ""}  ${metrics.model ?? "(model unknown)"}\n`,
  );
  process.stdout.write(
    `  calls   ${metrics.modelCalls} model · ${metrics.toolCalls} tool · ` +
      Object.entries(metrics.toolCallsByTool).sort((a, b) => b[1] - a[1]).map(([tool, count]) => `${tool} ${count}`).join(" · ") + "\n",
  );
  process.stdout.write(
    `  tokens  ${fmtRunTokens(metrics.totalTokens)} total · ${fmtRunTokens(metrics.inputTokens)} in · ` +
      `${fmtRunTokens(metrics.cacheReadTokens)} cache · ${fmtRunTokens(metrics.outputTokens)} out\n`,
  );
  process.stdout.write(`  cost    ${fmtMoney(metrics.costActual)} actual · ${fmtMoney(metrics.costEstimated)} estimated\n`);
  process.stdout.write(
    `  context ${fmtRunTokens(metrics.peakContextTokens)} peak\n`,
  );
  process.stdout.write(`  time    ${Math.round(metrics.wallMs / 1000)}s · changes ${metrics.changedPaths.length} · gates ${metrics.gates ? (metrics.gates.passed ? "pass" : `fail (${metrics.gates.failed.join(", ")})`) : "not run"}\n`);
  if (metrics.loopReason) process.stdout.write(`  loop    ${metrics.loopReason}\n`);
  if (baseline && delta) {
    const sign = (value: number): string => (value > 0 ? `+${value}` : String(value));
    process.stdout.write(
      `  vs ${baseline.id}: calls ${sign(delta.calls)} · tool ${sign(delta.toolCalls)} · ` +
        `tokens ${sign(delta.tokens)} · cost ${sign(Number(delta.cost.toFixed(4)))} · ` +
        `peak ctx ${sign(delta.peakContext)} · time ${sign(Math.round(delta.wallMs / 1000))}s\n`,
    );
  }
  if (failures.length > 0) {
    process.stdout.write(`  FAIL ${failures.join("; ")}\n`);
    return 1;
  }
  if (Object.keys(limits).length > 0) process.stdout.write(`  PASS limits\n`);
  return 0;
}


export async function cmdPack(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const l = layout();
  const { machine, policy, models, catalogue: catalogueDoc, configuredProviders } = await loadRuntime(l);
  const agent = flags.get("agent") ?? "build";
  const agentPolicy = policy.agents[agent];
  if (!agentPolicy) fail(`unknown agent "${agent}"; choose one of ${Object.keys(policy.agents).join(", ")}`);

  let include: import("../context/assemble.js").ContextInclude | undefined;
  const includeFlag = flags.get("context-include");
  if (includeFlag !== undefined) {
    try {
      const raw = JSON.parse(includeFlag) as { files?: unknown; knowledge?: unknown; references?: unknown };
      const strings = (value: unknown): string[] | undefined =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : undefined;
      include = { files: strings(raw.files), knowledge: strings(raw.knowledge), references: strings(raw.references) };
    } catch {
      fail("--context-include must be a JSON object");
    }
  }
  let row = flags.get("model")
    ? catalogueDoc.models.find((entry) => entry.key === flags.get("model") || entry.id === flags.get("model") || `${entry.providerID}/${entry.id}` === flags.get("model"))
    : undefined;
  if (flags.get("model") && !row) fail(`no catalogue row for model "${flags.get("model")}"`);
  const estimatedChars = 16_000;
  if (!row) {
    const result = pick({
      agent,
      policy: agentPolicy,
      machine,
      catalogue: catalogueDoc.models,
      configuredProviders,
      availability: loadAvailability(l.home),
      fundedProviders: fundedProviderIds(machine.providers),
      contextChars: estimatedChars,
    });
    if ("error" in result) fail(result.error);
    row = result.selected;
  }

  const { assembleContext } = await import("../context/assemble.js");
  const { contextBudget, inputCost } = await import("../context/budget.js");
  const { roleSkillPresets } = await import("../agents.js");
  const budget = contextBudget(row.context || row.capabilities.contextWindow, agentPolicy.expectedOutputTokens);
  const bundle = await assembleContext({
    layout: l,
    machine,
    agent,
    ...(include ? { include } : {}),
    budgetChars: budget.inputChars,
    defaultSkills: defaultSkillsFor({ agent, verification: "verified" }),
    skillPresets: roleSkillPresets(agent),
  });
  const tokens = Math.ceil(bundle.chars / 4);
  const cost = inputCost(tokens, row.pricing.input);

  if (flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify({
        agent,
        model: row.key,
        contextWindow: row.context,
        inputBudgetTokens: budget.inputTokens,
        context: {
          chars: bundle.chars,
          tokens,
          sources: bundle.sources,
          warnings: bundle.warnings,
        },
        estimatedInputCost: cost,
      }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(`context ${row.key}  agent ${agent}  window ${fmtCtx(row.context)}  input budget ${fmtTokens(budget.inputTokens)} tok\n`);
  process.stdout.write(
    `  chars ${bundle.chars.toLocaleString()} (~${fmtTokens(tokens)} tok)  ` +
      `sources ${bundle.sources.length}  est input ${fmtMoney(cost)}\n`,
  );
  for (const source of bundle.sources.slice(0, flags.has("context") ? bundle.sources.length : 12)) {
    process.stdout.write(
      `  ${source.kind.padEnd(10)} ${String(source.bytes).padStart(7)}b ${source.origin.padEnd(9)} ${source.ref}` +
        `${source.truncated ? " [truncated]" : ""}${source.warning ? ` (${source.warning})` : ""}\n`,
    );
  }
  if (!flags.has("context") && bundle.sources.length > 12) {
    process.stdout.write(`  … ${bundle.sources.length - 12} more source(s) (--context)\n`);
  }
  for (const warning of bundle.warnings) process.stdout.write(`  warning: ${warning}\n`);
  return 0;
}

export function cmdContext(argv: string[]): number {
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (!id) fail("context needs a run id");
  const found = findRunAnywhere(layout().home, id);
  if (!found) fail(`no such run: ${id}`);
  const manifest = readContextManifest(join(found.layout.runsDir, found.run.summary.id));
  if (!manifest) {
    process.stdout.write("no context manifest recorded for this run\n");
  } else {
    process.stdout.write(`context ${manifest.chars.toLocaleString()} chars  ${manifest.sources.length} source(s)\n`);
    for (const source of manifest.sources) {
      process.stdout.write(
        `  ${source.kind.padEnd(10)} ${String(source.bytes).padStart(7)}b ${source.origin.padEnd(9)} ${source.ref}${source.truncated ? " [truncated]" : ""}${source.warning ? ` (${source.warning})` : ""}\n`,
      );
    }
    for (const warning of manifest.warnings) process.stdout.write(`  warning: ${warning}\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ spend */

export function printSpendBucket(label: string, bucket: SpendBucket): void {
  const perMillion = bucket.tokens > 0 ? bucket.actual / (bucket.tokens / 1_000_000) : 0;
  process.stdout.write(
    `  ${cell(label, 42)} ${String(bucket.calls).padStart(5)} calls  ${fmtTokens(bucket.tokens).padStart(7)} tok  ${fmtTokens(bucket.freeTokens).padStart(7)} free  ${fmtMoney(bucket.actual)}  ${perMillion > 0 ? `${fmtMoney(perMillion)}/Mtok` : ""}\n`,
  );
}

export function cmdSpend(argv: string[]): number {
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


export function cmdPrompts(argv: string[]): number {
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

