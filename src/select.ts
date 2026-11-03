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
import { estimateCallCost, pricingAt, type AxisScores } from "./catalogue/scoring.js";
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

const BALANCED_AXIS_WEIGHTS: AxisWeights = {
  reasoning: 0.25,
  code: 0.25,
  agentic: 0.25,
  general: 0.25,
};

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

/** Role-weighted axis mix; the "capability" the selector actually trades against cost. */
export function capabilityFit(scores: AxisScores, weights: AxisWeights): number {
  return CAPABILITY_AXES.reduce((total, axis) => total + scores[axis] * weights[axis], 0);
}

/** Estimated-call-cost normalization band, in dollars. */
const COST_BAND = [1e-5, 1] as const;
/** tokens/sec normalization band for curated speed hints. */
const SPEED_BAND = [10, 250] as const;

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
function matchesModel(row: CatalogueRow, pin: string): boolean {
  return row.key === pin || row.id === pin || row.key.endsWith(`/${pin}`);
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
  // Free offers use the free floor in both tiers. Paid offers keep the paid
  // floor, so a cheap model cannot bypass the quality bar just by existing.
  const minFit = freeRow ? (input.policy.freeMinFit ?? input.policy.minFit) : input.policy.minFit;
  const minCapability = freeRow
    ? (input.policy.freeMinCapability ?? input.policy.minCapability)
    : input.policy.minCapability;
  const minAxes =
    freeRow && input.policy.freeMinAxes
      ? { ...(input.policy.minAxes ?? {}), ...input.policy.freeMinAxes }
      : input.policy.minAxes;
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
  const needed = estimate.inputTokens + estimate.outputTokens;
  if (row.context > 0 && row.context < needed) return "context-too-small";
  if (row.maxOutput > 0 && row.maxOutput < estimate.outputTokens) return "output-too-small";
  const caps = input.machine.priceCaps;
  if (caps.input !== undefined || caps.output !== undefined) {
    const rates = pricingAt(row.pricing, estimate.inputTokens);
    if (caps.input !== undefined && rates.input > caps.input) return "over-input-price-cap";
    if (caps.output !== undefined && rates.output > caps.output) return "over-output-price-cap";
  }
  if (vetoed(row, input.machine.vetoes)) return "vetoed";
  return null;
}

export function scoreCandidate(
  row: CatalogueRow,
  input: PickInput,
  estimate: PickEstimate,
  roleWeightsInput?: AxisWeights,
): CandidateScore {
  const estimatedCost = effectiveCallCost(row, estimate.inputTokens, estimate.outputTokens, input.machine);
  const weights = roleWeightsInput ?? axisWeights(input.agent, input.policy);
  const fit = capabilityFit(row.scores, weights);
  // Metadata priors are a guess about an unmeasured model. Keep them eligible
  // (especially for the free tier) but do not let a guessed fit outrank a
  // benchmark-backed row by a hair. Rows with any reported benchmark keep their
  // measured fit; only fully estimated rows take the penalty.
  const confidenceTerm = row.provenance?.estimated === true ? 1 : 0;
  // Lower is better: a role-fit of 10 scores 0, a fit of 6 scores 0.4. This
  // keeps a gradient above the floor instead of treating every eligible model
  // as equally capable.
  const quality = Math.max(0, Math.min(1, (10 - fit) / 10));
  const costTerm = Math.max(0, Math.min(1, normalizeCost(estimatedCost)));
  const speedTerm = 1 - normalize(row.tokensPerSecond ?? Number.NaN, SPEED_BAND);
  const needed = estimate.inputTokens + estimate.outputTokens;
  const headroomNorm = row.context > 0 ? Math.max(0, Math.min(1, (row.context - needed) / row.context)) : 0;
  const headroomTerm = 1 - headroomNorm;
  const score =
    WEIGHTS.capability * quality +
    WEIGHTS.cost * costTerm +
    WEIGHTS.speed * speedTerm +
    WEIGHTS.headroom * headroomTerm +
    WEIGHTS.confidence * confidenceTerm;
  return {
    key: row.key,
    score: Math.round(score * 1e6) / 1e6,
    fit: Math.round(fit * 1e4) / 1e4,
    terms: {
      capability: Math.round(quality * 1e4) / 1e4,
      cost: Math.round(costTerm * 1e4) / 1e4,
      speed: Math.round(speedTerm * 1e4) / 1e4,
      headroom: Math.round(headroomTerm * 1e4) / 1e4,
      confidence: Math.round(confidenceTerm * 1e4) / 1e4,
    },
    estimatedCost: Math.round(estimatedCost * 1e8) / 1e8,
  };
}

/** Why one catalogue row is not eligible, or eligible with no reason. */
export function modelStatus(
  row: CatalogueRow,
  input: PickInput,
): { eligible: true } | { eligible: false; reason: string } {
  const estimate = estimateTokens(input.contextChars, input.policy.expectedOutputTokens);
  const weights = axisWeights(input.agent, input.policy);
  const reason = rejectReason(row, input, estimate, weights);
  return reason ? { eligible: false, reason } : { eligible: true };
}

export function pick(
  input: PickInput,
): PickResult | { error: string; rejected: RejectedCandidate[]; rejectedCount: number; rejectedByReason: Record<string, number> } {
  const estimate = estimateTokens(input.contextChars, input.policy.expectedOutputTokens);
  const weights = axisWeights(input.agent, input.policy);
  const candidates: Array<{ row: CatalogueRow; scored: CandidateScore }> = [];
  const rejected: RejectedCandidate[] = [];
  const rejectedByReason: Record<string, number> = {};

  for (const row of input.catalogue) {
    const reason = rejectReason(row, input, estimate, weights);
    if (reason) {
      rejected.push({ key: row.key, reason });
      rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
      continue;
    }
    candidates.push({ row, scored: scoreCandidate(row, input, estimate, weights) });
  }

  if (candidates.length === 0) {
    return {
      error: `no eligible model for agent "${input.agent}"`,
      rejected: rejected.slice(0, 10),
      rejectedCount: rejected.length,
      rejectedByReason,
    };
  }

  // Ascending score; exact ties go to the lexicographically smaller key.
  candidates.sort((a, b) =>
    a.scored.score !== b.scored.score
      ? a.scored.score - b.scored.score
      : a.row.key < b.row.key
        ? -1
        : 1,
  );

  const best = candidates[0]!;
  return {
    selected: best.row,
    estimate,
    candidates: candidates.slice(0, 5).map((c) => c.scored),
    tier: selectionTier(input),
    rejectedCount: rejected.length,
    rejectedByReason,
    rejected: rejected.slice(0, 10),
  };
}
