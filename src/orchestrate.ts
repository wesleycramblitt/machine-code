/**
 * machine_code — mode orchestration.
 *
 * solo → one General or Sudo invocation (M0).
 * direct/verified/redundant → Architect compiles a packet → Build implements
 * it → runner-owned acceptance gates → (redundant) Review judges.
 *
 * `runLoop` (M0) runs a single agent; this layer chains phases per mode.
 */
import { runLoop, type RunLoopInput, type RunLoopResult } from "./loop.js";
import { type MachineConfig, type Policy, type AgentPolicy } from "./config.js";
import { generalAgent, agentDef, type AgentDef, type AgentName } from "./agents.js";
import { type MutableModels } from "./models.js";
import { type CatalogueRow } from "./catalogue/types.js";
import { RunRecorder, type RunStatus } from "./state/runs.js";
import { runCommand } from "./commands/registry.js";
import { loadAvailability } from "./availability.js";
import { allCommands } from "./commands/profiles.js";
import { readPacket, type TaskPacket, type PacketMode, parseMode, newPacketId } from "./packet.js";
import { resolveGates, runGates } from "./verify.js";
import type { Layout } from "./paths.js";

export type RunMode = "solo" | "direct" | "verified" | "redundant";

export interface OrchestrateInput {
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  layout: Layout;
  machine: MachineConfig;
  policy: Policy;
  mode: RunMode;
  agentName: AgentName | undefined;
  request: string;
  root: string;
  home: string;
  recorder: RunRecorder;
  availability?: import("./availability.js").AvailabilityState;
  requireProvider?: string;
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
  policy: AgentPolicy;
  machine: MachineConfig;
  request: string;
  root: string;
  home: string;
  availability?: import("./availability.js").AvailabilityState;
  recorder: RunRecorder;
  commands: ReadonlyMap<string, import("./commands/registry.js").CommandSpec>;
  requireProvider?: string;
  signal?: AbortSignal;
}): Promise<RunLoopResult> {
  return runLoop({
    models: input.models,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    agent: input.agent,
    policy: input.policy,
    machine: input.machine,
    request: input.request,
    root: input.root,
    home: input.home,
    availability: input.availability,
    recorder: input.recorder,
    commands: input.commands,
    requireProvider: input.requireProvider,
    signal: input.signal,
  });
}

function policyFor(layout: Layout, name: AgentName, policy: Policy): AgentPolicy {
  return policy.agents[name] ?? {
    minContext: 32_000,
    expectedOutputTokens: 2_000,
    minCapability: 6,
    toolCall: name !== "general",
  };
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { layout, machine, policy, mode, request, root, recorder } = input;
  const agents = input.models;
  const commands = allCommands(layout);
  const home = layout.home;
  const availability = input.availability ?? loadAvailability(home);

  switch (mode) {
    case "solo": {
      const name = input.agentName ?? "general";
      if (name !== "general" && name !== "sudo") {
        return {
          status: "failed",
          finalText: "",
          error: `solo mode requires --agent general or --agent sudo`,
          runId: recorder.id,
        };
      }
      const def = agentDef(layout, name);
      const agentPolicy = policyFor(layout, name, policy);
      const result = await singleAgentRun({
        models: agents,
        catalogue: input.catalogue,
        configuredProviders: input.configuredProviders,
        agent: def,
        policy: agentPolicy,
        machine,
        request,
        root,
        home,
        availability,
        recorder,
        commands,
        requireProvider: input.requireProvider,
        signal: input.signal,
      });
      return { ...result, runId: recorder.id };
    }

    case "direct":
    case "verified":
    case "redundant": {
      // Phase 1: Architect compiles the packet.
      const architect = agentDef(layout, "architect");
      const archPolicy = policyFor(layout, "architect", policy);
      const archResult = await singleAgentRun({
        models: agents,
        catalogue: input.catalogue,
        configuredProviders: input.configuredProviders,
        agent: architect,
        policy: archPolicy,
        machine,
        request: `Compile a task packet for this request. Output ONLY the packet in YAML-frontmatter markdown.

Available commands (use EXACTLY these names; never invent one):
${[...commands.keys()].map((k) => `- ${k}`).join("\n")}

Format:
---
id: <${newPacketId(request)}>
mode: ${mode}
budget_tokens: ${machine.maxOutputTokens ?? 200000}
---

# Goal
<one line>

# Context
- <file paths>

# Constraints
- <constraints>

# Acceptance
- <command-name> [with key = value, ...]

${request}`,
        root,
        home,
        availability,
        recorder,
        commands,
        requireProvider: input.requireProvider,
        signal: input.signal,
      });
      if (archResult.status !== "done") {
        return {
          status: archResult.status,
          finalText: archResult.finalText,
          error: archResult.error ?? "Architect planning failed",
          runId: recorder.id,
        };
      }
      const packet = parsePacket(archResult.finalText, mode as PacketMode, newPacketId(request));
      recorder.event("packet_compiled", {
        id: packet.id,
        mode: packet.mode,
        acceptance: packet.acceptance.length,
      });

      // Phase 2: Build implements the packet.
      const build = agentDef(layout, "build");
      const buildPolicy = policyFor(layout, "build", policy);
      const buildRequest = `Implement this task packet exactly:\n\n${JSON.stringify(packet, null, 2)}\n\nAcceptance commands must pass. If the packet is wrong or a gate cannot run, report blocked with evidence.`;
      const buildResult = await singleAgentRun({
        models: agents,
        catalogue: input.catalogue,
        configuredProviders: input.configuredProviders,
        agent: build,
        policy: buildPolicy,
        machine,
        request: buildRequest,
        root,
        home,
        availability,
        recorder,
        commands,
        requireProvider: input.requireProvider,
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

      // Phase 3: runner-owned acceptance gates.
      const gates = resolveGates(packet);
      const gateOutcome = await runGates(gates, { root, commands });
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

      // Phase 4: Review (redundant only).
      if (mode === "redundant") {
        const review = agentDef(layout, "review");
        const reviewPolicy = policyFor(layout, "review", policy);
        const diffResult = await runCommand("core:diff", {}, { root });
        const reviewResult = await singleAgentRun({
          models: agents,
          catalogue: input.catalogue,
          configuredProviders: input.configuredProviders,
          agent: review,
          policy: reviewPolicy,
          machine,
          request: `Review this packet and the resulting diff. Approve or reject with concrete evidence citing paths.\n\nPACKET:\n${JSON.stringify(packet, null, 2)}\n\nDIFF:\n${diffResult.text}`,
          root,
          home,
          availability,
          recorder,
          commands,
          requireProvider: input.requireProvider,
          signal: input.signal,
        });
        if (reviewResult.status !== "done") {
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

      return {
        status: "done",
        finalText: buildResult.finalText,
        packet,
        runId: recorder.id,
      };
    }
  }
}

/** Parse "command-name with key = value, ..." into a typed acceptance entry. */
function parseAcceptance(item: string): { command: string; args: Record<string, unknown> } {
  // Strip backticks and leading/trailing punctuation.
  let cleaned = item.replace(/`/g, "").trim();
  const withMatch = cleaned.match(/^(.+?)\s+with\s+(.+)$/i);
  let command = cleaned;
  let argsStr = "";
  if (withMatch) {
    command = (withMatch[1] ?? "").trim();
    argsStr = (withMatch[2] ?? "").trim();
  }
  // command may be followed by args inline: "cmd key=value key2=value2"
  const parts = command.split(/\s+/);
  if (parts.length > 1) {
    // treat trailing "key=value" pairs as args too
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
  // Parse "key = value" or key=value pairs, values quoted or bare.
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
      else if (section === "acceptance") {
        const parsed = parseAcceptance(item);
        acceptance.push(parsed);
      } else if (section === "goal" && !goal) goal = item;
    } else if (section === "goal" && line && !goal) {
      goal = line;
    }
  }

  if (!goal) goal = text.slice(0, 200);
  return { id, mode, budget_tokens, goal, context, constraints, acceptance };
}

export type { TaskPacket };
