/**
 * machine_code — mode orchestration.
 *
 * An agent with no configured modes runs alone.
 * direct/verified/redundant → the selected orchestrator compiles an issue →
 * Build implements it → runner-owned acceptance gates → (redundant) Review
 * judges. Which modes exist, and the default, come from data/agents/*.toml.
 * Queued issues (input.packet) run Engineer → gates → Review directly.
 *
 * `runLoop` (M0) runs a single agent; this layer chains phases per mode.
 */
import { runLoop, type RunLoopInput, type RunLoopResult } from "./loop.js";
import { DEFAULT_AGENT_POLICY, type MachineConfig, type Policy, type AgentPolicy } from "./config.js";
import { type AgentDef, type AgentName } from "./agents.js";
import { resolveAgent, type AgentConfig } from "./agents/config.js";
import { type MutableModels } from "./models.js";
import { type CatalogueRow } from "./catalogue/types.js";
import { RunRecorder, type RunStatus } from "./state/runs.js";
import { runCommand } from "./commands/registry.js";
import type { TaskPacket } from "./packet.js";
import { gateFailureText, resolveGates, runGates } from "./verify.js";
import { allCommands } from "./commands/registry.js";
import { loadAvailability } from "./availability.js";
import { commitWorktree } from "./worktree.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { assembleContext, type ContextInclude } from "./context/assemble.js";
import { defaultSkillsFor } from "./context/references.js";
import { buildRepoMap } from "./map/deterministic.js";
import { enrichHints, renderHints, suggestHints, suggestionText, withKeywordTerms } from "./map/suggest.js";
import { roleSkillPresets } from "./agents.js";
import { writeJsonAtomic } from "./state/run-schema.js";
import { join } from "node:path";
import { parseBuildOutcome } from "./orchestrator/outcome.js";
import type { Layout } from "./paths.js";
import { appendIssueGateFailure, findIssue, gateFailureAttempts, moveIssue } from "./plan/issues.js";
import { commitPlanningFiles } from "./tasks/planning.js";

export interface OrchestrateInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  layout: Layout;
  machine: MachineConfig;
  policy: Policy;
  agentName: AgentName | undefined;
  request: string;
  /** Main repository root: run state, spend, instances. */
  root: string;
  /** Worktree root for tools/commands/gates when the run mutates code. */
  toolRoot?: string;
  home: string;
  recorder: RunRecorder;
  packet?: TaskPacket;
  availability?: import("./availability.js").AvailabilityState;
  requireProvider?: string;
  requireModel?: string;
  /** Run-level agent configuration overrides (CLI flags). */
  agentOverrides?: Partial<AgentConfig>;
  /** Assembled context block prepended to each phase's first prompt. */
  contextText?: string;
  /** Repo-relative files pinned into the working set before the first model call. */
  seedFiles?: string[];
  /** Rank + inline suggested files (default true). False skips suggestions; explicit includes still apply. */
  hints?: boolean;
  /** Skip the deterministic map up front. */
  skipMap?: boolean;
  signal?: AbortSignal;
}

export type MergeState = "merged" | "awaiting_approval" | "skipped" | "failed";

export interface OrchestrateResult {
  status: RunStatus;
  finalText: string;
  error?: string;
  packet?: TaskPacket;
  runId: string;
  commit?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: "none" | "open" | "merged" | "closed";
  mergeState?: MergeState;
}

export async function singleAgentRun(input: {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  agent: AgentDef;
  agentConfig?: AgentConfig;
  agentCapabilities?: string[];
  policy: AgentPolicy;
  fullPolicy: Policy;
  layout: Layout;
  machine: MachineConfig;
  request: string;
  root: string;
  toolRoot?: string;
  home: string;
  availability?: import("./availability.js").AvailabilityState;
  recorder: RunRecorder;
  commands: ReadonlyMap<string, import("./commands/registry.js").CommandSpec>;
  requireProvider?: string;
  requireModel?: string;
  contextText?: string;
  /** Repo-relative files pinned into the working set before the first model call. */
  seedFiles?: string[];
  skipMap?: boolean;
  signal?: AbortSignal;
}): Promise<RunLoopResult> {
  return runLoop({
    models: input.models,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    agent: input.agent,
    agentConfig: input.agentConfig,
    agentCapabilities: input.agentCapabilities,
    policy: input.policy,
    layout: input.layout,
    fullPolicy: input.fullPolicy,
    machine: input.machine,
    request: input.request,
    root: input.root,
    toolRoot: input.toolRoot,
    home: input.home,
    availability: input.availability,
    recorder: input.recorder,
    commands: input.commands,
    requireProvider: input.requireProvider,
    requireModel: input.requireModel,
    contextText: input.contextText,
    ...(input.seedFiles ? { seedFiles: input.seedFiles } : {}),
    skipMap: input.skipMap,
    signal: input.signal,
  });
}

export function policyFor(layout: Layout, name: AgentName, policy: Policy): AgentPolicy {
  return policy.agents[name] ?? { ...DEFAULT_AGENT_POLICY, toolCall: name !== "research" };
}

export interface ExecuteIssueInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  layout: Layout;
  machine: MachineConfig;
  policy: Policy;
  packet: TaskPacket;
  request: string;
  root: string;
  toolRoot?: string;
  home: string;
  recorder: RunRecorder;
  availability?: import("./availability.js").AvailabilityState;
  requireProvider?: string;
  requireModel?: string;
  agentOverrides?: Partial<AgentConfig>;
  contextText?: string;
  /** Extra context selected by the composer/builder (the issue file, usually). */
  include?: ContextInclude;
  /** Rank + inline suggested files (default true). False skips suggestions; explicit includes still apply. */
  hints?: boolean;
  skipMap?: boolean;
  signal?: AbortSignal;
  }

/**
 * Execute one issue: Engineer → gates → independent Review → commit. The
 * issue's prompt is the objective; acceptance comes from its verify list.
 * This is the deterministic path: Engineer → gates → Review → commit.
 */
export async function executeIssue(input: ExecuteIssueInput): Promise<OrchestrateResult> {
  const { layout, machine, policy, packet, recorder } = input;
  const root = input.root;
  const toolRoot = input.toolRoot ?? root;
  const modelCommands = allCommands(layout);
  const gateCommands = allCommands(layout, { scriptsRoot: toolRoot });
  const availability = input.availability ?? loadAvailability(layout.home);
  // The deterministic path must assemble the same inherited context as a
  // direct run: issues index, knowledge, skills, plus any explicit include.
  const verification = packet.verification ?? "direct";
  // Use the freshly built map directly: re-reading it from disk re-opens a
  // stale/null window between the build and the suggestion pass.
  const builtMap = await buildRepoMap(layout.repoRoot);
  const suggestionRequest = withKeywordTerms(suggestionText(packet.goal), packet.keywords);
  // Hints send structure (symbols + matched terms), not dumps: files under
  // 4KB inline whole through `files`, the rest travel as an outline block
  // the model pulls one symbol at a time.
  let suggested: string[] = [];
  let hintOutlines = "";
  let hintedSmall: string[] = [];
  if (input.hints !== false) {
    const hints = suggestHints({
      map: builtMap.map,
      request: suggestionRequest,
      repoRoot: layout.repoRoot,
      limit: 3,
    });
    suggested = hints.map((hint) => hint.path);
    hintedSmall = hints.filter((hint) => hint.small).map((hint) => hint.path);
    hintOutlines = renderHints(enrichHints(hints, layout.repoRoot));
  }
  // Determinism witness: files:[] with a non-empty map and request means the
  // ranker filtered everything; mapFiles:0 means no map. Never silently empty.
  recorder.event("suggestions", {
    files: suggested,
    requestChars: suggestionRequest.length,
    mapFiles: builtMap.map.files.length,
    ...(input.hints === false ? { skipped: "disabled" } : {}),
  });
  const include: ContextInclude | undefined =
    input.include || hintedSmall.length > 0
      ? {
          ...(input.include ?? {}),
          files: [...new Set([...(input.include?.files ?? []), ...hintedSmall])],
        }
      : undefined;
  const contextBundle = await assembleContext({
    layout,
    machine,
    agent: "engineer",
    verification,
    ...(include ? { include } : {}),
    defaultSkills: defaultSkillsFor({ agent: "engineer", verification }),
    skillPresets: roleSkillPresets("engineer"),
    // Verified issues ship tests: inline the full testing brief instead of
    // leaving it one on-demand pull away (models never pull it).
    ...(verification === "verified" ? { skillOverrides: { "verified-testing": "include" } } : {}),
  });
  if (contextBundle.text) {
    writeJsonAtomic(join(recorder.dir, "context.json"), {
      chars: contextBundle.chars,
      sources: contextBundle.sources,
      warnings: contextBundle.warnings,
      sections: contextBundle.sections,
    });
    recorder.event("context_assembled", {
      chars: contextBundle.chars,
      sources: contextBundle.sources,
      warnings: contextBundle.warnings,
    });
  }
  const contextText =
    [contextBundle.text, hintOutlines, input.contextText].filter((part): part is string => Boolean(part)).join("\n\n") ||
    undefined;
  const seedFiles = [
    ...packet.context,
    ...(input.include?.issues ?? []),
    ...contextBundle.sources
      .filter((source) => source.kind === "file" && typeof source.ref === "string")
      .map((source) => source.ref as string),
  ];
  const resolvedEngineer = resolveAgent(layout, "engineer", {
    agentPolicy: policy.agents.engineer,
    machineOverrides: machine.agents.engineer,
    runOverrides: input.agentOverrides,
    verification,
  });
  recorder.recordConfig({ ...resolvedEngineer.config, capabilities: resolvedEngineer.capabilities });
  const engineerPolicy = policyFor(layout, "engineer", policy);
  const buildRequest =
    `Implement this issue exactly:\n\n${JSON.stringify(packet, null, 2)}\n\n` +
    "Acceptance commands must pass. If the issue is wrong or a gate cannot run, report blocked with evidence.";
  const engineerResult = await singleAgentRun({
    models: input.models,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    agent: resolvedEngineer.def,
    agentConfig: resolvedEngineer.config,
    agentCapabilities: resolvedEngineer.capabilities,
    policy: engineerPolicy,
    fullPolicy: policy,
    layout,
    machine,
    request: buildRequest,
    root,
    toolRoot,
    home: layout.home,
    availability,
    recorder,
    commands: modelCommands,
    requireProvider: input.requireProvider,
    requireModel: input.requireModel,
    contextText,
    // The issue's context files land in the working set up front, so the
    // first prompt already carries the code the deliverable names.
    ...(seedFiles.length > 0 ? { seedFiles: [...new Set(seedFiles)] } : {}),
    skipMap: input.skipMap,
    signal: input.signal,
  });
  if (
    engineerResult.status === "failed" ||
    engineerResult.status === "blocked" ||
    engineerResult.status === "interrupted" ||
    engineerResult.status === "cancelled" ||
    engineerResult.status === "paused"
  ) {
    return { status: engineerResult.status, finalText: engineerResult.finalText, error: engineerResult.error, packet, runId: recorder.id };
  }
  const buildOutcome = parseBuildOutcome(engineerResult.finalText);
  recorder.event("build_outcome", {
    outcome: buildOutcome ?? "completed",
    source: buildOutcome ? "label" : "fallback",
  });
  if (buildOutcome && buildOutcome !== "completed") {
    return {
      status: buildOutcome === "failed" ? "failed" : "blocked",
      finalText: engineerResult.finalText,
      error: `build outcome: ${buildOutcome}`,
      packet,
      runId: recorder.id,
    };
  }

  const gates = resolveGates(packet, gateCommands);
  const gateProcesses = new ProcessSupervisor({
    runId: recorder.id,
    runDir: recorder.dir,
    onEvent: (type, data) => recorder.event(type, data),
  });
  const gateOutcome = await runGates(gates, { root: toolRoot, commands: gateCommands, processes: gateProcesses });
  recorder.event("gates", {
    packet: packet.id,
    passed: gateOutcome.passed,
    results: gateOutcome.results.map((result) => ({
      command: result.command,
      passed: result.passed,
      durationMs: result.durationMs,
    })),
  });
  if (!gateOutcome.passed) {
    const failedIssue = findIssue(layout, packet.id);
    if (failedIssue) {
      appendIssueGateFailure(
        failedIssue.path,
        gateFailureText(gateOutcome.results),
        gateFailureAttempts(failedIssue.body) + 1,
      );
    }
    moveIssue(layout, packet.id, "failed-gates");
    await commitPlanningFiles(layout, `issues: ${packet.id} failed-gates`);
    return {
      status: "blocked",
      finalText: engineerResult.finalText,
      error: `acceptance gates failed: ${gateOutcome.results.filter((result) => !result.passed).map((result) => result.command).join(", ")}`,
      packet,
      runId: recorder.id,
    };
  }

  let commit: string | undefined;
  if (toolRoot !== root) {
    const message =
      `mc(${packet.id}): ${packet.goal}\n\n` +
      `run: ${recorder.id}\n` +
      `issue: ${packet.id}`;
    const committed = await commitWorktree({ path: toolRoot, message, processes: gateProcesses });
    if (committed.sha) {
      commit = committed.sha;
      recorder.patchSummary({ commit });
      recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, packet: packet.id });
    }
  }

  // No PR step: the feature branch merges directly on human/agent approval
  // (feature approve). The run record keeps merge fields unset.
  const mergeState: MergeState | undefined = toolRoot !== root ? "skipped" : undefined;
  const prNumber: number | undefined = undefined;
  const prUrl: string | undefined = undefined;
  const prState: "none" | "open" | "merged" | "closed" | undefined = undefined;

  return {
    status: "completed",
    finalText: engineerResult.finalText,
    packet,
    runId: recorder.id,
    ...(commit ? { commit } : {}),
    ...(mergeState ? { mergeState } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(prState ? { prState } : {}),
  };
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { layout, machine, policy, root, recorder } = input;
  if (input.packet) {
    return executeIssue({
      models: input.models,
      catalogue: input.catalogue,
      configuredProviders: input.configuredProviders,
      layout,
      machine,
      policy,
      packet: input.packet,
      request: input.packet.goal,
      root,
      toolRoot: input.toolRoot,
      home: layout.home,
      recorder,
      availability: input.availability,
      requireProvider: input.requireProvider,
      requireModel: input.requireModel,
      agentOverrides: input.agentOverrides,
      contextText: input.contextText,
      ...(input.seedFiles ? { seedFiles: input.seedFiles } : {}),
      skipMap: input.skipMap,
      signal: input.signal,
    });
  }

  const selectedName = input.agentName ?? "research";
  // Research without a packet starts blind: run the same ranker + file
  // assembly as the engineer path so discovery starts from pinned files,
  // not fishing. (Review runs carry caller-built context and skip this.)
  let researchContextText = input.contextText;
  let researchSeedFiles = input.seedFiles;
  if (selectedName === "research" && input.hints !== false) {
    const researchMap = await buildRepoMap(layout.repoRoot);
    const researchRequest = suggestionText(input.request);
    const researchHints = suggestHints({
      map: researchMap.map,
      request: researchRequest,
      repoRoot: layout.repoRoot,
      limit: 5,
    });
    const researchSuggested = researchHints.map((hint) => hint.path);
    recorder.event("suggestions", {
      files: researchSuggested,
      requestChars: researchRequest.length,
      mapFiles: researchMap.map.files.length,
    });
    const researchSmall = researchHints.filter((hint) => hint.small).map((hint) => hint.path);
    const researchOutlines = renderHints(enrichHints(researchHints, layout.repoRoot));
    const researchFiles = [...new Set([...(input.seedFiles ?? []), ...researchSmall])];
    // Files the caller already pinned (and inlined) need no second copy:
    // assemble only the newly suggested ones, but pin the union.
    const alreadyInline = new Set(input.seedFiles ?? []);
    const freshFiles = researchFiles.filter((path) => !alreadyInline.has(path));
    const researchBundle = await assembleContext({
      layout,
      machine,
      agent: "research",
      verification: "direct",
      ...(freshFiles.length > 0 ? { include: { files: freshFiles } } : {}),
      defaultSkills: defaultSkillsFor({ agent: "research" }),
      skillPresets: roleSkillPresets("research"),
    });
    if (researchBundle.text) {
      writeJsonAtomic(join(recorder.dir, "context.json"), {
        chars: researchBundle.chars,
        sources: researchBundle.sources,
        warnings: researchBundle.warnings,
        sections: researchBundle.sections,
      });
      recorder.event("context_assembled", {
        chars: researchBundle.chars,
        sources: researchBundle.sources,
        warnings: researchBundle.warnings,
      });
    }
    researchContextText =
      [researchBundle.text, researchOutlines, input.contextText].filter((part): part is string => Boolean(part)).join("\n\n") ||
      undefined;
    const bundledFiles = researchBundle.sources
      .filter((source) => source.kind === "file" && typeof source.ref === "string")
      .map((source) => source.ref as string);
    const mergedSeeds = [...new Set([...(input.seedFiles ?? []), ...bundledFiles])];
    researchSeedFiles = mergedSeeds.length > 0 ? mergedSeeds : undefined;
  }
  const resolved = resolveAgent(layout, selectedName, {
    agentPolicy: policy.agents[selectedName],
    machineOverrides: machine.agents[selectedName],
    runOverrides: input.agentOverrides,
  });
  recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });

  const result = await singleAgentRun({
    models: input.models,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    agent: resolved.def,
    agentConfig: resolved.config,
    agentCapabilities: resolved.capabilities,
    policy: policyFor(layout, selectedName, policy),
    fullPolicy: policy,
    layout,
    machine,
    request: input.request,
    root,
    toolRoot: input.toolRoot,
    home: layout.home,
    availability: input.availability ?? loadAvailability(layout.home),
    recorder,
    commands: allCommands(layout),
    requireProvider: input.requireProvider,
    requireModel: input.requireModel,
    contextText: researchContextText,
    ...(researchSeedFiles ? { seedFiles: researchSeedFiles } : {}),
    skipMap: input.skipMap,
    signal: input.signal,
  });
  return { ...result, runId: recorder.id };
}

export type { TaskPacket };
