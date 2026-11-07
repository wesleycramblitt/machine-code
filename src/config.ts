/**
 * machine_code — config.toml and policy.toml loaders.
 *
 * config.toml (machine): rate caps, vetoes, default output-token ceiling,
 * default packet mode. Only the machine may set money.
 * policy.toml (repo, committed): per-agent requirements; may override the
 * output-token ceiling per agent. Unknown keys are ignored (forward-compat).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { Layout } from "./paths.js";
import { AGENT_NAMES } from "./agents.js";
import { loadTomlData } from "./data.js";

export interface PriceCaps {
  /** $ per 1M input tokens. */
  input?: number;
  /** $ per 1M output tokens. */
  output?: number;
}

export type PacketMode = "direct" | "verified" | "redundant";

/** Free-tier only, or the best eligible model regardless of price. */
export type SelectionTier = "free" | "paid";
export const SELECTION_TIERS: readonly SelectionTier[] = ["free", "paid"];

export type AvailabilityProbeMode = "off" | "metadata" | "free-models";

export interface AvailabilityConfig {
  /** `metadata` uses free provider endpoints; `free-models` also permits a free 1-token probe. */
  probe: AvailabilityProbeMode;
  /** Minimum gap between automatic probes for one model. */
  intervalMs: number;
  timeoutMs: number;
  /** Global budget for free-model completion probes. */
  freeCompletionMaxPerHour: number;
}

export const DEFAULT_AVAILABILITY: AvailabilityConfig = {
  probe: "metadata",
  intervalMs: 5 * 60_000,
  timeoutMs: 5_000,
  freeCompletionMaxPerHour: 2,
};

/**
 * Abandon a provider call that has produced no stream event within this many
 * milliseconds. The model is cooled and the loop's bounded retry picks another.
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000;

/**
 * Ollama runs locally and is known to exist, but it may be busy with another
 * request (loading a model, finishing a long generation). Give it far longer
 * than remote providers before abandoning the call.
 */
export const DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS = 300_000;

export interface ProviderCost {
  /** Billed cost for this provider as a fraction of list price (1 = list). */
  costMultiplier?: number;
  /** Has funding/credit for paid calls. Free rows are usable regardless. */
  funded?: boolean;
}

export interface ThemeConfig {
  header_bg?: string;
  header_fg?: string;
  footer_bg?: string;
  footer_fg?: string;
  body_bg?: string;
  sub_header_bg?: string;
  sub_header_fg?: string;
  back_bg?: string;
  back_fg?: string;
  section_bg?: string;
  section_fg?: string;
  section_active_bg?: string;
  section_active_fg?: string;
  tab_active_bg?: string;
  tab_active_fg?: string;
}

export const DEFAULT_THEME: Required<ThemeConfig> = {
  header_bg: "#111111",
  header_fg: "#d9d9d9",
  footer_bg: "#111111",
  footer_fg: "#d9d9d9",
  body_bg: "#0a0a0a",
  sub_header_bg: "#1f6feb",
  sub_header_fg: "#ffffff",
  back_bg: "#ff5858",
  back_fg: "#0d1117",
  section_bg: "#090909",
  section_fg: "#8b949e",
  section_active_bg: "#d3d3d3",
  section_active_fg: "#111111",
  tab_active_bg: "#58a658",
  tab_active_fg: "#0d1117",
};

export interface MachineConfig {
  maxOutputTokens?: number;
  defaultMode?: PacketMode;
  /** Selection tier and per-call request guards ([selection]). */
  selection: { tier: SelectionTier; firstTokenTimeoutMs: number; ollamaFirstTokenTimeoutMs: number };
  /** Cooldown recovery probes ([availability]). */
  availability: AvailabilityConfig;
  /** Per-provider billing adjustments ([providers.<id>]). */
  providers: Record<string, ProviderCost>;
  priceCaps: PriceCaps;
  /** Model keys ("provider/id") or canonical ids that must never be selected. */
  vetoes: string[];
  notify: { webhookUrl?: string; command?: string };
  /** Worktree/branch defaults. */
  git: { baseBranch?: string };
  /** Machine-level agent configuration overrides ([agents.<role>]). */
  agents: Record<string, AgentConfigOverrides>;
  /** Context assembly ([context]). */
  context: {
    maxChars: number;
    planFile?: string;
    knowledgeIndex?: string;
  };
  /** Repository map ([map]). */
  map: {
    enabled: boolean;
    semantic: boolean;
    /** Optional pinned model key/id for semantic annotations. */
    semanticModel?: string;
    refresh: "on-change" | "manual" | "always";
  };
  /** TUI palette ([theme]); hex strings. */
  theme: ThemeConfig;
}

/** Only the Phase 3 configuration fields; token/capability policy stays repo-side. */
export interface AgentConfigOverrides {
  preset?: string;
  delegate?: boolean;
  verification?: string;
  artifactScripts?: boolean;
  ask?: boolean;
  approval?: string;
  ambiguity?: string;
  worktree?: boolean;
}

export type CapabilityAxis = "reasoning" | "code" | "agentic" | "general";
export const CAPABILITY_AXES: readonly CapabilityAxis[] = ["reasoning", "code", "agentic", "general"];

export interface AgentPolicy {
  minContext: number;
  /** Fixed per-agent output estimate used by the selector. */
  expectedOutputTokens: number;
  /** Per-agent output-token ceiling override. */
  maxOutputTokens?: number;
  /** Total token budget for one run of this agent. */
  budgetTokens?: number;
  /** Hard cap on assistant turns for one run (default 25). */
  maxTurns?: number;
  /** Neutral composite capability floor (0-10); broad safety only. 0 disables it. */
  minCapability: number;
  /** Role-weighted capability floor (0-10); the primary per-role quality gate. */
  minFit: number;
  /** Hard per-axis floors (0-10); omitted axes have no floor. */
  minAxes?: Partial<Record<CapabilityAxis, number>>;
  /**
   * Free-offer floors. Free rows are judged by these in every tier so a
   * zero-price model can trade one weak axis for cost. Omitted values inherit
   * the paid floors above.
   */
  freeMinFit?: number;
  freeMinCapability?: number;
  freeMinAxes?: Partial<Record<CapabilityAxis, number>>;
  /** Role-weighted axis mix; missing axes fall back to the role defaults and are normalized. */
  axisWeights?: Partial<Record<CapabilityAxis, number>>;
  /** Whether the agent calls tools (drives the tool-support hard filter). */
  toolCall: boolean;
  /* ---- agent configuration (Phase 3); absent = preset defaults ---- */
  /** Named preset: plan | orchestrate | implement | review | assistant | unrestricted. */
  preset?: string;
  /** May the agent call `task` to spawn child runs. */
  delegate?: boolean;
  /** Verification level: direct | verified | redundant. */
  verification?: string;
  /** May provisioning write executable scripts (human opt-in). */
  artifactScripts?: boolean;
  /** May the agent use the ask tool. */
  ask?: boolean;
  /** Default approval mode for runs it plans/delegates: human | agent. */
  approval?: string;
  /** Ambiguity mode: strict | precise | adaptive | autonomous. */
  ambiguity?: string;
  /** Whether the run works in an isolated worktree (default on). */
  worktree?: boolean;
}

export interface Policy {
  agents: Record<string, AgentPolicy>;
}

export class ConfigError extends Error {}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse `5000`, `5s`, `5m`, or `1h` into milliseconds. */
function asDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (match[2] ?? "ms").toLowerCase();
  return n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1);
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
  const notifyRaw = (raw.notify ?? {}) as Record<string, unknown>;
  const gitRaw = (raw.git ?? {}) as Record<string, unknown>;
  const selectionRaw = (raw.selection ?? {}) as Record<string, unknown>;
  const tierRaw =
    typeof selectionRaw.tier === "string"
      ? selectionRaw.tier
      : selectionRaw.mode === "free"
        ? "free"
        : "paid";
  if (!SELECTION_TIERS.includes(tierRaw as SelectionTier)) {
    throw new ConfigError(`machine config: selection.tier must be one of ${SELECTION_TIERS.join(", ")}`);
  }
  const providersRaw = (raw.providers ?? {}) as Record<string, unknown>;
  const providers: Record<string, ProviderCost> = {};
  for (const [id, value] of Object.entries(providersRaw)) {
    const v = (value ?? {}) as Record<string, unknown>;
    const multiplier = asNumber(v.cost_multiplier);
    if (multiplier !== undefined) {
      if (multiplier < 0) throw new ConfigError(`machine config: providers.${id}.cost_multiplier must be >= 0`);
    }
    const funded = typeof v.funded === "boolean" ? v.funded : undefined;
    if (multiplier !== undefined || funded !== undefined) {
      providers[id] = { ...(multiplier !== undefined ? { costMultiplier: multiplier } : {}), ...(funded !== undefined ? { funded } : {}) };
    }
  }
  const agentsRaw = (raw.agents ?? {}) as Record<string, unknown>;
  const agents: Record<string, AgentConfigOverrides> = {};
  for (const [role, value] of Object.entries(agentsRaw)) {
    const r = (value ?? {}) as Record<string, unknown>;
    agents[role] = {
      preset: typeof r.preset === "string" ? r.preset : typeof r.config_mode === "string" ? r.config_mode : undefined,
      delegate: typeof r.delegate === "boolean" ? r.delegate : undefined,
      verification: typeof r.verification === "string" ? r.verification : undefined,
      artifactScripts: typeof r.artifact_scripts === "boolean" ? r.artifact_scripts : undefined,
      ask: typeof r.ask === "boolean" ? r.ask : undefined,
      approval: typeof r.approval === "string" ? r.approval : undefined,
      ambiguity: typeof r.ambiguity === "string" ? r.ambiguity : undefined,
      worktree: typeof r.worktree === "boolean" ? r.worktree : undefined,
    };
  }
  const contextRaw = (raw.context ?? {}) as Record<string, unknown>;
  const availabilityRaw = (raw.availability ?? {}) as Record<string, unknown>;
  const probeMode: AvailabilityProbeMode =
    availabilityRaw.probe === "off" || availabilityRaw.probe === "free-models"
      ? availabilityRaw.probe
      : "metadata";
  const mapRaw = (raw.map ?? {}) as Record<string, unknown>;
  const mapRefresh = mapRaw.refresh === "manual" || mapRaw.refresh === "always" ? mapRaw.refresh : "on-change";
  const themeRaw = (raw.theme ?? {}) as Record<string, unknown>;
  const theme: ThemeConfig = {};
  for (const key of Object.keys(DEFAULT_THEME) as Array<keyof ThemeConfig>) {
    const value = themeRaw[key];
    if (typeof value === "string" && value.trim()) theme[key] = value.trim();
  }
  return {
    maxOutputTokens: asNumber(raw.max_output_tokens),
    defaultMode: defaultMode as PacketMode | undefined,
    selection: {
      tier: tierRaw as SelectionTier,
      firstTokenTimeoutMs: asNumber(selectionRaw.first_token_timeout_ms) ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
      ollamaFirstTokenTimeoutMs:
        asNumber(selectionRaw.ollama_first_token_timeout_ms) ?? DEFAULT_OLLAMA_FIRST_TOKEN_TIMEOUT_MS,
    },
    availability: {
      probe: probeMode,
      intervalMs: asDuration(availabilityRaw.interval ?? availabilityRaw.interval_ms) ?? DEFAULT_AVAILABILITY.intervalMs,
      timeoutMs: asDuration(availabilityRaw.timeout_ms) ?? DEFAULT_AVAILABILITY.timeoutMs,
      freeCompletionMaxPerHour: Math.max(
        0,
        Math.floor(
          asNumber(availabilityRaw.free_completion_max_per_hour) ?? DEFAULT_AVAILABILITY.freeCompletionMaxPerHour,
        ),
      ),
    },
    providers,
    priceCaps: { input: asNumber(caps.input), output: asNumber(caps.output) },
    vetoes: asStringArray(raw.vetoes),
    notify: {
      webhookUrl: typeof notifyRaw.webhook_url === "string" ? notifyRaw.webhook_url : undefined,
      command: typeof notifyRaw.command === "string" ? notifyRaw.command : undefined,
    },
    git: {
      baseBranch: typeof gitRaw.base_branch === "string" ? gitRaw.base_branch : undefined,
    },
    agents,
    context: {
      maxChars: asNumber(contextRaw.max_chars) ?? 64_000,
      planFile: typeof contextRaw.plan_file === "string" ? contextRaw.plan_file : undefined,
      // A repo that keeps knowledge/index.md gets it in context by default.
      // An explicit knowledge_index (including "") still wins.
      knowledgeIndex:
        typeof contextRaw.knowledge_index === "string"
          ? contextRaw.knowledge_index
          : layout.repoRoot && existsSync(join(layout.repoRoot, "knowledge", "index.md"))
            ? "knowledge/index.md"
            : undefined,
    },
    map: {
      enabled: mapRaw.enabled !== false,
      semantic: mapRaw.semantic !== false,
      semanticModel: typeof mapRaw.semantic_model === "string" && mapRaw.semantic_model.trim()
        ? mapRaw.semantic_model.trim()
        : undefined,
      refresh: mapRefresh,
    },
    theme,
  };
}

const policyDefaults = loadTomlData<{ policy?: Record<string, unknown> }>("defaults.toml").policy ?? {};
const freeDefaults = (policyDefaults.free ?? {}) as Record<string, unknown>;

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  minContext: asNumber(policyDefaults.min_context) ?? 32_000,
  expectedOutputTokens: asNumber(policyDefaults.expected_output_tokens) ?? 2_000,
  minCapability: asNumber(policyDefaults.min_capability) ?? 0,
  minFit: asNumber(policyDefaults.min_fit) ?? 6,
  freeMinCapability: asNumber(freeDefaults.min_capability) ?? 0,
  freeMinFit: asNumber(freeDefaults.min_fit) ?? 5.5,
  freeMinAxes: asAxisMap(freeDefaults.axes, "policy.free.axes") ?? {
    reasoning: 5,
    code: 5,
    agentic: 5,
    general: 3,
  },
  toolCall: typeof policyDefaults.tool_call === "boolean" ? policyDefaults.tool_call : true,
};

function asAxisMap(value: unknown, label: string): Partial<Record<CapabilityAxis, number>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${label} must be a TOML table of axis = number`);
  }
  const out: Partial<Record<CapabilityAxis, number>> = {};
  for (const axis of CAPABILITY_AXES) {
    const raw = (value as Record<string, unknown>)[axis];
    if (raw === undefined) continue;
    const n = asNumber(raw);
    if (n === undefined || n < 0 || n > 10) {
      throw new ConfigError(`${label}.${axis} must be a number in 0-10`);
    }
    out[axis] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Apply a policy layer over `base`. Precedence (lowest → highest):
 * built-in defaults → machine `[selection]` → machine `[agents.<role>]` →
 * repo `.machine_code/policy.toml` `[agents.<role>]`.
 */
/** Per-axis merge: a layer overrides only the axes it names. */
function mergeAxes<T extends Partial<Record<CapabilityAxis, number>> | undefined>(
  base: T,
  override: Partial<Record<CapabilityAxis, number>> | undefined,
): T {
  if (override === undefined) return base;
  return { ...(base ?? {}), ...override } as T;
}

function agentPolicy(value: unknown, label: string, base: AgentPolicy = DEFAULT_AGENT_POLICY): AgentPolicy {
  const raw = (value ?? {}) as Record<string, unknown>;
  const freeRaw = (raw.free ?? {}) as Record<string, unknown>;
  return {
    minContext: asNumber(raw.min_context) ?? base.minContext,
    expectedOutputTokens: asNumber(raw.expected_output_tokens) ?? base.expectedOutputTokens,
    maxOutputTokens: asNumber(raw.max_output_tokens) ?? base.maxOutputTokens,
    budgetTokens: asNumber(raw.budget_tokens) ?? base.budgetTokens,
    maxTurns: asNumber(raw.max_turns) ?? base.maxTurns,
    minCapability: asNumber(raw.min_capability) ?? base.minCapability,
    minFit: asNumber(raw.min_fit) ?? base.minFit,
    minAxes: mergeAxes(base.minAxes, asAxisMap(raw.axes, `${label}.axes`)),
    freeMinCapability: asNumber(freeRaw.min_capability) ?? base.freeMinCapability,
    freeMinFit: asNumber(freeRaw.min_fit) ?? base.freeMinFit,
    freeMinAxes: mergeAxes(base.freeMinAxes, asAxisMap(freeRaw.axes, `${label}.free.axes`)),
    axisWeights: mergeAxes(base.axisWeights, asAxisMap(raw.weights, `${label}.weights`)),
    toolCall: typeof raw.tool_call === "boolean" ? raw.tool_call : base.toolCall,
    preset: typeof raw.preset === "string" ? raw.preset : typeof raw.config_mode === "string" ? raw.config_mode : base.preset,
    delegate: typeof raw.delegate === "boolean" ? raw.delegate : base.delegate,
    verification: typeof raw.verification === "string" ? raw.verification : base.verification,
    artifactScripts: typeof raw.artifact_scripts === "boolean" ? raw.artifact_scripts : base.artifactScripts,
    ask: typeof raw.ask === "boolean" ? raw.ask : base.ask,
    approval: typeof raw.approval === "string" ? raw.approval : base.approval,
    ambiguity: typeof raw.ambiguity === "string" ? raw.ambiguity : base.ambiguity,
    worktree: typeof raw.worktree === "boolean" ? raw.worktree : base.worktree,
  };
}

export { AGENT_NAMES };

export function loadPolicy(layout: Layout): Policy {
  const machineRaw = readToml(layout.machineConfig, "machine config");
  const selectionRaw = (machineRaw.selection ?? {}) as Record<string, unknown>;
  const machineAgents = (machineRaw.agents ?? {}) as Record<string, unknown>;
  const repoRaw = readToml(layout.policyFile, "repo policy");
  const repoAgents = (repoRaw.agents ?? {}) as Record<string, unknown>;

  const agents: Record<string, AgentPolicy> = {};
  for (const name of AGENT_NAMES) {
    const global = agentPolicy(selectionRaw, "selection");
    const machine = agentPolicy(machineAgents[name], `agents.${name}`, global);
    agents[name] = agentPolicy(repoAgents[name], `agents.${name}`, machine);
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
