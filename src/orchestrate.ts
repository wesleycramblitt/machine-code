/**
 * machine_code — single-agent run wrapper.
 *
 * Orchestration has been removed. This file now only provides a thin wrapper
 * over `runLoop` for callers that need it. See `src/cli/run.ts` for the
 * primary run entry point.
 *
 * TODO: Replace with a repo-level issue runner that processes all available
 * issues with consistent settings (agent, model, tier, etc.) instead of the
 * old multi-phase orchestration pipeline.
 */
import { runLoop, type RunLoopResult } from "./loop.js";
import type { AgentDef, AgentName } from "./agents.js";
import type { AgentConfig } from "./agents/config.js";
import type { MutableModels } from "./models.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { Layout } from "./paths.js";
import type { MachineConfig } from "./config.js";
import type { RunRecorder } from "./state/runs.js";

export async function singleAgentRun(input: {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  agent: AgentDef;
  agentConfig?: AgentConfig;
  agentCapabilities?: string[];
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
  seedFiles?: string[];
  skipMap?: boolean;
  signal?: AbortSignal;
  gates?: import("./verify.js").GateSpec[];
  initialMessages?: import("@earendil-works/pi-agent-core").AgentMessage[];
  startMode?: "prompt" | "continue";
}): Promise<RunLoopResult> {
  return runLoop({
    models: input.models,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    agent: input.agent,
    agentConfig: input.agentConfig,
    agentCapabilities: input.agentCapabilities,
    layout: input.layout,
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
    ...(input.gates ? { gates: input.gates } : {}),
    ...(input.initialMessages ? { initialMessages: input.initialMessages, startMode: input.startMode ?? "continue" } : {}),
  });
}
