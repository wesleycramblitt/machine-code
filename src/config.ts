/**
 * machine_code — config.toml and policy.toml loaders.
 *
 * config.toml (machine): rate caps, vetoes, default output-token ceiling,
 * default packet mode. Only the machine may set money.
 * policy.toml (repo, committed): per-agent requirements; may override the
 * output-token ceiling per agent. Unknown keys are ignored (forward-compat).
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { Layout } from "./paths.js";

export interface PriceCaps {
  /** $ per 1M input tokens. */
  input?: number;
  /** $ per 1M output tokens. */
  output?: number;
}

export type PacketMode = "direct" | "verified" | "redundant";

export interface MachineConfig {
  maxOutputTokens?: number;
  defaultMode?: PacketMode;
  priceCaps: PriceCaps;
  /** Model keys ("provider/id") or canonical ids that must never be selected. */
  vetoes: string[];
}

export interface AgentPolicy {
  minContext: number;
  /** Fixed per-agent output estimate used by the selector. */
  expectedOutputTokens: number;
  /** Per-agent output-token ceiling override. */
  maxOutputTokens?: number;
  /** Total token budget for one run of this agent. */
  budgetTokens?: number;
  /** Minimum catalogue capability score (0-10); 0 disables the floor. */
  minCapability: number;
  /** Whether the agent calls tools (drives the tool-support hard filter). */
  toolCall: boolean;
}

export interface Policy {
  agents: Record<string, AgentPolicy>;
}

export class ConfigError extends Error {}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function readToml(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${label}: invalid TOML in ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${label}: ${file} must contain a TOML table`);
  }
  return parsed as Record<string, unknown>;
}

const PACKET_MODES: readonly PacketMode[] = ["direct", "verified", "redundant"];

export function loadMachineConfig(layout: Layout): MachineConfig {
  const raw = readToml(layout.machineConfig, "machine config");
  const caps = (raw.price_caps ?? {}) as Record<string, unknown>;
  const defaultMode = typeof raw.default_mode === "string" ? raw.default_mode : undefined;
  if (defaultMode !== undefined && !PACKET_MODES.includes(defaultMode as PacketMode)) {
    throw new ConfigError(`machine config: default_mode must be one of ${PACKET_MODES.join(", ")}`);
  }
  return {
    maxOutputTokens: asNumber(raw.max_output_tokens),
    defaultMode: defaultMode as PacketMode | undefined,
    priceCaps: { input: asNumber(caps.input), output: asNumber(caps.output) },
    vetoes: asStringArray(raw.vetoes),
  };
}

const DEFAULT_AGENT_POLICY: AgentPolicy = {
  minContext: 32_000,
  expectedOutputTokens: 2_000,
  // Default quality floor: mid-tier capability (0-10 catalogue scale), so the
  // cheapest *adequate* model wins rather than the cheapest row in the
  // catalogue. Bottom-tier models ignore tool instructions too often.
  // Override per agent in policy.toml.
  minCapability: 6,
  toolCall: true,
};

function agentPolicy(value: unknown): AgentPolicy {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    minContext: asNumber(raw.min_context) ?? DEFAULT_AGENT_POLICY.minContext,
    expectedOutputTokens:
      asNumber(raw.expected_output_tokens) ?? DEFAULT_AGENT_POLICY.expectedOutputTokens,
    maxOutputTokens: asNumber(raw.max_output_tokens),
    budgetTokens: asNumber(raw.budget_tokens),
    minCapability: asNumber(raw.min_capability) ?? DEFAULT_AGENT_POLICY.minCapability,
    toolCall: typeof raw.tool_call === "boolean" ? raw.tool_call : DEFAULT_AGENT_POLICY.toolCall,
  };
}

export function loadPolicy(layout: Layout): Policy {
  const raw = readToml(layout.policyFile, "repo policy");
  const agentsRaw = (raw.agents ?? {}) as Record<string, unknown>;
  const agents: Record<string, AgentPolicy> = {};
  for (const name of ["general", "architect", "build", "review", "sudo"]) {
    agents[name] = agentPolicy(agentsRaw[name]);
  }
  return { agents };
}

/**
 * Effective output-token ceiling for an agent: agent override wins over the
 * machine default; when neither is set there is no configured ceiling (the
 * model maximum applies). Rejects settings below the agent's expected-output
 * estimate, which would make every request truncate by construction.
 */
export function effectiveOutputCeiling(
  agent: AgentPolicy,
  machine: MachineConfig,
): number | undefined {
  const ceiling = agent.maxOutputTokens ?? machine.maxOutputTokens;
  if (ceiling === undefined) return undefined;
  if (ceiling < agent.expectedOutputTokens) {
    throw new ConfigError(
      `output-token ceiling (${ceiling}) is below the agent's expected output estimate (${agent.expectedOutputTokens})`,
    );
  }
  return ceiling;
}
