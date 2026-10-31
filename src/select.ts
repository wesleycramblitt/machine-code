/**
 * machine_code — deterministic per-call model selection.
 *
 * Every provider call runs pick(): estimate input as context chars ÷ 4 and
 * output as the agent's fixed expected output; hard-filter; score capability
 * shortfall, estimated cost, speed, and context headroom with fixed weights;
 * ties go to the lexicographically smaller model key. No stickiness, no
 * learned estimates. Every pick is logged by the caller.
 */
import type { AgentPolicy, MachineConfig } from "./config.js";
import { estimateCallCost, pricingAt } from "./catalogue/scoring.js";
import type { CatalogueRow } from "./catalogue/types.js";
import type { AvailabilityState } from "./availability.js";
import { isProviderDisabled, isProviderCooling, isModelCooling, providerNeedsAuth } from "./availability.js";

/** Fixed scoring weights, tuned on evals. */
export const WEIGHTS = {
  capability: 0.5,
  cost: 0.25,
  speed: 0.1,
  headroom: 0.15,
} as const;

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
  terms: { capability: number; cost: number; speed: number; headroom: number };
  estimatedCost: number;
}

export interface RejectedCandidate {
  key: string;
  reason: string;
}

export interface PickResult {
  selected: CatalogueRow;
  estimate: PickEstimate;
  /** Top candidates after filtering, ascending score (best first), max 5. */
  candidates: CandidateScore[];
  rejectedCount: number;
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
  /** Debug/test hard filter: restrict to one provider. */
  requireProvider?: string;
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

function vetoed(row: CatalogueRow, vetoes: readonly string[]): boolean {
  return vetoes.includes(row.key) || (row.canonicalID !== null && vetoes.includes(row.canonicalID));
}

function rejectReason(
  row: CatalogueRow,
  input: PickInput,
  estimate: PickEstimate,
): string | null {
  if (!input.configuredProviders.has(row.providerID)) return "provider-not-configured";
  if (input.requireProvider && row.providerID !== input.requireProvider) return "provider-filtered";
  if (row.pricing.input < 0 || row.pricing.output < 0) return "invalid-pricing";
  const avail = input.availability;
  if (avail) {
    if (isProviderDisabled(avail, row.providerID)) return "provider-disabled";
    if (providerNeedsAuth(avail, row.providerID)) return "provider-needs-auth";
    if (isProviderCooling(avail, row.providerID)) return "provider-cooling";
    if (isModelCooling(avail, row.key)) return "model-cooling";
  }
  if (input.policy.toolCall && !row.toolCall) return "no-tool-support";
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
): CandidateScore {
  const estimatedCost = estimateCallCost(row.pricing, estimate.inputTokens, estimate.outputTokens);
  const shortfall = Math.max(0, input.policy.minCapability - row.scores.capability) / 10;
  const costTerm = Math.max(0, Math.min(1, normalizeCost(estimatedCost)));
  const speedTerm = 1 - normalize(row.tokensPerSecond ?? Number.NaN, SPEED_BAND);
  const needed = estimate.inputTokens + estimate.outputTokens;
  const headroomNorm = row.context > 0 ? Math.max(0, Math.min(1, (row.context - needed) / row.context)) : 0;
  const headroomTerm = 1 - headroomNorm;
  const score =
    WEIGHTS.capability * shortfall +
    WEIGHTS.cost * costTerm +
    WEIGHTS.speed * speedTerm +
    WEIGHTS.headroom * headroomTerm;
  return {
    key: row.key,
    score: Math.round(score * 1e6) / 1e6,
    terms: {
      capability: Math.round(shortfall * 1e4) / 1e4,
      cost: Math.round(costTerm * 1e4) / 1e4,
      speed: Math.round(speedTerm * 1e4) / 1e4,
      headroom: Math.round(headroomTerm * 1e4) / 1e4,
    },
    estimatedCost: Math.round(estimatedCost * 1e8) / 1e8,
  };
}

export function pick(input: PickInput): PickResult | { error: string; rejected: RejectedCandidate[] } {
  const estimate = estimateTokens(input.contextChars, input.policy.expectedOutputTokens);
  const candidates: Array<{ row: CatalogueRow; scored: CandidateScore }> = [];
  const rejected: RejectedCandidate[] = [];

  for (const row of input.catalogue) {
    const reason = rejectReason(row, input, estimate);
    if (reason) {
      rejected.push({ key: row.key, reason });
      continue;
    }
    candidates.push({ row, scored: scoreCandidate(row, input, estimate) });
  }

  if (candidates.length === 0) {
    return { error: `no eligible model for agent "${input.agent}"`, rejected: rejected.slice(0, 10) };
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
    rejectedCount: rejected.length,
    rejected: rejected.slice(0, 10),
  };
}
