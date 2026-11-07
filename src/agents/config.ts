/**
 * machine_code — agent configuration: presets, explicit overrides, ambiguity.
 *
 * Four separate axes (never conflated):
 *   role        — identity: research | planner | build | review
 *   config      — behavior: delegate / verification / worktree / ask / approval
 *   mode        — legacy orchestration mode declared by a role
 *   ambiguity   — clarification policy; independent of everything above
 *
 * Enforcement lives in the harness (capability filtering, tool gating), not in
 * prompts. Prompts only explain the policy.
 */
import type { AgentConfigOverrides, AgentPolicy, MachineConfig, Policy } from "../config.js";
import {
  AGENT_NAMES,
  agentDef,
  presetData,
  rolePreset,
  type AgentDef,
  type AgentName,
} from "../agents.js";
import type { Layout } from "../paths.js";
import type { CoreToolName } from "../tools/index.js";
import { capabilitiesFor, type Capability } from "../policy/capabilities.js";

export type Verification = "direct" | "verified";
export type ApprovalMode = "human" | "agent";
export type AmbiguityMode = "strict" | "precise" | "adaptive" | "autonomous";
export type PresetName = string;

export interface AgentConfig {
  preset: PresetName;
  delegate: boolean;
  verification: Verification;
  worktree: boolean;
  artifactScripts: boolean;
  ask: boolean;
  approval: ApprovalMode;
  ambiguity: AmbiguityMode;
}

const VERIFICATIONS: readonly Verification[] = ["direct", "verified"];
const AMBIGUITIES: readonly AmbiguityMode[] = ["strict", "precise", "adaptive", "autonomous"];

function presetFromData(name: string, raw: Record<string, unknown>): AgentConfig {
  return {
    preset: name,
    delegate: raw.delegate === true,
    verification: pick(raw.verification, VERIFICATIONS) ?? "direct",
    worktree: raw.worktree !== false,
    artifactScripts: raw.artifact_scripts === true,
    ask: raw.ask !== false,
    approval: raw.approval === "agent" ? "agent" : "human",
    ambiguity: (AMBIGUITIES as readonly string[]).includes(String(raw.ambiguity))
      ? (raw.ambiguity as AmbiguityMode)
      : "precise",
  };
}

/** Behavior presets from data/presets.toml. */
export const PRESETS: Record<string, AgentConfig> = Object.fromEntries(
  Object.entries(presetData()).map(([name, raw]) => [name, presetFromData(name, raw)]),
);

/** Role default presets from data/agents/<role>.toml. */
export const ROLE_PRESET: Record<string, PresetName> = Object.fromEntries(
  AGENT_NAMES.map((name) => [name, rolePreset(name)]),
);

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  // Legacy "redundant" verification narrows to "verified".
  const normalized =
    value === "redundant" && (allowed as readonly string[]).includes("verified") ? "verified" : value;
  return typeof normalized === "string" && (allowed as readonly string[]).includes(normalized)
    ? (normalized as T)
    : undefined;
}

export interface ResolveInput {
  role: AgentName;
  /** Repo policy [agents.<role>] (may carry both token policy and config). */
  agentPolicy?: AgentPolicy;
  /** Machine config [agents.<role>] overrides. */
  machineOverrides?: AgentConfigOverrides;
  /** Run-level explicit overrides (CLI flags). */
  runOverrides?: Partial<AgentConfig>;
}

/**
 * Precedence: run flag → repo policy → machine config → preset → built-in.
 * Orchestration mode is not a behavior override; it is selected separately
 * from the role's `modes` list and drives the coordinator/subagent chain.
 */
export function resolveAgentConfig(input: ResolveInput): AgentConfig {
  const presetName = pickPreset(input);
  const base = PRESETS[presetName] ?? PRESETS.assistant ?? {
    preset: "assistant",
    delegate: false,
    verification: "direct",
    worktree: true,
    artifactScripts: false,
    ask: true,
    approval: "human",
    ambiguity: "precise",
  };
  const config: AgentConfig = { ...base };

  const layers: Array<AgentConfigOverrides | undefined> = [
    machineOverridesToConfig(input.machineOverrides),
    agentPolicyToConfig(input.agentPolicy),
  ];
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.delegate !== undefined) config.delegate = layer.delegate;
    const v = pick(layer.verification, VERIFICATIONS);
    if (v) config.verification = v;
    if (layer.worktree !== undefined) config.worktree = layer.worktree;
    if (layer.artifactScripts !== undefined) config.artifactScripts = layer.artifactScripts;
    if (layer.ask !== undefined) config.ask = layer.ask;
    if (layer.approval === "human" || layer.approval === "agent") config.approval = layer.approval;
    const a = pick(layer.ambiguity, AMBIGUITIES);
    if (a) config.ambiguity = a;
  }

  // Run-level overrides win over everything.
  if (input.runOverrides) {
    if (input.runOverrides.delegate !== undefined) config.delegate = input.runOverrides.delegate;
    const rv = pick(input.runOverrides.verification, VERIFICATIONS);
    if (rv) config.verification = rv;
    if (input.runOverrides.worktree !== undefined) config.worktree = input.runOverrides.worktree;
    if (input.runOverrides.artifactScripts !== undefined) config.artifactScripts = input.runOverrides.artifactScripts;
    if (input.runOverrides.ask !== undefined) config.ask = input.runOverrides.ask;
    if (input.runOverrides.approval !== undefined) config.approval = input.runOverrides.approval;
    if (input.runOverrides.ambiguity !== undefined) config.ambiguity = input.runOverrides.ambiguity;
  }
  return config;
}

function pickPreset(input: ResolveInput): PresetName {
  // Presets no longer steer resolution; the role default always wins.
  return ROLE_PRESET[input.role] ?? "assistant";
}

function agentPolicyToConfig(policy: AgentPolicy | undefined): AgentConfigOverrides | undefined {
  if (!policy) return undefined;
  const out: AgentConfigOverrides = {};
  if (policy.preset !== undefined) out.preset = policy.preset;
  if (policy.delegate !== undefined) out.delegate = policy.delegate;
  if (policy.verification !== undefined) out.verification = policy.verification;
  if (policy.artifactScripts !== undefined) out.artifactScripts = policy.artifactScripts;
  if (policy.ask !== undefined) out.ask = policy.ask;
  if (policy.approval !== undefined) out.approval = policy.approval;
  if (policy.ambiguity !== undefined) out.ambiguity = policy.ambiguity;
  if (policy.worktree !== undefined) out.worktree = policy.worktree;
  const hasAny = Object.values(out).some((v) => v !== undefined);
  return hasAny ? out : undefined;
}

function machineOverridesToConfig(o: AgentConfigOverrides | undefined): AgentConfigOverrides | undefined {
  if (!o) return undefined;
  const hasAny = Object.values(o).some((v) => v !== undefined);
  return hasAny ? { ...o } : undefined;
}

/* ------------------------------------------------------------ ambiguity */

const AMBIGUITY_PROMPTS: Record<AmbiguityMode, string> = {
  strict:
    "Ambiguity policy STRICT: read literally. Ask until every relevant ambiguity is resolved. Do not expand scope.",
  precise:
    "Ambiguity policy PRECISE: resolve low-impact gaps. Ask when a choice materially affects the work.",
  adaptive:
    "Ambiguity policy ADAPTIVE: use context and conventions. Ask on material risk; otherwise decide.",
  autonomous:
    "Ambiguity policy AUTONOMOUS: infer intent. Do not ask. If blocked, stop and report.",
};

const AMBIGUITY_PROMPTS_NO_ASK: Record<AmbiguityMode, string> = {
  strict:
    "Ambiguity policy STRICT: read literally. If a relevant ambiguity blocks the work, stop and report it. Do not expand scope.",
  precise:
    "Ambiguity policy PRECISE: resolve low-impact gaps. If a choice materially affects the work, stop and report the question.",
  adaptive:
    "Ambiguity policy ADAPTIVE: use context and conventions. If a material risk remains, stop and report it.",
  autonomous:
    "Ambiguity policy AUTONOMOUS: infer intent. Do not ask. If blocked, stop and report.",
};

export function ambiguityPrompt(mode: AmbiguityMode, askAvailable = true): string {
  return askAvailable ? AMBIGUITY_PROMPTS[mode] : AMBIGUITY_PROMPTS_NO_ASK[mode];
}

/** `ask` is available in strict/precise/adaptive — never in autonomous. */
export function askEnabled(config: AgentConfig): boolean {
  return config.ambiguity !== "autonomous";
}

/* ------------------------------------------------------ prompt composition */

export function composePrompt(
  def: AgentDef,
  config: AgentConfig,
  tools: readonly CoreToolName[],
): string {
  const ask = askEnabled(config);
  return [
    def.prompt,
    "",
    `Config: worktree ${config.worktree ? "on" : "off"} · verification ${config.verification} · approval ${config.approval}.`,
    `Tools: ${tools.length > 0 ? tools.join(", ") : "(none)"}.`,
    ambiguityPrompt(config.ambiguity, ask),
  ].join("\n");
}

/** Resolved agent bundle for a run. */
export interface ResolvedAgent {
  def: AgentDef;
  config: AgentConfig;
  capabilities: string[];
  prompt: string;
}

/** Per-tool capability requirements (null = no capability beyond the base allowlist). */
const TOOL_CAPABILITY: Record<CoreToolName, Capability | null> = {
  read: "code:read",
  search: "code:read",
  write: "code:write",
  edit: "code:write",
  command: null,
  context: null,
  ask: null, // gated by askEnabled(config)
  artifact: "artifact:provision",
  skill: null, // read-only skill bodies; exclusions are enforced inside the tool
  pr: "pr:read", // per-action capabilities are checked inside the tool
};

/**
 * Resolve a role into a run-ready agent: preset/override config, capability
 * matrix, capability-gated tool list, and the composed prompt. This is the
 * single place run creation turns configuration into enforcement.
 */
export function resolveAgent(
  layout: Layout,
  role: AgentName,
  opts: {
    agentPolicy?: AgentPolicy;
    machineOverrides?: AgentConfigOverrides;
    runOverrides?: Partial<AgentConfig>;
  } = {},
): ResolvedAgent {
  const def = agentDef(layout, role);
  const config = resolveAgentConfig({
    role,
    agentPolicy: opts.agentPolicy,
    machineOverrides: opts.machineOverrides,
    runOverrides: opts.runOverrides,
  });
  const capabilities = capabilitiesFor(role, config);
  const capSet = new Set<string>(capabilities);
  let tools = def.tools.filter((t) => {
    if (t === "ask") return askEnabled(config);
    // `write` is shared: build writes code (code:write), research persists
    // findings to knowledge/plans (knowledge:write). The write tool itself
    // restricts non-edit roles to those paths.
    if (t === "write") return capSet.has("code:write") || capSet.has("knowledge:write");
    const needed = TOOL_CAPABILITY[t];
    if (needed && !capSet.has(needed)) return false;
    return true;
  });
  // Read-only roles never hold mutating file tools regardless of capabilities.
  if (def.readonly) tools = tools.filter((t) => t !== "write" && t !== "edit");
  const prompt = composePrompt(def, config, tools);
  return { def: { ...def, prompt, tools }, config, capabilities, prompt };
}
