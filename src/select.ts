/**
 * machine_code — deterministic per-call model selection.
 *
 * Every provider call runs pick(): estimate input as context chars ÷ 4 and
 * output as the agent's fixed expected output; hard-filter; score
 * role-weighted capability, estimated cost, speed, context headroom, and score
 * confidence with fixed weights; ties go to the lexicographically smaller model
 * key. No stickiness, no learned estimates. Every pick is logged by the caller.
 *
 * Capability is multi-dimensional. A row carries four axis scores
 * (reasoning, code, agentic, general); `pick` hard-filters on the role-weighted
 * `minFit` (the primary gate), an optional neutral `minCapability` safety floor,
 * and optional per-axis floors. It then scores the same role-weighted axis mix
 * so a better model beats a cheaper worse one when the gap is large enough.
 */
import type { AgentPolicy, CapabilityAxis, MachineConfig, SelectionTier } from "./config.js";
import { CAPABILITY_AXES } from "./config.js";
import { estimateCallCost, type AxisScores } from "./catalogue/scoring.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AvailabilityState } from "./availability.js";
import { isProviderDisabled, isProviderCooling, isModelCooling, providerNeedsAuth } from "./availability.js";
import { roleWeights } from "./agents.js";
import { loadProviderDefinitions } from "./data.js";

export interface ScoreWeights {
  capability: number;
  cost: number;
  speed: number;
  headroom: number;
  /** Penalty for rows whose scores are metadata priors, not measurements. */
  confidence: number;
}

/** Fixed scoring weights, tuned on evals. */
export const WEIGHTS: ScoreWeights = {
  capability: 0.5,
  cost: 0.25,
  speed: 0.1,
  headroom: 0.15,
  confidence: 0.1,
};

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

/** Estimated-call-cost normalization band, in dollars. */
const COST_BAND = [1e-5, 1] as const;

export interface PickEstimate {
  inputTokens: number;
  outputTokens: number;
}

export interface CandidateScore {
  key: string;
  score: number;
  /** Role-weighted axis mix used for this candidate. */
  fit: number;
  terms: { capability: number; cost: number; speed: number; headroom: number; confidence: number };
  estimatedCost: number;
}

export interface RejectedCandidate {
  key: string;
  reason: string;
}

export interface PickResult {
  selected: CatalogueRow;
  estimate: PickEstimate;
  tier: SelectionTier;
  /** All eligible candidates after filtering, before the display cap. */
  eligibleCount: number;
  /** Top candidates after filtering, ascending score (best first), max 5. */
  candidates: CandidateScore[];
  rejectedCount: number;
  /** Rejection counts by reason, across the whole catalogue. */
  rejectedByReason: Record<string, number>;
  /** First few rejection reasons, for debugging. */
  rejected: RejectedCandidate[];
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
  /** Per-run override of the machine selection tier. */
  tier?: SelectionTier;
  /** Providers with funding for paid rows. Free rows bypass this. */
  fundedProviders?: ReadonlySet<string>;
  /** Debug/test hard filter: restrict to one provider. */
  requireProvider?: string;
  /** Hard filter: pin selection to one catalogue key (or model id suffix). */
  requireModel?: string;
  /** Provider/model availability state (M2). */
  availability?: AvailabilityState;
}

function normalize(value: number, [low, high]: readonly [number, number]): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

function normalizeCost(dollars: number): number {
  if (dollars <= 0) return 0;
  const [low, high] = COST_BAND;
  return (Math.log(dollars) - Math.log(low)) / (Math.log(high) - Math.log(low));
}

export function estimateTokens(contextChars: number, expectedOutputTokens: number): PickEstimate {
  return {
    inputTokens: Math.ceil(contextChars / 4),
    outputTokens: expectedOutputTokens,
  };
}

export function isFreeRow(row: CatalogueRow): boolean {
  return row.free === true || (row.pricing.input === 0 && row.pricing.output === 0);
}

/** Merge shared and free-specific per-axis floors, taking the stricter floor
 *  per axis so a free offer cannot dodge a raised shared floor (see
 *  rejectReason). A configured shared floor is still allowed to be *lower*
 *  than the free floor, letting the free tier pick its own quality in quiet
 *  configuration while a raised shared bar always applies. */
function mergeAxisFloors(
  shared: Partial<Record<CapabilityAxis, number>> | undefined,
  free: Partial<Record<CapabilityAxis, number>> | undefined,
): Partial<Record<CapabilityAxis, number>> | undefined {
  if (!shared && !free) return undefined;
  const merged: Partial<Record<CapabilityAxis, number>> = {};
  for (const axis of CAPABILITY_AXES) {
    const a = shared?.[axis];
    const b = free?.[axis];
    if (a !== undefined || b !== undefined) merged[axis] = Math.max(a ?? 0, b ?? 0);
  }
  return merged;
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

function selectionTier(input: PickInput): SelectionTier {
  return input.tier ?? input.machine.selection?.tier ?? "paid";
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
  const tier = selectionTier(input);
  const freeRow = isFreeRow(row);
  if (tier === "free" && !freeRow) return "not-free";
  if (tier === "paid" && !freeRow) {
    if (input.fundedProviders && !input.fundedProviders.has(row.providerID)) return "unfunded-provider";
  }
  // Free offers use the free floor in both tiers. But an explicit raise of the
  // shared floors — e.g. fit[f] (minFit) up in the run page — must gate free
  // rows too, or a `:free` model stays selectable no matter how high the bar
  // goes. Each gate takes whichever floor is stricter: the free-specific one
  // OR the shared one for the current tier.
  const minFit = freeRow
    ? Math.max(input.policy.freeMinFit ?? input.policy.minFit, input.policy.minFit)
    : input.policy.minFit;
  const minCapability = freeRow
    ? Math.max(input.policy.freeMinCapability ?? input.policy.minCapability, input.policy.minCapability)
    : input.policy.minCapability;
  const minAxes = freeRow ? mergeAxisFloors(input.policy.minAxes, input.policy.freeMinAxes) : input.policy.minAxes;
  if (minFit > 0 && capabilityFit(row.scores, weights) < minFit) {
    return "below-min-fit";
  }
  if (minCapability > 0 && row.scores.capability < minCapability) {
    return "below-min-capability";
  }
  for (const axis of CAPABILITY_AXES) {
    const floor = minAxes?.[axis];
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
    const cost = normalizeCost(effectiveCallCost(row, estimate.inputTokens, estimate.outputTokens, input.machine));
    const capability = normalize(fit, [2, 9]);
    const score = WEIGHTS.capability * capability + WEIGHTS.cost * (1 - cost);
    candidates.push({ key: row.key, score, fit, estimatedCost: cost, terms: {
      capability,
      cost,
      speed: 0,
      headroom: 0,
      confidence: 0,
    } });
  }

  candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
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
    tier: selectionTier(input),
    eligibleCount: candidates.length,
    candidates: top,
    rejectedCount: rejections.size,
    rejectedByReason: Object.fromEntries(rejections),
    rejected,
  };
}