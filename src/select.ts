/**
 * machine_code — deterministic per-call model selection.
 *
 * Every provider call runs pick(): estimate input as context chars ÷ 4 and
 * output as the agent's fixed expected output; hard-filter; sort eligible
 * candidates by estimated per-call cost ascending (cheapest first), with ties
 * broken by fit descending. No stickiness, no learned estimates.
 * Every pick is logged by the caller.
 *
 * Capability is multi-dimensional. A row carries four axis scores
 * (reasoning, code, agentic, general); `pick` hard-filters on the role-weighted
 * `minFit` (the primary gate), an optional neutral `minCapability` safety floor,
 * and optional per-axis floors. It then uses the same role-weighted axis mix
 * for the fit display, but the selection order is purely cost-based.
 */
import type { AgentPolicy, CapabilityAxis, MachineConfig, SelectionTier } from "./config.js";
import { CAPABILITY_AXES } from "./config.js";
import { estimateCallCost, type AxisScores } from "./catalogue/scoring.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AvailabilityState } from "./availability.js";
import { isProviderDisabled, isProviderCooling, isModelCooling, providerNeedsAuth } from "./availability.js";
import { roleWeights } from "./agents.js";
import { loadProviderDefinitions } from "./data.js";

type AxisWeights = Record<CapabilityAxis, number>;

/** Resolve and normalize the axis mix for an agent (policy overrides role defaults). */
export function axisWeights(agent: string, policy: AgentPolicy): AxisWeights {
  const dataWeights = roleWeights(agent);
  const base: AxisWeights = {
    reasoning: dataWeights.reasoning ?? 0.25,
    code: dataWeights.code ?? 0.25,
    agentic: dataWeights.agentic ?? 0.25,
    general: dataWeights.general ?? 0.25,
  };
  const merged: AxisWeights = { ...base };
  for (const axis of CAPABILITY_AXES) {
    const value = policy.axisWeights?.[axis];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) merged[axis] = value;
  }
  const sum = CAPABILITY_AXES.reduce((total, axis) => total + merged[axis], 0);
  if (!(sum > 0)) return { ...base };
  for (const axis of CAPABILITY_AXES) merged[axis] = merged[axis] / sum;
  return merged;
}

/**
 * Role-weighted axis mix; the "capability" the selector actually trades against
 * cost. Uses a weighted generalized mean with p = -2 so low axis scores are
 * penalized aggressively: a model with one strong axis (e.g. Ling-3.1-Flash:
 * strong reasoning, weak code/general) cannot clear the minFit gate on its
 * strengths alone.
 *
 * S_p = (sum(w_i * x_i^p) / sum(w_i)) ^ (1/p)
 */
export function capabilityFit(scores: AxisScores, weights: AxisWeights): number {
  const p = -1;
  let numerator = 0;
  let activeWeight = 0;
  for (const axis of CAPABILITY_AXES) {
    const w = weights[axis];
    const x = scores[axis];
    if (w > 0 && x > 0) {
      numerator += w * Math.pow(x, p);
      activeWeight += w;
    } else if (w > 0) {
      // A zero measured axis makes the mean zero — unconditional rejection.
      return 0;
    }
  }
  return Math.pow(numerator / activeWeight, 1 / p);
}

export interface PickEstimate {
  inputTokens: number;
  outputTokens: number;
}

export interface CandidateScore {
  key: string;
  fit: number;
  estimatedCost: number;
}

export interface RejectedCandidate {
  key: string;
  reason: string;
}

export interface PickResult {
  selected: CatalogueRow;
  estimate: PickEstimate;
  /** All eligible candidates after filtering, before the display cap. */
  eligibleCount: number;
  /** Top candidates after filtering, ascending cost (cheapest first), max 5. */
  candidates: CandidateScore[];
  rejectedCount: number;
  /** Rejection counts by reason, across the whole catalogue. */
  rejectedByReason: Record<string, number>;
  /** First few rejection reasons, for debugging. */
  rejected: RejectedCandidate[];
  /** Selection tier used for this pick. */
  tier?: SelectionTier;
}

export interface PickInput {
  agent: string;
  policy: AgentPolicy;
  machine: MachineConfig;
  catalogue: readonly CatalogueRow[];
  /** Providers with complete credentials. */
  configuredProviders: ReadonlySet<string>;
  /** Estimated current context size in characters. */
  contextChars: number;
  /** Providers with funding for paid rows. */
  fundedProviders?: ReadonlySet<string>;
  /** Debug/test hard filter: restrict to one provider. */
  requireProvider?: string;
  /** Hard filter: pin selection to one catalogue key (or model id suffix). */
  requireModel?: string;
  /** Provider/model availability state (M2). */
  availability?: AvailabilityState;
  /** Selection tier: "paid" filters out ollama; "local" only allows ollama. */
  tier?: SelectionTier;
}



export function estimateTokens(contextChars: number, expectedOutputTokens: number): PickEstimate {
  return {
    inputTokens: Math.ceil(contextChars / 4),
    outputTokens: expectedOutputTokens,
  };
}



/**
 * Meta routers (OpenRouter "auto"/jev-router and similar) forward to unknown
 * upstream models, so their catalogue scores and capabilities are guesses.
 * They are never selected.
 */
const META_ROUTER_PATTERN = /(?:^|[/_.\-\s])(router|routing|auto-router|aggregator)(?:$|[/_.\-\s])/i;

export function isMetaRouter(row: CatalogueRow): boolean {
  return META_ROUTER_PATTERN.test(`${row.key} ${row.name ?? ""}`);
}

export function providerMultiplier(machine: MachineConfig, providerID: string): number {
  const value = machine.providers?.[providerID]?.costMultiplier;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const fallback = loadProviderDefinitions()[providerID]?.costMultiplier;
  return typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0 ? fallback : 1;
}

/** Effective (billed) cost for a call, after provider multipliers. */
export function effectiveCallCost(
  row: CatalogueRow,
  inputTokens: number,
  outputTokens: number,
  machine: MachineConfig,
): number {
  return estimateCallCost(row.pricing, inputTokens, outputTokens) * providerMultiplier(machine, row.providerID);
}



function vetoed(row: CatalogueRow, vetoes: readonly string[]): boolean {
  return vetoes.includes(row.key) || (row.canonicalID !== null && vetoes.includes(row.canonicalID));
}

/** A model pin accepts the full catalogue key ("provider/id"), the bare id, or an id suffix. */
export function matchesModel(row: Pick<CatalogueRow, "key" | "id">, pin: string): boolean {
  return row.key === pin || row.id === pin || row.key.endsWith(`/${pin}`);
}

export interface ModelPin {
  model?: string;
  provider?: string;
}

/**
 * A `--model`/`--provider` pin is a preference, not a suicide pact. When the
 * pinned model fails, drop the pin so the retry falls back to auto-selection
 * instead of filtering the whole catalogue down to the one model that just
 * failed ("no eligible model" with hundreds of rows available).
 */
export function relaxPinForFailure(
  pin: ModelPin,
  failedKey: string,
  providerID: string,
): { pin: ModelPin; dropped: string[] } {
  const dropped: string[] = [];
  let { model, provider } = pin;
  if (model && failedKey && matchesModel({ key: failedKey, id: failedKey }, model)) {
    dropped.push(`model:${model}`);
    model = undefined;
  }
  if (provider && providerID && providerID === provider) {
    dropped.push(`provider:${provider}`);
    provider = undefined;
  }
  return { pin: { model, provider }, dropped };
}

function rejectReason(
  row: CatalogueRow,
  input: PickInput,
  estimate: PickEstimate,
  weights: AxisWeights,
): string | null {
  if (input.tier === "local" && row.providerID !== "ollama") return "paid-model";
  if (input.tier === "paid" && row.providerID === "ollama") return "local-model";
  // Free (zero-cost) offers are for the local tier only; the paid tier should
  // never select them — they are unreliable API giveaways, not production models.
  if (input.tier === "paid" && (row.free === true || (row.pricing.input === 0 && row.pricing.output === 0))) return "free-model";
  if (!input.configuredProviders.has(row.providerID)) return "provider-not-configured";
  if (input.requireProvider && row.providerID !== input.requireProvider) return "provider-filtered";
  if (input.requireModel && !matchesModel(row, input.requireModel)) return "model-filtered";
  if (row.pricing.input < 0 || row.pricing.output < 0) return "invalid-pricing";
  const avail = input.availability;
  if (avail) {
    if (isProviderDisabled(avail, row.providerID)) return "provider-disabled";
    if (providerNeedsAuth(avail, row.providerID)) return "provider-needs-auth";
    if (isProviderCooling(avail, row.providerID)) return "provider-cooling";
    if (isModelCooling(avail, row.key)) return "model-cooling";
  }
  if (row.coding === false) return "non-coding-model";
  if (isMetaRouter(row)) return "router-model";
  if (input.policy.toolCall && !row.toolCall) return "no-tool-support";
  if (input.fundedProviders && !input.fundedProviders.has(row.providerID)) return "unfunded-provider";
  if (input.policy.minFit > 0 && capabilityFit(row.scores, weights) < input.policy.minFit) {
    return "below-min-fit";
  }
  if (input.policy.minCapability > 0 && row.scores.capability < input.policy.minCapability) {
    return "below-min-capability";
  }
  for (const axis of CAPABILITY_AXES) {
    const floor = input.policy.minAxes?.[axis];
    if (floor !== undefined && floor > 0 && row.scores[axis] < floor) return `below-min-${axis}`;
  }
  if (row.context < input.policy.minContext) return "below-min-context";
  return null;
}



export interface PickFailure {
  error: string;
  rejected: RejectedCandidate[];
  rejectedCount: number;
  rejectedByReason: Record<string, number>;
}

/** Per-row eligibility status for the model picker UI (does not pick). */
export function modelStatus(
  row: CatalogueRow,
  input: PickInput,
): { eligible: true } | { eligible: false; reason: string } {
  const weights = axisWeights(input.agent, input.policy);
  const estimate = estimateTokens(input.contextChars, input.policy.expectedOutputTokens ?? 32);
  const reason = rejectReason(row, input, estimate, weights);
  return reason ? { eligible: false, reason } : { eligible: true };
}

export function pick(input: PickInput): PickResult | PickFailure {
  const weights = axisWeights(input.agent, input.policy);
  const estimate = estimateTokens(input.contextChars, input.policy.expectedOutputTokens ?? 32);
  const vetoes = input.machine.vetoes;
  const rejections = new Map<string, number>();
  const rejected: RejectedCandidate[] = [];
  const candidates: CandidateScore[] = [];

  for (const row of input.catalogue) {
    const reason = vetoed(row, vetoes)
      ? "vetoed"
      : rejectReason(row, input, estimate, weights);
    if (reason) {
      rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
      if (rejected.length < 3) rejected.push({ key: row.key, reason });
      continue;
    }
    const fit = capabilityFit(row.scores, weights);
    const cost = effectiveCallCost(row, estimate.inputTokens, estimate.outputTokens, input.machine);
    candidates.push({ key: row.key, fit, estimatedCost: cost });
  }

  // Sort by cost ascending, ties broken by fit descending, then key ascending.
  candidates.sort((a, b) => {
    if (a.estimatedCost !== b.estimatedCost) return a.estimatedCost - b.estimatedCost;
    if (b.fit !== a.fit) return b.fit - a.fit;
    return a.key.localeCompare(b.key);
  });
  const top = candidates.slice(0, 5);

  if (candidates.length === 0) {
    return {
      error: `no eligible model (${rejections.size} rejected: ${[...rejections.entries()].map(([r, n]) => `${r}×${n}`).join(", ")})`,
      rejected,
      rejectedCount: rejections.size,
      rejectedByReason: Object.fromEntries(rejections),
    };
  }

  return {
    selected: input.catalogue.find((row) => row.key === top[0]!.key)!,
    estimate,
    eligibleCount: candidates.length,
    candidates: top,
    rejectedCount: rejections.size,
    rejectedByReason: Object.fromEntries(rejections),
    rejected,
    tier: input.tier,
  };
}