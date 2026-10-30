/**
 * machine_code — pure catalogue scoring and calibration.
 *
 * Copied from the model-selector OpenCode plugin (lib/fetch.ts) per plan.md.
 * Remote-only adaptation: local/ollama parameter-count terms are dropped
 * (machine_code v1 has no local models); the remote neutral prior is kept.
 */
import type { Benchmarks } from "./benchmarks.js";

export interface AxisScores {
  reasoning: number;
  code: number;
  agentic: number;
  general: number;
}

export interface Scores extends AxisScores {
  capability: number;
}

export interface PriceBand {
  size: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: PriceBand[];
}

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/* --------------------------------------------------------- calibration */

const BENCHMARK_ANCHORS: Array<[number, number]> = [
  [0, 0], [10, 1.5], [20, 2.5], [30, 3.6], [40, 4.5],
  [50, 5.4], [60, 6.3], [70, 7.3], [80, 8.6], [90, 9.4], [100, 10],
];

export function calibrateBenchmark(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  const clamped = Math.max(0, Math.min(100, percent));
  for (let i = 1; i < BENCHMARK_ANCHORS.length; i++) {
    const [x0, y0] = BENCHMARK_ANCHORS[i - 1]!;
    const [x1, y1] = BENCHMARK_ANCHORS[i]!;
    if (clamped <= x1) {
      const t = x1 === x0 ? 0 : (clamped - x0) / (x1 - x0);
      return round(y0 + t * (y1 - y0));
    }
  }
  return 10;
}

export function calibrateElo(elo: number): number {
  if (!Number.isFinite(elo)) return 0;
  const clamped = Math.max(1100, Math.min(1560, elo));
  const percent = ((clamped - 1100) / (1560 - 1100)) * 100;
  return round(percent * 0.1);
}

export function scoresFromBenchmarks(
  b: Benchmarks,
  fallback?: AxisScores,
): AxisScores {
  const axis = (columns: Array<number | undefined>, fallbackValue: number) => {
    const values = columns.filter(
      (v): v is number => v !== undefined && Number.isFinite(v),
    );
    if (values.length === 0) return fallbackValue;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  };

  const f = fallback ?? { reasoning: 0, code: 0, agentic: 0, general: 0 };

  const reasoning = axis(
    [
      b.aime === undefined ? undefined : calibrateBenchmark(b.aime),
      b.gpqa === undefined ? undefined : calibrateBenchmark(b.gpqa),
      b.math === undefined ? undefined : calibrateBenchmark(b.math),
    ],
    f.reasoning,
  );
  const code = axis(
    [
      b.sweBench === undefined ? undefined : calibrateBenchmark(b.sweBench),
      b.terminalBench === undefined ? undefined : calibrateBenchmark(b.terminalBench),
      b.liveCodeBench === undefined ? undefined : calibrateBenchmark(b.liveCodeBench),
    ],
    f.code,
  );
  const agentic = axis(
    [
      b.tauBench === undefined ? undefined : calibrateBenchmark(b.tauBench),
      b.terminalBench === undefined ? undefined : calibrateBenchmark(b.terminalBench),
      b.osworld === undefined ? undefined : calibrateBenchmark(b.osworld),
    ],
    f.agentic,
  );
  const general = axis(
    [
      b.mmluPro === undefined ? undefined : calibrateBenchmark(b.mmluPro),
      b.lmarena === undefined ? undefined : calibrateElo(b.lmarena),
      b.ifeval === undefined ? undefined : calibrateBenchmark(b.ifeval),
    ],
    f.general,
  );

  return {
    reasoning: round(reasoning),
    code: round(code),
    agentic: round(agentic),
    general: round(general),
  };
}

/** Combine an axis set into one composite capability score. */
export function capabilityFrom(scores: AxisScores, context: number): number {
  const raw =
    scores.agentic * 0.34 +
    scores.code * 0.3 +
    scores.reasoning * 0.24 +
    scores.general * 0.12;
  const contextTerm = context > 0 ? (Math.min(context, 400000) / 400000) * 10 : 5;
  return round1(raw * 0.9 + contextTerm * 0.1);
}

/* ------------------------------------------- metadata-derived priors */

const PRICE_BAND = [0.02, 200] as const;
const RECENCY_BAND = [Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1)] as const;
const CONTEXT_BAND = [4_000, 2_000_000] as const;

export function normalize(value: number, band: readonly [number, number]): number {
  const [low, high] = band;
  if (!Number.isFinite(value)) return 0.5;
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

export function normalizePrice(price: number): number {
  if (price <= 0) return 0;
  const [low, high] = PRICE_BAND;
  return (Math.log(price) - Math.log(low)) / (Math.log(high) - Math.log(low));
}

function normalizeRecency(releaseDate: string): number {
  const time = Date.parse(releaseDate);
  if (!Number.isFinite(time)) return 0.5;
  return normalize(time, RECENCY_BAND);
}

function normalizeContext(context: number): number {
  if (context <= 0) return 0.5;
  return normalize(context, CONTEXT_BAND);
}

// Tier tokens in a model id or name are a vendor's own ranking of its lineup.
const TIER_UP: Array<[RegExp, number]> = [
  [/\b(max|ultra|xxl|largest)\b/i, 1.0],
  [/\b(pro|plus|advanced|instruct|latest)\b/i, 0.6],
];
const TIER_DOWN: Array<[RegExp, number]> = [
  [/\b(nano|tiny|micro)\b/i, -1.0],
  [/\b(mini|small|flash|lite|air|instant|base)\b/i, -0.6],
];

function tierSignal(id: string, name: string): number {
  const hay = `${id} ${name}`;
  let signal = 0;
  for (const [pattern, weight] of TIER_UP) if (pattern.test(hay)) signal = Math.max(signal, weight);
  for (const [pattern, weight] of TIER_DOWN) if (pattern.test(hay)) signal = Math.min(signal, weight);
  return signal;
}

/** A family version number, when the id carries one (claude-4-5, gpt-5.5). */
function generationSignal(family: string, id: string): number {
  const hay = `${family} ${id}`;
  const match = /(?:\b|[^\d])(\d+(?:\.\d+)?)(?=\D*$|\b)/.exec(hay);
  const version = match?.[1] ? Number.parseFloat(match[1]) : Number.NaN;
  if (!Number.isFinite(version)) return 0.5;
  return normalize(version, [1, 8]);
}

export interface MetadataRow {
  id: string;
  name: string;
  family: string;
  releaseDate: string;
  knowledge: string;
  context: number;
  capabilities: { reasoning: boolean; toolCall: boolean; image: boolean };
}

/**
 * Derive per-axis scores from metadata when no benchmarks exist. Explicitly
 * a fallback: the caller records `estimated: true`, so a ranking built on
 * derived data is distinguishable from one made on a report.
 *
 * Price is never scored: what a model costs says nothing about what it can do.
 * Remote rows use the neutral prior (0.5 * 0.4 = 0.2) where a local row would
 * use its parameter count.
 */
export function scoresFromMetadata(row: MetadataRow): AxisScores {
  const recency = normalizeRecency(row.releaseDate);
  const context = normalizeContext(row.context);
  const tier = tierSignal(row.id, row.name);
  const generation = generationSignal(row.family, row.id);
  const tierTerm = (tier + 1) * 0.5; // -1..1 -> 0..1

  const tierStrength = 0.2; // remote neutral prior

  const reasoningSignal =
    tierStrength +
    recency * 0.15 +
    context * 0.05 +
    generation * 0.12 +
    (row.capabilities.reasoning ? 0.18 : 0) +
    tierTerm * 0.1;

  const codeSignal =
    tierStrength +
    recency * 0.14 +
    generation * 0.13 +
    context * 0.04 +
    (row.capabilities.reasoning ? 0.08 : 0) +
    tierTerm * 0.11;

  const agenticSignal =
    tierStrength +
    (row.capabilities.toolCall ? 0.2 : 0) +
    context * 0.08 +
    recency * 0.12 +
    generation * 0.07 +
    tierTerm * 0.07;

  const knowledgeRecency = normalizeRecency(row.knowledge);
  const modalityBreadth = (row.capabilities.image ? 1 : 0) * 0.04;
  const generalSignal =
    tierStrength +
    knowledgeRecency * 0.16 +
    recency * 0.13 +
    generation * 0.1 +
    context * 0.04 +
    modalityBreadth +
    tierTerm * 0.07;

  const toScore = (signal: number) => {
    // Map 0-1 onto 1.5-10 so no derived model reads as utterly incapable;
    // derived data is a prior, not a verdict.
    const scaled = 1.5 + Math.max(0, Math.min(1, signal)) * 8.5;
    return Math.max(1, Math.min(10, Math.round(scaled * 100) / 100));
  };

  return {
    reasoning: toScore(reasoningSignal),
    code: toScore(codeSignal),
    agentic: toScore(agenticSignal),
    general: toScore(generalSignal),
  };
}

/* ------------------------------------------------------------- pricing */

/** Tier-aware rates: the band whose floor the token count has passed. */
export function pricingAt(pricing: Pricing, tokens: number): Rates {
  const bands = [...(pricing.tiers ?? [])].sort((a, b) => a.size - b.size);
  let eff: Rates = {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead,
    cacheWrite: pricing.cacheWrite,
  };
  for (const band of bands) {
    if (tokens <= band.size) break;
    eff = {
      input: band.input,
      output: band.output,
      cacheRead: band.cacheRead,
      cacheWrite: band.cacheWrite,
    };
  }
  return eff;
}

/** Estimated dollars for one call at the input-token tier it will use. */
export function estimateCallCost(
  pricing: Pricing,
  inputTokens: number,
  outputTokens: number,
): number {
  const r = pricingAt(pricing, inputTokens);
  return (inputTokens / 1e6) * r.input + (outputTokens / 1e6) * r.output;
}
