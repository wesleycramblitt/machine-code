/**
 * machine_code — generated catalogue shape (~/.machine_code/catalogue/models.json).
 */
import type { Benchmarks } from "./benchmarks.js";
import type { Pricing, Scores } from "./scoring.js";
import type { ModelKind } from "./kind.js";

export interface CatalogueRow {
  /** "provider/id". */
  key: string;
  providerID: string;
  id: string;
  name: string;
  family: string;
  releaseDate: string;
  context: number;
  maxOutput: number;
  reasoning: boolean;
  toolCall: boolean;
  image: boolean;
  /** Explicit capability facts (also kept flat above for compatibility). */
  capabilities: {
    reasoning: boolean;
    toolCall: boolean;
    image: boolean;
    input: string[];
    output: string[];
    contextWindow: number;
    maxOutputTokens: number;
  };
  /** Task class; only `chat` models are coding candidates. */
  kind: ModelKind;
  /** False for image/video/audio/embedding/rerank/guard models. */
  coding: boolean;
  /** Supported model modes/features (reasoning, tools, structured output, ...). */
  modes: string[];
  /** Raw upstream supported-parameter list when available. */
  supportedParameters?: string[];
  /** Priced at zero (free tier/credits); eligible in both tiers. */
  free?: boolean;
  canonicalID: string | null;
  pricing: Pricing;
  benchmarks: Benchmarks | null;
  scores: Scores;
  /** Curated throughput hint (tokens/sec); undefined = unknown. */
  tokensPerSecond?: number;
  provenance: {
    metadata: "generated";
    benchmark: string | null;
    /** True when scores come from metadata priors, not reported results. */
    estimated: boolean;
    estimatedFields: string[];
    /** Fields last set by curation.toml/model-overrides.toml, with their source note. */
    curated: string[];
    /** Per-axis provenance: reported benchmark, metadata prior, or authored. */
    scoreSources?: Partial<Record<"reasoning" | "code" | "agentic" | "general", "benchmark" | "metadata" | "curated">>;
  };
}

export interface CatalogueProvider {
  id: string;
  name: string;
  envKeys: string[];
  discovery?: string;
  baseUrl?: string;
  funded?: boolean;
  /** Billing/access modes: usage, subscription, free. */
  modes?: string[];
  billing?: {
    kind: string;
    monthlyUsd?: number;
    includedUsd?: number;
    fallback?: string;
  };
  /** Default effective-cost multiplier (machine config overrides). */
  costMultiplier?: number;
  modelCount?: number;
  /** Price range across this provider's catalogue rows ($/M). */
  pricing?: {
    minInput?: number;
    maxInput?: number;
    minOutput?: number;
    maxOutput?: number;
    freeModels?: number;
  };
}

export interface CatalogueDocument {
  version: 1;
  generatedAt: string;
  /** Provider definitions: env keys, endpoints, default funding. */
  providers: Record<string, CatalogueProvider>;
  sources: Array<{ id: string; url: string; models: number; note?: string }>;
  models: CatalogueRow[];
}
