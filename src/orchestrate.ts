/**
 * machine_code — mode orchestration.
 *
 * An agent with no configured modes runs alone.
 * direct/verified/redundant → the selected orchestrator compiles a packet →
 * Build implements it → runner-owned acceptance gates → (redundant) Review
 * judges. Which modes exist, and the default, come from data/agents/*.toml.
 * Queued packets (input.packet) run Build → gates → Review directly.
 *
 * `runLoop` (M0) runs a single agent; this layer chains phases per mode.
 */
import { runLoop, type RunLoopInput, type RunLoopResult } from "./loop.js";
import { DEFAULT_AGENT_POLICY, type MachineConfig, type Policy, type AgentPolicy } from "./config.js";
import { type AgentDef, type AgentName } from "./agents.js";
import { resolveAgent, type AgentConfig, type Verification } from "./agents/config.js";
import { type MutableModels } from "./models.js";
import { type CatalogueRow } from "./catalogue/types.js";
import { RunRecorder, type RunStatus } from "./state/runs.js";
import { runCommand } from "./commands/registry.js";
import type { TaskPacket } from "./packet.js";
import { resolveGates, runGates } from "./verify.js";
import { allCommands } from "./commands/profiles.js";
import { loadAvailability } from "./availability.js";
import { commitWorktree } from "./worktree.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { inferReviewVerdict, parseBuildOutcome, parseReviewVerdict } from "./orchestrator/outcome.js";
import type { Layout } from "./paths.js";
import type { IssueRef } from "./issues/provider.js";

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
  /** Numeric issue the run is associated with (Phase 4 adds provider validation). */
  issueNumber?: number;
  issue?: IssueRef;
  orchestrationId?: string;
  orchestrationScope?: "project" | "epic" | "feature";
  scopeRef?: IssueRef;
  attempt?: number;
  planReview?: "agent" | "human";
  resultReview?: "agent" | "human";
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
  /** Skip the deterministic map index / semantic annotations up front. */
  skipMap?: boolean;
  skipSemantic?: boolean;
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
  reviewVerdict?: string;
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
  skipMap?: boolean;
  skipSemantic?: boolean;
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
    skipMap: input.skipMap,
    skipSemantic: input.skipSemantic,
    signal: input.signal,
  });
}

export function policyFor(layout: Layout, name: AgentName, policy: Policy): AgentPolicy {
  return policy.agents[name] ?? { ...DEFAULT_AGENT_POLICY, toolCall: name !== "general" };
}

export interface ExecutePacketInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  layout: Layout;
  machine: MachineConfig;
  policy: Policy;
  packet: TaskPacket;
  verification: Verification;
  /** Run Review as an independent read-only run after gates pass. */
  review: boolean;
  request: string;
  root: string;
  toolRoot?: string;
  issueNumber?: number;
  issue?: IssueRef;
  orchestrationId?: string;
  orchestrationScope?: "project" | "epic" | "feature";
  scopeRef?: IssueRef;
  attempt?: number;
  planReview?: "agent" | "human";
  resultReview?: "agent" | "human";
  home: string;
  recorder: RunRecorder;
  availability?: import("./availability.js").AvailabilityState;
  requireProvider?: string;
  requireModel?: string;
  agentOverrides?: Partial<AgentConfig>;
  contextText?: string;
  skipMap?: boolean;
  skipSemantic?: boolean;
  signal?: AbortSignal;
}

/**
 * Execute a frozen packet: Build → gates → independent Review → commit/PR.
 * This is the Orchestrator path; it never asks a model to plan the packet.
 */
export async function executePacket(input: ExecutePacketInput): Promise<OrchestrateResult> {
  const { layout, machine, policy, packet, recorder } = input;
  const root = input.root;
  const toolRoot = input.toolRoot ?? root;
  const commands = allCommands(layout);
  const availability = input.availability ?? loadAvailability(layout.home);
  const resolvedBuild = resolveAgent(layout, "build", {
    agentPolicy: policy.agents.build,
    machineOverrides: machine.agents.build,
    runOverrides: { ...input.agentOverrides, verification: input.verification },
  });
  recorder.recordConfig({ ...resolvedBuild.config, capabilities: resolvedBuild.capabilities });
  const buildPolicy = policyFor(layout, "build", policy);
  const buildRequest =
    `Implement this task packet exactly:\n\n${JSON.stringify(packet, null, 2)}\n\n` +
    "Acceptance commands must pass. If the packet is wrong or a gate cannot run, report blocked with evidence.";
  const buildResult = await singleAgentRun({
    models: input.models,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    agent: resolvedBuild.def,
    agentConfig: resolvedBuild.config,
    agentCapabilities: resolvedBuild.capabilities,
    policy: buildPolicy,
    fullPolicy: policy,
    layout,
    machine,
    request: buildRequest,
    root,
    toolRoot,
    home: layout.home,
    availability,
    recorder,
    commands,
    requireProvider: input.requireProvider,
    requireModel: input.requireModel,
    contextText: input.contextText,
    skipMap: input.skipMap,
    skipSemantic: input.skipSemantic,
    signal: input.signal,
  });
  if (buildResult.status === "failed" || buildResult.status === "interrupted") {
    return { status: buildResult.status, finalText: buildResult.finalText, error: buildResult.error, packet, runId: recorder.id };
  }
  const buildOutcome = parseBuildOutcome(buildResult.finalText);
  recorder.event("build_outcome", {
    outcome: buildOutcome ?? "completed",
    source: buildOutcome ? "label" : "fallback",
  });
  if (buildOutcome && buildOutcome !== "completed") {
    return {
      status: buildOutcome === "failed" ? "failed" : "blocked",
      finalText: buildResult.finalText,
      error: `build outcome: ${buildOutcome}`,
      packet,
      runId: recorder.id,
    };
  }

  const gates = resolveGates(packet);
  const gateProcesses = new ProcessSupervisor({
    runId: recorder.id,
    runDir: recorder.dir,
    onEvent: (type, data) => recorder.event(type, data),
  });
  const gateOutcome = await runGates(gates, { root: toolRoot, commands, processes: gateProcesses });
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
    return {
      status: "blocked",
      finalText: buildResult.finalText,
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
      `packet: ${packet.id}` +
      (input.issueNumber ? `\nissue: ${input.issueNumber}` : "");
    const committed = await commitWorktree({ path: toolRoot, message, processes: gateProcesses });
    if (committed.sha) {
      commit = committed.sha;
      recorder.patchSummary({ commit });
      recorder.event("commit_created", { sha: commit, branch: recorder.current.branch, packet: packet.id });
    }
  }

  let reviewVerdict: string | undefined;
  if (input.review) {
    const resolvedReview = resolveAgent(layout, "review", {
      agentPolicy: policy.agents.review,
      machineOverrides: machine.agents.review,
      runOverrides: input.agentOverrides,
    });
    const reviewPolicy = policyFor(layout, "review", policy);
    const reviewBase = recorder.current.baseBranch ?? recorder.current.baseRef;
    const diffResult = await runCommand(
      "core:diff",
      reviewBase ? { base: reviewBase } : {},
      { root: toolRoot, commands },
    );
    const reviewRequest =
      `Review this packet and the committed diff. Approve or reject with concrete evidence citing paths.\n\n` +
      `COMMIT: ${commit ?? "(no commit created)"}\n` +
      `BASE: ${reviewBase ?? "(unknown)"}\n\n` +
      `PACKET:\n${JSON.stringify(packet, null, 2)}\n\nDIFF:\n${diffResult.text}`;
    const reviewRecorder = new RunRecorder(layout, {
      agent: "review",
      mode: "",
      request: reviewRequest,
      repoRoot: layout.repoRoot,
      ...(input.issue ? { issue: input.issue } : {}),
      ...(input.orchestrationId ? { orchestrationId: input.orchestrationId } : {}),
      ...(input.orchestrationScope ? { orchestrationScope: input.orchestrationScope } : {}),
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      ...(input.issue ? { taskIssue: input.issue } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      phase: "review",
      ...(input.planReview ? { planReview: input.planReview } : {}),
      ...(input.resultReview ? { resultReview: input.resultReview } : {}),
    });
    reviewRecorder.patchSummary({
      worktree: toolRoot,
      worktreeOwnerRunId: recorder.id,
      ...(recorder.current.branch ? { branch: recorder.current.branch } : {}),
      ...(recorder.current.baseBranch ? { baseBranch: recorder.current.baseBranch } : {}),
      ...(commit ? { commit } : {}),
    });
    reviewRecorder.event("review_of", { runId: recorder.id, ...(commit ? { commit } : {}) });
    recorder.event("review_started", { runId: reviewRecorder.id, ...(commit ? { commit } : {}) });
    const reviewResult = await singleAgentRun({
      models: input.models,
      catalogue: input.catalogue,
      configuredProviders: input.configuredProviders,
      agent: resolvedReview.def,
      agentConfig: resolvedReview.config,
      agentCapabilities: resolvedReview.capabilities,
      policy: reviewPolicy,
      fullPolicy: policy,
      layout,
      machine,
      request: reviewRequest,
      root,
      toolRoot,
      home: layout.home,
      availability,
      recorder: reviewRecorder,
      commands,
      requireProvider: input.requireProvider,
      requireModel: input.requireModel,
      contextText: input.contextText,
      skipMap: input.skipMap,
      skipSemantic: input.skipSemantic,
      signal: input.signal,
    });
    reviewRecorder.finalize(reviewResult.status, reviewResult.error, reviewResult.finalText);
    if (reviewResult.status !== "completed") {
      recorder.event("review_finished", { runId: reviewRecorder.id, verdict: "failed" });
      return {
        status: reviewResult.status,
        finalText: reviewResult.finalText,
        error: reviewResult.error ?? "Review did not complete",
        packet,
        runId: recorder.id,
        ...(commit ? { commit } : {}),
      };
    }
    const labelledVerdict = parseReviewVerdict(reviewResult.finalText);
    const verdict = labelledVerdict ?? inferReviewVerdict(reviewResult.finalText);
    reviewVerdict = verdict;
    recorder.event("review_verdict", { verdict, source: labelledVerdict ? "label" : "fallback", runId: reviewRecorder.id });
    recorder.event("review_finished", { runId: reviewRecorder.id, verdict });
    if (verdict !== "approved") {
      return {
        status: verdict === "failed" ? "failed" : "blocked",
        finalText: reviewResult.finalText,
        error: `Review verdict: ${verdict}`,
        packet,
        runId: recorder.id,
        ...(commit ? { commit } : {}),
        reviewVerdict: verdict,
      };
    }
  }

  let mergeState: MergeState | undefined;
  let prNumber: number | undefined;
  let prUrl: string | undefined;
  let prState: "none" | "open" | "merged" | "closed" | undefined;
  if (toolRoot !== root) {
    const { maybePublish } = await import("./pr/publish.js");
    const published = await maybePublish({
      layout,
      machine,
      recorder,
      defaultApproval: resolvedBuild.config.approval,
      ...(input.resultReview === "human" || input.review === false
        ? { approvalOverride: "human" as const }
        : {}),
      title: `Task: ${packet.goal}`,
    });
    if (published.status === "failed") {
      return {
        status: "blocked",
        finalText: buildResult.finalText,
        error: published.error ?? "Task PR publish failed",
        packet,
        runId: recorder.id,
        ...(commit ? { commit } : {}),
        ...(reviewVerdict ? { reviewVerdict } : {}),
        mergeState: "failed",
      };
    }
    mergeState =
      published.status === "merged"
        ? "merged"
        : published.status === "awaiting_approval"
          ? "awaiting_approval"
          : "skipped";
    prNumber = published.pr?.number;
    prUrl = published.pr?.url;
    prState =
      published.status === "merged"
        ? "merged"
        : published.status === "awaiting_approval"
          ? "open"
          : undefined;
  }

  return {
    status: "completed",
    finalText: buildResult.finalText,
    packet,
    runId: recorder.id,
    ...(commit ? { commit } : {}),
    ...(reviewVerdict ? { reviewVerdict } : {}),
    ...(mergeState ? { mergeState } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(prState ? { prState } : {}),
  };
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { layout, machine, policy, root, recorder } = input;
  if (input.packet) {
    const verification: Verification =
      input.packet.mode === "direct" || input.packet.mode === "redundant" ? input.packet.mode : "verified";
    return executePacket({
      models: input.models,
      catalogue: input.catalogue,
      configuredProviders: input.configuredProviders,
      layout,
      machine,
      policy,
      packet: input.packet,
      verification,
      review: true,
      request: input.packet.goal,
      root,
      toolRoot: input.toolRoot,
      issueNumber: input.issueNumber,
      home: layout.home,
      recorder,
      availability: input.availability,
      requireProvider: input.requireProvider,
      requireModel: input.requireModel,
      agentOverrides: input.agentOverrides,
      contextText: input.contextText,
      skipMap: input.skipMap,
      skipSemantic: input.skipSemantic,
      signal: input.signal,
    });
  }

  const selectedName = input.agentName ?? "general";
  const resolved = resolveAgent(layout, selectedName, {
    agentPolicy: policy.agents[selectedName],
    machineOverrides: machine.agents[selectedName],
    runOverrides: input.agentOverrides,
  });
  recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });

  if (resolved.config.issues === "required") {
    const { createIssueProvider } = await import("./issues/index.js");
    const bundle = await createIssueProvider(layout, machine);
    if (bundle.provider.kind === "none") {
      return {
        status: "blocked",
        finalText: "",
        error: `issue tracking is required but unavailable: ${bundle.reason ?? "unknown reason"}`,
        runId: recorder.id,
      };
    }
  }

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
    contextText: input.contextText,
    skipMap: input.skipMap,
    skipSemantic: input.skipSemantic,
    signal: input.signal,
  });
  return { ...result, runId: recorder.id };
}

export type { TaskPacket };
