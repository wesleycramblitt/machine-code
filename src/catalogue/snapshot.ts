/**
 * machine_code — committed model snapshot.
 *
 * `machine_code catalogue snapshot` writes a normalized view of the generated
 * catalogue to data/models.toml:
 *   [models."<canonical-id>"] — capabilities, modes, scores, benchmarks
 *   [models."<canonical-id>".offers."<provider/id>"] — pricing and provider
 *   overrides only (free flag, context/max-output limits, capability differences)
 *
 * The runtime catalogue stays denormalized (one row per provider offer) because
 * selection is per offer. This file is the committed, reviewable starting point.
 * `score_sources` only lists non-metadata axes; an absent axis means metadata.
 */
import { stringify } from "smol-toml";
import type { ModelKind } from "./kind.js";
import type { CatalogueDocument, CatalogueRow } from "./types.js";

interface SnapshotCapabilities {
  reasoning: boolean;
  tool_call: boolean;
  image: boolean;
  input: string[];
  output: string[];
}

interface SnapshotModel {
  name: string;
  family?: string;
  kind: ModelKind;
  coding: boolean;
  release_date?: string;
  context: number;
  max_output: number;
  capabilities: SnapshotCapabilities;
  modes: string[];
  scores: {
    reasoning: number;
    code: number;
    agentic: number;
    general: number;
    capability: number;
  };
  score_sources?: Partial<Record<"reasoning" | "code" | "agentic" | "general", "benchmark" | "curated">>;
  benchmarks?: Record<string, string | number>;
  provenance?: {
    benchmark?: string;
    estimated?: boolean;
    curated?: string[];
  };
  offers: Record<string, SnapshotOffer>;
}

interface SnapshotOffer {
  provider: string;
  id: string;
  pricing: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    tiers?: Array<{
      size: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
    }>;
  };
  free?: true;
  context?: number;
  max_output?: number;
  capabilities?: SnapshotCapabilities;
  modes?: string[];
  supported_parameters?: string[];
  tokens_per_second?: number;
  scores?: SnapshotModel["scores"];
}

const KIND_PRIORITY: ModelKind[] = [
  "video",
  "image",
  "audio",
  "embedding",
  "rerank",
  "guard",
  "other",
  "chat",
];

function canonicalKey(row: CatalogueRow): string {
  return row.canonicalID && row.canonicalID.includes("/") ? row.canonicalID : row.key;
}

function representative(rows: CatalogueRow[]): CatalogueRow {
  return [...rows].sort((a, b) => {
    if (b.scores.capability !== a.scores.capability) return b.scores.capability - a.scores.capability;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  })[0]!;
}

function union(values: string[][]): string[] {
  const out = new Set<string>();
  for (const list of values) for (const value of list) out.add(value);
  return [...out];
}

function maxOf(values: number[]): number {
  return values.length > 0 ? Math.max(...values) : 0;
}

function sameCapabilities(a: SnapshotCapabilities, b: SnapshotCapabilities): boolean {
  return (
    a.reasoning === b.reasoning &&
    a.tool_call === b.tool_call &&
    a.image === b.image &&
    a.input.join(",") === b.input.join(",") &&
    a.output.join(",") === b.output.join(",")
  );
}

function capabilitiesOf(row: CatalogueRow): SnapshotCapabilities {
  return {
    reasoning: row.capabilities.reasoning,
    tool_call: row.capabilities.toolCall,
    image: row.capabilities.image,
    input: [...row.capabilities.input],
    output: [...row.capabilities.output],
  };
}

function pricingOf(row: CatalogueRow): SnapshotOffer["pricing"] {
  const pricing: SnapshotOffer["pricing"] = {
    input: row.pricing.input,
    output: row.pricing.output,
    cache_read: row.pricing.cacheRead,
    cache_write: row.pricing.cacheWrite,
  };
  if (row.pricing.tiers && row.pricing.tiers.length > 0) {
    pricing.tiers = row.pricing.tiers.map((tier) => ({
      size: tier.size,
      input: tier.input,
      output: tier.output,
      cache_read: tier.cacheRead,
      cache_write: tier.cacheWrite,
    }));
  }
  return pricing;
}

function scoresOf(row: CatalogueRow): SnapshotModel["scores"] {
  return {
    reasoning: row.scores.reasoning,
    code: row.scores.code,
    agentic: row.scores.agentic,
    general: row.scores.general,
    capability: row.scores.capability,
  };
}

function scoresDiffer(a: SnapshotModel["scores"], b: SnapshotModel["scores"]): boolean {
  return (
    Math.abs(a.reasoning - b.reasoning) > 0.005 ||
    Math.abs(a.code - b.code) > 0.005 ||
    Math.abs(a.agentic - b.agentic) > 0.005 ||
    Math.abs(a.general - b.general) > 0.005 ||
    Math.abs(a.capability - b.capability) > 0.005
  );
}

function canonicalModel(rows: CatalogueRow[]): SnapshotModel {
  const first = representative(rows);
  const kinds = new Set(rows.map((row) => row.kind));
  const kind = KIND_PRIORITY.find((candidate) => kinds.has(candidate)) ?? first.kind ?? "chat";
  const capabilities: SnapshotCapabilities = {
    reasoning: rows.some((row) => row.capabilities.reasoning),
    tool_call: rows.some((row) => row.capabilities.toolCall),
    image: rows.some((row) => row.capabilities.image),
    input: union(rows.map((row) => row.capabilities.input)),
    output: union(rows.map((row) => row.capabilities.output)),
  };
  const scoreSources: SnapshotModel["score_sources"] = {};
  for (const axis of ["reasoning", "code", "agentic", "general"] as const) {
    const values = rows.map((row) => row.provenance.scoreSources?.[axis]).filter(Boolean);
    if (values.includes("curated")) scoreSources[axis] = "curated";
    else if (values.includes("benchmark")) scoreSources[axis] = "benchmark";
  }

  const benchmarks = rows.find((row) => row.benchmarks !== null)?.benchmarks;
  const benchmarkFields = benchmarks
    ? Object.fromEntries(Object.entries(benchmarks).filter(([, value]) => value !== undefined))
    : undefined;
  const curated = union(rows.map((row) => row.provenance.curated));

  return {
    name: first.name,
    ...(first.family ? { family: first.family } : {}),
    kind,
    coding: rows.every((row) => row.coding !== false),
    ...(first.releaseDate ? { release_date: first.releaseDate } : {}),
    context: maxOf(rows.map((row) => row.context)),
    max_output: maxOf(rows.map((row) => row.maxOutput)),
    capabilities,
    modes: union(rows.map((row) => row.modes)),
    scores: scoresOf(first),
    ...(Object.keys(scoreSources).length > 0 ? { score_sources: scoreSources } : {}),
    ...(benchmarkFields ? { benchmarks: benchmarkFields } : {}),
    provenance: {
      ...(benchmarks?.source ? { benchmark: benchmarks.source } : {}),
      estimated: rows.every((row) => row.provenance.estimated),
      ...(curated.length > 0 ? { curated } : {}),
    },
    offers: {},
  };
}

function offerFor(row: CatalogueRow, model: SnapshotModel): SnapshotOffer {
  const offer: SnapshotOffer = {
    provider: row.providerID,
    id: row.id,
    pricing: pricingOf(row),
  };
  if (row.free === true) offer.free = true;
  if (row.context !== model.context) offer.context = row.context;
  if (row.maxOutput !== model.max_output) offer.max_output = row.maxOutput;
  const capabilities = capabilitiesOf(row);
  if (!sameCapabilities(capabilities, model.capabilities)) offer.capabilities = capabilities;
  if (row.modes.join(",") !== model.modes.join(",")) offer.modes = [...row.modes];
  if (row.supportedParameters) offer.supported_parameters = [...row.supportedParameters];
  if (row.tokensPerSecond !== undefined) offer.tokens_per_second = row.tokensPerSecond;
  const scores = scoresOf(row);
  if (scoresDiffer(scores, model.scores)) offer.scores = scores;
  return offer;
}

/** Stable TOML shape: canonical models sorted by key, offers by provider key. */
export function modelSnapshotDocument(document: CatalogueDocument): Record<string, unknown> {
  const groups = new Map<string, CatalogueRow[]>();
  for (const row of document.models) {
    const key = canonicalKey(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const models: Record<string, SnapshotModel> = {};
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key)!;
    const model = canonicalModel(rows);
    for (const row of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      model.offers[row.key] = offerFor(row, model);
    }
    models[key] = model;
  }
  return {
    meta: {
      version: 2,
      generated_at: document.generatedAt,
      model_count: Object.keys(models).length,
      offer_count: document.models.length,
      note: "score_sources lists non-metadata axes only; absent = metadata prior",
    },
    models,
  };
}

export function serializeModelsSnapshot(document: CatalogueDocument): string {
  return (
    "# Generated by `machine_code catalogue snapshot`.\n" +
    "# Do not hand-edit this file; it is a committed snapshot of the generated\n" +
    "# catalogue. Put capability/pricing corrections in data/model-overrides.toml.\n" +
    "#\n" +
    "# Capabilities live once per canonical model. Provider offers carry pricing\n" +
    "# and only the fields that differ (free, context/max-output limits, modes).\n\n" +
    stringify(modelSnapshotDocument(document))
  );
}
