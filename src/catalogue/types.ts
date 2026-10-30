/**
 * machine_code — generated catalogue shape (~/.machine_code/catalogue/models.json).
 */
import type { Benchmarks } from "./benchmarks.js";
import type { Pricing, Scores } from "./scoring.js";

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
    /** Fields last set by curation.toml, with their source note. */
    curated: string[];
  };
}

export interface CatalogueDocument {
  version: 1;
  generatedAt: string;
  sources: Array<{ id: string; url: string; models: number; note?: string }>;
  models: CatalogueRow[];
}
