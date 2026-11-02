/**
 * machine_code — agent configuration: presets, explicit overrides, ambiguity.
 *
 * Four separate axes (never conflated):
 *   role        — identity: general | architect | build | review | sudo
 *   config      — behavior: delegate / verification / issues / ask / approval
 *   mode        — orchestration mode declared by the role (for example
 *                 architect: direct | verified | redundant); a role with no
 *                 modes runs alone, so there is no special "solo" value
 *   ambiguity   — clarification policy; independent of everything above
 *
 * Enforcement lives in the harness (capability filtering, tool gating), not in
 * prompts. Prompts only explain the policy.
 */
import type { AgentConfigOverrides, AgentPolicy, MachineConfig, Policy } from "../config.js";
import {
  AGENT_NAMES,
  agentDef,
  isIssueAccess,
  presetData,
  roleIssueAccess,
  rolePreset,
  type AgentDef,
  type AgentName,
  type IssueAccess,
} from "../agents.js";
import type { Layout } from "../paths.js";
import type { CoreToolName } from "../tools/index.js";
import { capabilitiesFor, type Capability } from "../policy/capabilities.js";

export type Verification = "direct" | "verified" | "redundant";
export type IssueTracking = "required" | "optional" | "disabled";
export type ApprovalMode = "human" | "agent";
export type AmbiguityMode = "strict" | "precise" | "adaptive" | "autonomous";
export type PresetName = string;

export interface AgentConfig {
  preset: PresetName;
  delegate: boolean;
  verification: Verification;
  issues: IssueTracking;
  /** Resolved by resolveAgentConfig; absent on raw presets. */
  issueAccess?: IssueAccess;
  ask: boolean;
  approval: ApprovalMode;
  ambiguity: AmbiguityMode;
}

const VERIFICATIONS: readonly Verification[] = ["direct", "verified", "redundant"];
const ISSUE_TRACKINGS: readonly IssueTracking[] = ["required", "optional", "disabled"];
const AMBIGUITIES: readonly AmbiguityMode[] = ["strict", "precise", "adaptive", "autonomous"];

function presetFromData(name: string, raw: Record<string, unknown>): AgentConfig {
  return {
    preset: name,
    delegate: raw.delegate === true,
    verification: (VERIFICATIONS as readonly string[]).includes(String(raw.verification))
      ? (raw.verification as Verification)
      : "direct",
    issues: (ISSUE_TRACKINGS as readonly string[]).includes(String(raw.issues))
      ? (raw.issues as IssueTracking)
      : "optional",
    ...(isIssueAccess(raw.issue_access) ? { issueAccess: raw.issue_access } : {}),
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

const PRESET_NAMES: readonly PresetName[] = Object.keys(PRESETS);

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
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
    issues: "disabled",
    issueAccess: "none",
    ask: true,
    approval: "human",
    ambiguity: "precise",
  };
  // The role file is the base for issue access. Behavior presets do not own it.
  const config: AgentConfig = { ...base, issueAccess: roleIssueAccess(input.role) };

  const layers: Array<AgentConfigOverrides | undefined> = [
    machineOverridesToConfig(input.machineOverrides),
    agentPolicyToConfig(input.agentPolicy),
  ];
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.delegate !== undefined) config.delegate = layer.delegate;
    const v = pick(layer.verification, VERIFICATIONS);
    if (v) config.verification = v;
    const it = pick(layer.issues, ISSUE_TRACKINGS);
    if (it) config.issues = it;
    if (isIssueAccess(layer.issueAccess)) config.issueAccess = layer.issueAccess;
    if (layer.ask !== undefined) config.ask = layer.ask;
    if (layer.approval === "human" || layer.approval === "agent") config.approval = layer.approval;
    const a = pick(layer.ambiguity, AMBIGUITIES);
    if (a) config.ambiguity = a;
  }

  // Run-level overrides win over everything.
  if (input.runOverrides) {
    if (input.runOverrides.delegate !== undefined) config.delegate = input.runOverrides.delegate;
    if (input.runOverrides.verification !== undefined) config.verification = input.runOverrides.verification;
    if (input.runOverrides.issues !== undefined) config.issues = input.runOverrides.issues;
    if (isIssueAccess(input.runOverrides.issueAccess)) config.issueAccess = input.runOverrides.issueAccess;
    if (input.runOverrides.ask !== undefined) config.ask = input.runOverrides.ask;
    if (input.runOverrides.approval !== undefined) config.approval = input.runOverrides.approval;
    if (input.runOverrides.ambiguity !== undefined) config.ambiguity = input.runOverrides.ambiguity;
  }
  return config;
}

function pickPreset(input: ResolveInput): PresetName {
  const candidates = [
    input.runOverrides?.preset,
    input.agentPolicy?.preset,
    input.machineOverrides?.preset,
  ];
  for (const c of candidates) {
    const p = pick(c, PRESET_NAMES);
    if (p) return p;
  }
  return ROLE_PRESET[input.role] ?? "assistant";
}

function agentPolicyToConfig(policy: AgentPolicy | undefined): AgentConfigOverrides | undefined {
  if (!policy) return undefined;
  const out: AgentConfigOverrides = {};
  if (policy.preset !== undefined) out.preset = policy.preset;
  if (policy.delegate !== undefined) out.delegate = policy.delegate;
  if (policy.verification !== undefined) out.verification = policy.verification;
  if (policy.issues !== undefined) out.issues = policy.issues;
  if (policy.issueAccess !== undefined) out.issueAccess = policy.issueAccess;
  if (policy.ask !== undefined) out.ask = policy.ask;
  if (policy.approval !== undefined) out.approval = policy.approval;
  if (policy.ambiguity !== undefined) out.ambiguity = policy.ambiguity;
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

export function ambiguityPrompt(mode: AmbiguityMode): string {
  return AMBIGUITY_PROMPTS[mode];
}

/** `ask` is available in strict/precise/adaptive — never in autonomous. */
export function askEnabled(config: AgentConfig): boolean {
  return config.ask && config.ambiguity !== "autonomous";
}

/* ------------------------------------------------------ prompt composition */

const VERIFICATION_PROMPTS: Record<Verification, string> = {
  direct: "Verification level DIRECT: no new tests; runner gates still apply.",
  verified:
    "Verification level VERIFIED: add focused tests; run each gate once after the final edit, and reuse the result unless files changed.",
  redundant:
    "Verification level REDUNDANT: verified, plus independent review approval.",
};

export function composePrompt(def: AgentDef, config: AgentConfig, _capabilities: readonly string[]): string {
  return [
    def.prompt,
    "",
    `Config: preset ${config.preset}.`,
    ambiguityPrompt(config.ambiguity),
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
  task: "run:spawn",
  ask: null, // gated by askEnabled(config)
  issue: "issue:read", // per-action capabilities are checked inside the tool
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
    if (t === "issue" && (config.issueAccess ?? roleIssueAccess(role)) === "none") return false;
    const needed = TOOL_CAPABILITY[t];
    if (needed && !capSet.has(needed)) return false;
    return true;
  });
  // Read-only roles never hold mutating file tools regardless of capabilities.
  if (def.readonly) tools = tools.filter((t) => t !== "write" && t !== "edit");
  const prompt = composePrompt(def, config, capabilities);
  return { def: { ...def, prompt, tools }, config, capabilities, prompt };
}
