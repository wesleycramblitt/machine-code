/**
 * machine_code — mode orchestration.
 *
 * An agent with no configured modes runs alone.
 * direct/verified/redundant → the selected orchestrator compiles a packet →
 * Build implements it → runner-owned acceptance gates → (redundant) Review
 * judges. Which modes exist, and the default, come from data/agents/*.toml.
 * Queued packets (input.packet) skip Architect and use the packet verbatim.
 *
 * `runLoop` (M0) runs a single agent; this layer chains phases per mode.
 */
import { runLoop, type RunLoopInput, type RunLoopResult } from "./loop.js";
import { DEFAULT_AGENT_POLICY, type MachineConfig, type Policy, type AgentPolicy } from "./config.js";
import { generalAgent, agentDef, type AgentDef, type AgentName } from "./agents.js";
import { resolveAgent, type AgentConfig, type Verification } from "./agents/config.js";
import { type MutableModels } from "./models.js";
import { type CatalogueRow } from "./catalogue/types.js";
import { RunRecorder, type RunStatus } from "./state/runs.js";
import { runCommand } from "./commands/registry.js";
import { readPacket, writePacket, packetPath, type TaskPacket, type PacketMode, parseMode, newPacketId } from "./packet.js";
import { resolveGates, runGates } from "./verify.js";
import { allCommands } from "./commands/profiles.js";
import { loadAvailability } from "./availability.js";
import { commitWorktree } from "./worktree.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import type { Layout } from "./paths.js";

/** Run modes are strings from agent config, not a global TypeScript union. */
export type RunMode = string;

export interface OrchestrateInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  layout: Layout;
  machine: MachineConfig;
  policy: Policy;
  /** Omitted when the selected agent has no orchestration modes. */
  mode?: RunMode;
  agentName: AgentName | undefined;
  request: string;
  /** Main repository root: run state, spend, instances. */
  root: string;
  /** Worktree root for tools/commands/gates when the run mutates code. */
  toolRoot?: string;
  /** Numeric issue the run is associated with (Phase 4 adds provider validation). */
  issueNumber?: number;
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

export interface OrchestrateResult {
  status: RunStatus;
  finalText: string;
  error?: string;
  packet?: TaskPacket;
  runId: string;
}

async function singleAgentRun(input: {
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

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { layout, machine, policy, mode, request, root, recorder } = input;
  const toolRoot = input.toolRoot ?? root;
  const agents = input.models;
  const commands = allCommands(layout);
  const home = layout.home;
  const availability = input.availability ?? loadAvailability(home);

  // Issue-tracking policy gate: `required` fails before the first model call.
  let issueBundle: Awaited<ReturnType<typeof import("./issues/index.js").createIssueProvider>> | undefined;
  const issueGate = async (config: AgentConfig): Promise<string | null> => {
    if (config.issues !== "required") return null;
    if (!issueBundle) {
      const { createIssueProvider } = await import("./issues/index.js");
      issueBundle = await createIssueProvider(layout, machine);
    }
    if (issueBundle.provider.kind === "none") {
      return `issue tracking is required but unavailable: ${issueBundle.reason ?? "unknown reason"}`;
    }
    return null;
  };

  const selectedName = input.agentName ?? (mode ? "architect" : "general");
  const selectedDef = agentDef(layout, selectedName);
  const configuredMode = selectedDef.modes.length > 0
    ? mode ?? selectedDef.defaultMode ?? selectedDef.modes[0]
    : undefined;
  if (!configuredMode) {
    const name = selectedName;
    const resolved = resolveAgent(layout, name, {
      agentPolicy: policy.agents[name],
      machineOverrides: machine.agents[name],
      runOverrides: input.agentOverrides,
    });
    recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
    const gate = await issueGate(resolved.config);
    if (gate) return { status: "blocked", finalText: "", error: gate, runId: recorder.id };
    const agentPolicy = policyFor(layout, name, policy);
    const result = await singleAgentRun({
      models: agents,
      catalogue: input.catalogue,
      configuredProviders: input.configuredProviders,
      agent: resolved.def,
      agentConfig: resolved.config,
      agentCapabilities: resolved.capabilities,
      policy: agentPolicy,
      fullPolicy: policy,
      layout,
      machine,
      request,
      root,
      toolRoot,
      home,
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
    return { ...result, runId: recorder.id };
  }

  if (!selectedDef.modes.includes(configuredMode)) {
    return {
      status: "failed",
      finalText: "",
      error: `agent ${selectedName} does not offer mode "${configuredMode}" (available: ${selectedDef.modes.join(", ") || "none"})`,
      runId: recorder.id,
    };
  }

  const modeConfig = selectedDef.modeConfig[configuredMode];
  if (!modeConfig) {
    return {
      status: "failed",
      finalText: "",
      error: `mode "${configuredMode}" has no data configuration in agent ${selectedName}`,
      runId: recorder.id,
    };
  }
  const modeVerification: Verification =
    modeConfig.verification === "direct" || modeConfig.verification === "redundant" || modeConfig.verification === "verified"
      ? modeConfig.verification
      : "verified";

  {
      let packet: TaskPacket;
      if (input.packet) {
        packet = input.packet;
      } else {
        // The chain architect plans only (delegate=false): the RUNNER chains
        // to Build; the architect never spawns.
        const resolvedArch = resolveAgent(layout, selectedName, {
          agentPolicy: policy.agents[selectedName],
          machineOverrides: machine.agents[selectedName],
          runOverrides: { ...(input.agentOverrides ?? {}), delegate: false, preset: "plan" as const },
        });
        const archPolicy = policyFor(layout, selectedName, policy);
        const archResult = await singleAgentRun({
          models: agents,
          catalogue: input.catalogue,
          configuredProviders: input.configuredProviders,
          agent: resolvedArch.def,
          agentConfig: resolvedArch.config,
          agentCapabilities: resolvedArch.capabilities,
          policy: archPolicy,
          fullPolicy: policy,
          layout,
          machine,
          request: `Compile a task packet for this request. Output ONLY the packet in YAML-frontmatter markdown:\n\n---\nid: <${newPacketId(request)}>\nmode: ${configuredMode}\nbudget_tokens: ${machine.maxOutputTokens ?? 200000}\n---\n\n# Goal\n<one line>\n\n# Context\n- <file paths>\n\n# Constraints\n- <constraints>\n\n# Acceptance\n- <named command with typed args>\n\n${request}`,
          root,
          toolRoot,
          home,
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
        if (archResult.status !== "completed") {
          return {
            status: archResult.status,
            finalText: archResult.finalText,
            error: archResult.error ?? "Architect planning failed",
            runId: recorder.id,
          };
        }
        packet = parsePacket(archResult.finalText, configuredMode, newPacketId(request));
        recorder.event("packet_compiled", {
          id: packet.id,
          mode: packet.mode,
          acceptance: packet.acceptance.length,
        });
        // Runner-owned persistence: the compiled packet must exist on disk
        // before Build starts, not only inside the Architect's final text.
        const packetFile = writePacket(layout, packet);
        recorder.event("packet_persisted", { id: packet.id, path: packetFile });
      }

      const resolvedBuild = resolveAgent(layout, "build", {
        agentPolicy: policy.agents.build,
        machineOverrides: machine.agents.build,
        // The selected mode owns subagent verification; a generic --verify
      // override must not silently turn direct into verified.
      runOverrides: { ...input.agentOverrides, verification: modeVerification },
      });
      recorder.recordConfig({ ...resolvedBuild.config, capabilities: resolvedBuild.capabilities });
      const buildGate = await issueGate(resolvedBuild.config);
      if (buildGate) return { status: "blocked", finalText: "", error: buildGate, runId: recorder.id };
      const buildPolicy = policyFor(layout, "build", policy);
      const buildRequest = `Implement this task packet exactly:\n\n${JSON.stringify(packet, null, 2)}\n\nAcceptance commands must pass. If the packet is wrong or a gate cannot run, report blocked with evidence.`;
      const buildResult = await singleAgentRun({
        models: agents,
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
        home,
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
        return {
          status: buildResult.status,
          finalText: buildResult.finalText,
          error: buildResult.error,
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
        results: gateOutcome.results.map((r) => ({ command: r.command, passed: r.passed, durationMs: r.durationMs })),
      });
      if (!gateOutcome.passed) {
        return {
          status: "blocked",
          finalText: buildResult.finalText,
          error: `acceptance gates failed: ${gateOutcome.results.filter((r) => !r.passed).map((r) => r.command).join(", ")}`,
          packet,
          runId: recorder.id,
        };
      }

      if (modeConfig.review) {
        const resolvedReview = resolveAgent(layout, "review", {
          agentPolicy: policy.agents.review,
          machineOverrides: machine.agents.review,
          runOverrides: input.agentOverrides,
        });
        const reviewPolicy = policyFor(layout, "review", policy);
        const diffResult = await runCommand("core:diff", {}, { root: toolRoot, commands });
        const reviewResult = await singleAgentRun({
          models: agents,
          catalogue: input.catalogue,
          configuredProviders: input.configuredProviders,
          agent: resolvedReview.def,
          agentConfig: resolvedReview.config,
          agentCapabilities: resolvedReview.capabilities,
          policy: reviewPolicy,
          fullPolicy: policy,
          layout,
          machine,
          request: `Review this packet and the resulting diff. Approve or reject with concrete evidence citing paths.\n\nPACKET:\n${JSON.stringify(packet, null, 2)}\n\nDIFF:\n${diffResult.text}`,
          root,
          toolRoot,
          home,
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
        if (reviewResult.status !== "completed") {
          return {
            status: reviewResult.status,
            finalText: reviewResult.finalText,
            error: reviewResult.error ?? "Review did not complete",
            packet,
            runId: recorder.id,
          };
        }
        const approved = /approv/i.test(reviewResult.finalText) && !/reject/i.test(reviewResult.finalText);
        if (!approved) {
          return {
            status: "blocked",
            finalText: reviewResult.finalText,
            error: "Review agent rejected the work against the packet",
            packet,
            runId: recorder.id,
          };
        }
      }

      // Runner-owned commit: after gates and review pass, the worktree's
      // changes are committed to the run's branch.
      if (toolRoot !== root) {
        const message =
          `mc(${packet.id}): ${packet.goal}\n\n` +
          `run: ${recorder.id}\n` +
          `packet: ${packet.id}` +
          (input.issueNumber ? `\nissue: ${input.issueNumber}` : "");
        const { sha } = await commitWorktree({ path: toolRoot, message });
        if (sha) {
          recorder.patchSummary({ commit: sha });
          recorder.event("commit_created", { sha, branch: recorder.current.branch, packet: packet.id });
        }
        // Publish: push the branch and open the Task PR (Feature branch base).
        const { maybePublish } = await import("./pr/publish.js");
        await maybePublish({
          layout,
          machine,
          recorder,
          defaultApproval: resolvedBuild.config.approval,
          title: `Task: ${packet.goal}`,
        });
      }

      return {
        status: "completed",
        finalText: buildResult.finalText,
        packet,
        runId: recorder.id,
      };
    }
}

function parseAcceptance(item: string): { command: string; args: Record<string, unknown> } {
  let cleaned = item.replace(/`/g, "").trim();
  const withMatch = cleaned.match(/^(.+?)\s+with\s+(.+)$/i);
  let command = cleaned;
  let argsStr = "";
  if (withMatch) {
    command = (withMatch[1] ?? "").trim();
    argsStr = (withMatch[2] ?? "").trim();
  }
  const parts = command.split(/\s+/);
  if (parts.length > 1) {
    const cmdParts: string[] = [];
    const extra: string[] = [];
    for (const p of parts) {
      if (p.includes("=")) extra.push(p);
      else cmdParts.push(p);
    }
    command = cmdParts.join(" ");
    argsStr = [argsStr, ...extra].filter(Boolean).join(", ");
  }
  const args: Record<string, unknown> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsStr)) !== null) {
    const key = m[1]!;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    args[key] = value;
  }
  return { command, args };
}

function parsePacket(text: string, fallbackMode: PacketMode, fallbackId: string): TaskPacket {
  let id = fallbackId;
  let mode: PacketMode = fallbackMode;
  let budget_tokens: number | undefined;
  let goal = "";
  const context: string[] = [];
  const constraints: string[] = [];
  const acceptance: Array<{ command: string; args?: Record<string, unknown> }> = [];

  const front = text.match(/^---\n([\s\S]*?)\n---/);
  if (front) {
    for (const line of (front[1] ?? "").split("\n")) {
      const kv = line.split(/:(.+)/s);
      if (kv.length !== 2) continue;
      const k = (kv[0] ?? "").trim();
      const v = (kv[1] ?? "").trim();
      if (k === "id") id = v;
      else if (k === "mode") {
        const m = parseMode(v);
        if (m) mode = m;
      } else if (k === "budget_tokens") {
        const n = Number(v);
        budget_tokens = Number.isFinite(n) ? n : undefined;
      }
    }
    text = text.slice(front[0]!.length).trim();
  }

  let section: "goal" | "context" | "constraints" | "acceptance" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#\s+(.+)/);
    if (heading) {
      const h = heading[1]!.toLowerCase();
      if (h === "goal") section = "goal";
      else if (h === "context") section = "context";
      else if (h === "constraints") section = "constraints";
      else if (h === "acceptance") section = "acceptance";
      else section = null;
      continue;
    }
    if (!section) continue;
    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (section === "context") context.push(item);
      else if (section === "constraints") constraints.push(item);
      else if (section === "acceptance") acceptance.push(parseAcceptance(item));
      else if (section === "goal" && !goal) goal = item;
    } else if (section === "goal" && line && !goal) {
      goal = line;
    }
  }

  if (!goal) goal = text.slice(0, 200);
  return { id, mode, budget_tokens, goal, context, constraints, acceptance };
}

export type { TaskPacket };
