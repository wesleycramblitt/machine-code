/**
 * machine_code — CLI packet workflow.
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
import { approveIssue, deleteIssue, planIssueWaves } from "../tasks/issue.js";
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
import { listIssues, findIssue, writeIssue, moveIssue, parseKind, legalStatus, ISSUE_KIND_LABELS, ISSUE_KINDS, ISSUE_STATUS_LABELS, statusesForKind, type IssueStatus } from "../plan/issues.js";
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

import { fail, parseFlags, loadRuntime, EXIT, type Runtime } from "./common.js";

export async function cmdApprove(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) fail("usage: machine_code approve <slug>");
  const l = layout();
  const slug = slugify(target);
  if (!findIssue(l, slug) && !readPacketFile(l, slug)) fail(`no issue or packet ${slug}`);
  await approveIssue(l, slug);
  process.stdout.write(`approved and merged ${slug}\n`);
  return 0;
}


export function cmdPlan(argv: string[]): number {
  const { flags } = parseFlags(argv);
  const l = layout();
  const issues = listIssues(l);
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
    return 0;
  }
  const lines: string[] = ["# Issues"];
  for (const kind of ISSUE_KINDS) {
    lines.push("", `## ${ISSUE_KIND_LABELS[kind]}`);
    for (const status of statusesForKind(kind)) {
      const group = issues.filter((issue) => issue.kind === kind && issue.status === status);
      if (group.length === 0) continue;
      lines.push(`### ${ISSUE_STATUS_LABELS[status]}`);
      for (const issue of group) lines.push(`- [ ] ${issue.slug} - ${issue.title}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}


/* -------------------------------------------------------------- issue */

/** Inspect and edit issue files: list, create, move, show, run. */
export async function cmdIssue(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const l = layout();
  const sub = positional[0];

  if (sub === "create" || sub === "new") {
    const kindArg = positional[1];
    const slugArg = positional[2];
    if (!kindArg || !slugArg) fail('usage: machine_code issue create <ideas|features|bugs> <slug> "<prompt>" [--priority low|medium|high] [--review none|agent|human] [--depends a,b] [--tags a,b] [--status <dir>]');
    const kind = parseKind(kindArg);
    if (!kind) fail(`unknown kind ${JSON.stringify(kindArg)}; use ideas|features|bugs`);
    const slug = slugify(slugArg);
    if (!slug) fail("issue slug becomes empty");
    if (findIssue(l, slug)) fail(`issue ${slug} already exists`);
    const statusFlag = flags.get("status");
    if (statusFlag && !legalStatus(kind, statusFlag)) fail(`invalid status ${JSON.stringify(statusFlag)} for ${kind}`);
    const reviewFlag = flags.get("review") ?? "none";
    if (!["none", "agent", "human"].includes(reviewFlag)) fail("--review must be none|agent|human");
    const issue = writeIssue(l, {
      kind,
      slug,
      prompt: positional.slice(3).join(" ").trim() || slug,
      ...(statusFlag ? { status: statusFlag as IssueStatus } : {}),
      ...(flags.get("priority") ? { priority: flags.get("priority") } : {}),
      ...(flags.get("depends") ? { depends: flags.get("depends")!.split(",").map((e) => slugify(e)) } : {}),
      ...(flags.get("tags") ? { tags: flags.get("tags")!.split(",").map((e) => e.trim()) } : {}),
      review: reviewFlag as "none" | "agent" | "human",
    });
    await commitPlanningFiles(l, `issues: add ${slug}`);
    process.stdout.write(`created ${issue.rel}\n`);
    return 0;
  }

  if (sub === "move") {
    const slug = positional[1];
    const to = positional[2];
    if (!slug || !to) fail("usage: machine_code issue move <slug> <status>");
    const cleaned = slugify(slug);
    const issue = findIssue(l, cleaned);
    if (!issue) fail(`no issue ${cleaned}`);
    if (!legalStatus(issue.kind, to)) fail(`invalid status ${JSON.stringify(to)} for ${issue.kind}`);
    const moved = moveIssue(l, cleaned, to as IssueStatus);
    await commitPlanningFiles(l, `issues: ${cleaned} → ${to}`);
    process.stdout.write(`moved ${cleaned} → ${moved?.rel ?? ""}\n`);
    return 0;
  }

  if (sub === "run") {
    const slug = positional[1];
    if (!slug) fail("usage: machine_code issue run <slug> [--agent research|engineer]");
    const cleaned = slugify(slug);
    const issue = findIssue(l, cleaned);
    if (!issue) fail(`no issue ${cleaned}`);
    const agent = flags.get("agent") ?? (issue.kind === "ideas" ? "research" : "engineer");
    const include = JSON.stringify({ files: [issue.rel] });
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "run", "--agent", agent, "--item", cleaned, "--context-include", include, issue.prompt],
      { stdio: "inherit" },
    );
    const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    return code;
  }

  if (sub === "list" || sub === "ls" || sub === undefined) {
    const issues = listIssues(l);
    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
      return 0;
    }
    if (issues.length === 0) {
      process.stdout.write('no issues (use `machine_code issue create ideas|features|bugs <slug> "<prompt>"`)\n');
      return 0;
    }
    for (const issue of issues) {
      process.stdout.write(`${issue.rel}\n  ${issue.title}\n`);
    }
    return 0;
  }

  const issue = findIssue(l, slugify(sub ?? ""));
  if (!issue) fail(`no issue ${sub} (run \`machine_code issue list\`)`);
  process.stdout.write(`${issue.rel}\npriority ${issue.priority} · review ${issue.review}\n\n${issue.prompt}\n`);
  return 0;
}

/* -------------------------------------------------------------- packet */

/** Inspect and edit packet files: list, create, set, show. */
export async function cmdPacket(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const l = layout();
  const sub = positional[0];

  if (sub === "create" || sub === "new") {
    const slugArg = positional[1];
    if (!slugArg) fail('usage: machine_code packet create <slug> "<deliverable>" [--heading Bugs|Features|Ideas] [--plan plans/tui.md]');
    const slug = slugify(slugArg);
    if (!slug) fail("packet slug becomes empty; use letters, digits, and hyphens");
    if (readPacketFile(l, slug)) fail(`packet ${slug} already exists`);
    const deliverable = flags.get("deliverable") ?? positional.slice(2).join(" ");
    const heading = flags.get("heading") ?? "Features";
    const planFile = flags.get("plan");
    const reviewFlag = flags.get("review") ?? "gates";
    if (!PACKET_REVIEWS.includes(reviewFlag as PacketReview)) fail(`--review must be ${PACKET_REVIEWS.join("|")}`);
    const packet: PacketFile = {
      slug,
      status: "todo",
      deps: [],
      blocked: "",
      review: reviewFlag as PacketReview,
      deliverable: deliverable ?? "",
      files: [],
      acceptance: [],
      verify: (flags.get("verify") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
    writePacketFile(l, packet);
    addIndexEntry(l, heading, slug, deliverable ?? slug, planFile ? { plan: planFile } : {});
    await commitPlanningFiles(l, `plans: add ${slug}`);
    process.stdout.write(`created packets/${slug}.md\n`);
    return 0;
  }

  if (sub === "set") {
    const slug = positional[1];
    if (!slug) fail('usage: machine_code packet set <slug> status=<todo|in-progress|blocked> [blocked="..."] [deps=a,b] [verify=a,b] [review=gates|agent|human]');
    const packet = readPacketFile(l, slug);
    if (!packet) fail(`no packet ${slug}`);
    let changed = false;
    for (const assignment of positional.slice(2)) {
      const eq = assignment.indexOf("=");
      const key = eq > 0 ? assignment.slice(0, eq) : assignment;
      const value = eq > 0 ? assignment.slice(eq + 1) : "";
      if (key === "status") {
        if (!PACKET_STATUSES.includes(value as PacketStatus)) {
          fail(`invalid status ${JSON.stringify(value)}; use one of ${PACKET_STATUSES.join(", ")}`);
        }
        packet.status = value as PacketStatus;
        changed = true;
      } else if (key === "blocked") {
        packet.blocked = value;
        changed = true;
      } else if (key === "deps") {
        packet.deps = value
          .split(",")
          .map((entry) => slugify(entry))
          .filter(isValidSlug);
        changed = true;
      } else if (key === "verify") {
        packet.verify = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        changed = true;
      } else if (key === "review") {
        if (!PACKET_REVIEWS.includes(value as PacketReview)) {
          fail(`invalid review ${JSON.stringify(value)}; use one of ${PACKET_REVIEWS.join(", ")}`);
        }
        packet.review = value as PacketReview;
        changed = true;
      } else {
        fail(`unknown packet field ${JSON.stringify(key)}; use status, blocked, deps, verify, or review`);
      }
    }
    if (!changed) fail("nothing to set; pass status=..., blocked=..., deps=..., verify=..., or review=...");
    writePacketFile(l, packet);
    await commitPlanningFiles(l, `plans: update ${slug}`);
    process.stdout.write(renderPacketFile(packet));
    return 0;
  }

  if (sub === "list" || sub === "ls" || sub === undefined) {
    const packets = listPacketFiles(l);
    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(packets, null, 2)}\n`);
      return 0;
    }
    if (packets.length === 0) {
      process.stdout.write('no packets in plans/ (use `machine_code packet create <slug> "..."`)\n');
      return 0;
    }
    for (const packet of packets) {
      const deps = packet.deps.length > 0 ? `  deps: ${packet.deps.join(", ")}` : "";
      const blocked = packet.blocked ? `  blocked: ${packet.blocked}` : "";
      const review = packet.review && packet.review !== "gates" ? `  review: ${packet.review}` : "";
      process.stdout.write(`${packet.slug}  [${packet.status}]${review}${deps}${blocked}\n  ${packet.deliverable || "(no deliverable)"}\n`);
    }
    return 0;
  }

  // Default: show the packet file's canonical text.
  const packet = readPacketFile(l, sub);
  if (!packet) fail(`no packet ${sub} (run \`machine_code packet list\`)`);
  process.stdout.write(renderPacketFile(packet));
  return 0;
}

/* ------------------------------------------------------------------ build */

/** Shared bounded build: packet → TaskPacket → isolated worktree → gates → commit. */

export async function runPacketBuild(l: ReturnType<typeof layout>, packetFile: PacketFile, flags: Map<string, string>): Promise<number> {
  const slug = packetFile.slug;
  const packet = {
    id: slug,
    goal: packetFile.deliverable.trim() || slug,
    context: [...packetFile.files],
    constraints: packetFile.acceptance.map((entry) => `- ${entry}`),
    acceptance: packetFile.verify.map((command) => ({ command })),
  };

  const runtime = await loadRuntime(l);
  const recorder = new RunRecorder(l, {
    agent: "engineer",
    mode: "verified",
    request: packet.goal,
    repoRoot: l.repoRoot,
    packetId: slug,
    phase: "engineer",
  });
  registerProject(l.home, l.repoRoot);

  if (packetFile.status === "todo") {
    packetFile.status = "in-progress";
    writePacketFile(l, packetFile);
  }
  recorder.event("packet_build_start", { slug });

  let toolRoot = l.repoRoot;
  try {
    const supervisor = new ProcessSupervisor({
      runId: recorder.id,
      runDir: recorder.dir,
      onEvent: (type, data) => recorder.event(type, data),
    });
    const spec = await createWorktree({ layout: l, runId: recorder.id, kind: "packet", slug, processes: supervisor });
    toolRoot = spec.path;
    recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
    recorder.event("worktree_created", { path: spec.path, branch: spec.branch, baseRef: spec.baseRef, baseBranch: spec.baseBranch });
  } catch (error) {
    if (error instanceof WorktreeError) {
      recorder.finalize("blocked", `${error.code}: ${error.message}`);
      return EXIT["blocked"];
    }
    throw error;
  }

  const result = await executePacket({
    models: runtime.models,
    catalogue: runtime.catalogue.models,
    configuredProviders: runtime.configuredProviders,
    availability: loadAvailability(l.home),
    layout: l,
    machine: runtime.machine,
    policy: runtime.policy,
    packet,
    verification: "verified",
    review: flags.has("no-review") ? false : packetFile.review === "agent" || flags.has("review"),
    request: packet.goal,
    root: l.repoRoot,
    toolRoot,
    home: l.home,
    recorder,
    ...(flags.get("model") ? { requireModel: flags.get("model") } : {}),
  });
  recorder.finalize(result.status, result.error, result.finalText);
  process.stdout.write(`build ${slug}: ${result.status}${result.error ? ` — ${result.error}` : ""}\n`);
  if (result.status === "completed") {
    process.stdout.write(`  commit ${result.commit ?? "(none)"}\n  next: machine_code approve ${slug}\n`);
  }
  return EXIT[result.status];
}

/**
 * Build a packet file (`build <slug>`), or plan-and-build a free-form goal
 * (`build "<goal>"`): the goal is self-scoped into a packet, then the build
 * agent localizes against the map, edits, and reports `Outcome:`.
 */
export async function cmdBuild(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const joined = positional.join(" ").trim();
  if (!joined) {
    fail('usage:\n  machine_code build <slug> [--review] [--model <key>]\n  machine_code build "<goal>"   (self-scopes: plans + builds in one run)');
  }
  const l = layout();

  // A single no-space slug builds that packet.
  if (positional.length === 1 && isValidSlug(positional[0]!)) {
    const slug = slugify(positional[0]!);
    const packetFile = readPacketFile(l, slug);
    if (!packetFile) fail(`no packet ${slug} — create one with \`machine_code packet create ${slug} "...\"\``);
    if (!isBuildable(packetFile)) {
      fail(`packet ${slug} is not buildable — needs a ## Deliverable and a ## Verify command (status=${packetFile.status})`);
    }
    return runPacketBuild(l, packetFile, flags);
  }

  // Free-form goal: scaffold a minimal packet, then build (self-scope).
  const slug = slugify(joined).slice(0, 40) || "task";
  let packetFile = readPacketFile(l, slug);
  if (!packetFile) {
    packetFile = { slug, status: "todo", deps: [], blocked: "", deliverable: joined, files: [], acceptance: [], verify: [] };
    writePacketFile(l, packetFile);
    addIndexEntry(l, "Features", slug, joined);
    process.stderr.write(`self-scoped as ${slug} → packets/${slug}.md\n`);
  }
  return runPacketBuild(l, packetFile, flags);
}

/* ------------------------------------------------------------------ batch */

/**
 * Build ready packets across isolated worktrees, honoring `deps` and a
 * `--max-parallel` cap. With `--auto-approve` it builds and merges wave by wave
 * so dependents build on their parents' merged work; without it, only the first
 * ready wave runs and the operator approves between waves.
 */
export async function cmdBatch(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const l = layout();
  const maxParallel = Math.max(1, Number(flags.get("max-parallel") ?? "2") || 2);
  const dryRun = flags.has("dry-run");
  const autoApprove = flags.has("auto-approve");

  const waves = planIssueWaves(l, maxParallel);
  if (waves.length === 0) {
    process.stdout.write("no ready packets\n");
    return 0;
  }
  if (dryRun) {
    for (let i = 0; i < waves.length; i++) process.stdout.write(`wave ${i + 1}: ${waves[i]!.join(", ")}\n`);
    return 0;
  }

  const runBuildChild = (slug: string): Promise<{ slug: string; code: number }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [process.argv[1]!, "build", slug], { stdio: "inherit" });
      child.on("error", () => resolve({ slug, code: 1 }));
      child.on("exit", (code) => resolve({ slug, code: code ?? 1 }));
    });

  if (!autoApprove) {
    const wave = waves[0] ?? [];
    process.stdout.write(`wave 1: ${wave.join(", ")}\n`);
    await Promise.all(wave.map(runBuildChild));
    process.stdout.write(`next: machine_code approve ${wave.join(" ")}  (or re-run with --auto-approve)\n`);
    return 0;
  }

  let guard = 0;
  while (guard++ < 1000) {
    const current = planIssueWaves(l, maxParallel);
    const wave = current[0] ?? [];
    if (wave.length === 0) break;
    process.stdout.write(`wave ${guard}: ${wave.join(", ")}\n`);
    const results = await Promise.all(wave.map(runBuildChild));
    for (const slug of wave) {
      const packet = readPacketFile(l, slug);
      if (packet?.review === "human") {
        process.stderr.write(`leaving ${slug} for a human merge (review=human)\n`);
        continue;
      }
      try {
        await approveIssue(l, slug);
      } catch {
        // Failed build stays live; its dependents wait for the next run.
      }
    }
    const failed = results.filter((result) => result.code !== 0).map((result) => result.slug);
    if (failed.length > 0) {
      process.stderr.write(`build failed: ${failed.join(", ")}\n`);
      break;
    }
  }
  return 0;
}

/* ----------------------------------------------------------------- delete */

/** Delete a packet and everything derived from it: file, index line, branch, worktree. */
export async function cmdDelete(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const slugArg = positional[0];
  if (!slugArg) fail("usage: machine_code delete <slug> [--force]");
  const l = layout();
  const slug = slugify(slugArg);
  if (!readPacketFile(l, slug)) fail(`no packet ${slug}`);
  await deleteIssue(l, slug, { force: flags.has("force") });
  process.stdout.write(`deleted ${slug}\n`);
  return 0;
}
