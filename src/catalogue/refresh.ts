/**
 * machine_code — catalogue refresh.
 *
 * Combines configured-provider metadata (pi-ai), OpenRouter catalog/benchmark
 * data, and dated curation into ~/.machine_code/catalogue/models.json.
 * Field precedence: generated → benchmark → measured → curated (measured
 * fields arrive with the spend ledger in M2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import type { Model, Api } from "@earendil-works/pi-ai";
import { benchmarksFor, BENCHMARKS, type Benchmarks } from "./benchmarks.js";
import { buildCanonicalIndex, normalizeModelSlug, resolveCanonical } from "./canonical.js";
import { loadProviderDefinitions } from "../data.js";
import { classifyModel } from "./kind.js";
import { applyModelOverrides, loadModelOverrides, type ModelOverride } from "./overlay.js";
import {
  fetchOpenRouterBenchmarks,
  fetchOpenRouterModels,
  normalizeOpenRouterSlug,
  writeOpenRouterBenchmarkSnapshot,
  OPENROUTER_MODELS_URL,
  type OpenRouterModelMeta,
} from "./openrouter.js";
import type { CanonicalIndex } from "./canonical.js";
import {
  capabilityFrom,
  scoresFromBenchmarks,
  scoresFromMetadata,
  type AxisScores,
} from "./scoring.js";
import type { CatalogueDocument, CatalogueRow } from "./types.js";
import type { Layout } from "../paths.js";

/* ------------------------------------------------------------- curation */

interface CurationEntry {
  veto?: boolean;
  toolCall?: boolean;
  capability?: number;
  tokensPerSecond?: number;
  note?: string;
  source?: string;
  date?: string;
}

export interface Curation {
  models: Map<string, CurationEntry>;
}

export function loadCuration(layout: Layout): Curation {
  const file = layout.curation;
  const models = new Map<string, CurationEntry>();
  if (!existsSync(file)) return { models };
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`curation.toml: invalid TOML: ${(error as Error).message}`);
  }
  const rawModels = (parsed as Record<string, unknown>).models;
  if (!rawModels || typeof rawModels !== "object") return { models };
  for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const num = (x: unknown) => {
      const n = typeof x === "number" ? x : Number(x);
      return Number.isFinite(n) ? n : undefined;
    };
    models.set(key, {
      veto: v.veto === true ? true : undefined,
      toolCall: typeof v.tool_call === "boolean" ? v.tool_call : undefined,
      capability: num(v.capability),
      tokensPerSecond: num(v.tokens_per_second),
      note: typeof v.note === "string" ? v.note : undefined,
      source: typeof v.source === "string" ? v.source : undefined,
      date: typeof v.date === "string" ? v.date : undefined,
    });
  }
  return { models };
}

/* ---------------------------------------------------------------- refresh */

/**
 * Rows the selector must never see:
 * - router/stealth pseudo-models (id "auto", OpenRouter's own namespace
 *   openrouter/...) route opaquely, which breaks deterministic selection;
 * - ":batch" variants are asynchronous batch endpoints, not interactive.
 *
 * ":free" variants are kept: they are real zero-price offers, visible in the
 * catalogue and only eligible when the caller explicitly chooses the free tier.
 */
export function isMetaModel(providerID: string, id: string): boolean {
  if (id === "auto") return true;
  if (id.endsWith(":batch")) return true;
  return providerID === "openrouter" && id.startsWith("openrouter/");
}

function canonicalFor(providerID: string, id: string): string | null {
  if (providerID === "openrouter") return normalizeOpenRouterSlug(id);
  if (id.includes("/")) {
    // Direct providers often append a date to the owner-qualified id
    // (DeepSeek-V4-Flash-0731, claude-...-20241022). Benchmark rows key the
    // base model; fold a trailing date only, never arbitrary version text.
    return id
      .replace(/-(?:19|20)\d{6}$/, "")
      .replace(/-(?:0[1-9]|1[0-2])\d{2}$/, "")
      .replace(/-(?:19|20)\d{2}$/, "");
  }
  return null; // tail-matching in benchmarksFor covers bare ids
}

function rowFromModel(model: Model<Api>): CatalogueRow {
  const providerID = String(model.provider);
  const id = model.id;
  const metaScores = scoresFromMetadata({
    id,
    name: model.name || id,
    family: "",
    releaseDate: "",
    knowledge: "",
    context: model.contextWindow,
    capabilities: { reasoning: model.reasoning, toolCall: true, image: model.input.includes("image") },
  });
  const classification = classifyModel(id, model.name || id, model.input, ["text"]);
  return {
    key: `${providerID}/${id}`,
    providerID,
    id,
    name: model.name || id,
    family: "",
    releaseDate: "",
    context: model.contextWindow,
    maxOutput: model.maxTokens,
    reasoning: model.reasoning,
    // pi-ai's model type carries no tool-use flag; OpenRouter's catalog
    // overlays the truth for its rows, curation corrects the rest.
    toolCall: true,
    image: model.input.includes("image"),
    kind: classification.kind,
    coding: classification.coding,
    capabilities: {
      reasoning: model.reasoning,
      toolCall: true,
      image: model.input.includes("image"),
      input: [...model.input],
      output: ["text"],
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
    },
    modes: [
      ...(model.reasoning ? ["reasoning"] : []),
      "tools",
      ...(model.input.includes("image") ? ["vision"] : []),
    ],
    canonicalID: canonicalFor(providerID, id),
    pricing: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
      ...(model.cost.tiers
        ? {
            tiers: model.cost.tiers.map((t) => ({
              size: t.inputTokensAbove,
              input: t.input,
              output: t.output,
              cacheRead: t.cacheRead,
              cacheWrite: t.cacheWrite,
            })),
          }
        : {}),
    },
    benchmarks: null,
    scores: { ...metaScores, capability: capabilityFrom(metaScores, model.contextWindow) },
    provenance: {
      metadata: "generated",
      benchmark: null,
      estimated: true,
      estimatedFields: ["reasoning", "code", "agentic", "general"],
      curated: [],
    },
  };
}

/**
 * Assemble the catalogue document from finished rows: stable sort, provider
 * pricing ranges, and per-provider source counts. Shared by full refresh
 * and live reconcile so both paths write the same shape.
 */
export function assembleDocument(rows: CatalogueRow[]): CatalogueDocument {
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const byProvider = new Map<string, number>();
    for (const row of rows) byProvider.set(row.providerID, (byProvider.get(row.providerID) ?? 0) + 1);
    const sources = [...byProvider.entries()].map(([id, count]) => ({
      id,
      url: id === "openrouter" ? OPENROUTER_MODELS_URL : `pi-ai generated catalog (${id})`,
      models: count,
    }));

    const definitions = loadProviderDefinitions();
    const providers = Object.fromEntries(
      Object.entries(definitions).map(([id, def]) => {
        const providerRows = rows.filter((row) => row.providerID === id);
        const priced = providerRows.filter((row) => !row.free && row.pricing.input >= 0);
        const input = priced.map((row) => row.pricing.input);
        const output = priced.map((row) => row.pricing.output);
        return [
          id,
          {
            id,
            name: def.name ?? id,
            envKeys: def.envKeys,
            ...(def.discovery ? { discovery: def.discovery } : {}),
            ...(def.baseUrl ? { baseUrl: def.baseUrl } : {}),
            ...(def.funded !== undefined ? { funded: def.funded } : {}),
            ...(def.modes ? { modes: def.modes } : {}),
            ...(def.billing ? { billing: def.billing } : {}),
            ...(def.costMultiplier !== undefined ? { costMultiplier: def.costMultiplier } : {}),
            modelCount: providerRows.length,
            ...(priced.length > 0
              ? {
                  pricing: {
                    minInput: Math.min(...input),
                    maxInput: Math.max(...input),
                    minOutput: Math.min(...output),
                    maxOutput: Math.max(...output),
                    freeModels: providerRows.length - priced.length,
                  },
                }
              : {}),
          },
        ];
      }),
    );

  const document: CatalogueDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    providers,
    sources,
    models: rows,
  };
  return document;
}

/**
 * Build one catalogue row from a live model, applying the same enrichment
 * as a full refresh: benchmark overlay, canonical resolution, metadata
 * scores, curation, and committed overrides. Returns null when a curation
 * veto excludes the row. Shared by full refresh and live reconcile so a
 * newly discovered model scores identically in both paths.
 */
export interface RowBuildContext {
  orModels: Map<string, OpenRouterModelMeta>;
  orBenchmarks: Map<string, Benchmarks>;
  canonicalIndex: CanonicalIndex;
  canonicalMeta: Map<string, OpenRouterModelMeta>;
  curation: Curation;
  modelOverrides: Map<string, ModelOverride>;
}

export function buildCatalogueRow(model: Model<Api>, ctx: RowBuildContext): CatalogueRow | null {
  const { orModels, orBenchmarks, canonicalIndex, canonicalMeta, curation, modelOverrides } = ctx;
  const row = rowFromModel(model);

// A curation veto is a catalogue correction: the row is not a candidate
// anywhere. (config.toml vetoes, by contrast, filter at selection time.)
const priorVeto =
  curation.models.get(row.key)?.veto === true ||
  curation.models.get(row.canonicalID ?? "")?.veto === true;
if (priorVeto) return null;

// OpenRouter metadata overlay (capability truth + release date).
const meta = row.providerID === "openrouter" ? orModels.get(row.id) : undefined;
if (meta) {
  row.toolCall = meta.capabilities.toolCall;
  row.image = meta.capabilities.image;
  row.reasoning = meta.capabilities.reasoning;
  row.family = meta.family;
  row.releaseDate = meta.releaseDate;
  row.canonicalID = meta.canonicalID;
  if (meta.context > 0) row.context = meta.context;
  if (meta.maxOutput > 0) row.maxOutput = meta.maxOutput;
  row.pricing = meta.pricing;
  row.capabilities = {
    reasoning: meta.capabilities.reasoning,
    toolCall: meta.capabilities.toolCall,
    image: meta.capabilities.image,
    input: meta.inputModalities,
    output: meta.outputModalities,
    contextWindow: row.context,
    maxOutputTokens: row.maxOutput,
  };
  const modes = new Set<string>();
  if (meta.capabilities.reasoning || meta.supportedParameters.includes("reasoning")) modes.add("reasoning");
  if (meta.capabilities.toolCall) modes.add("tools");
  if (meta.capabilities.image) modes.add("vision");
  if (meta.supportedParameters.includes("structured_outputs") || meta.supportedParameters.includes("response_format")) {
    modes.add("structured-output");
  }
  if (meta.supportedParameters.includes("logprobs")) modes.add("logprobs");
  if (meta.supportedParameters.includes("seed")) modes.add("seed");
  if (meta.moderated) modes.add("moderated");
  const classification = classifyModel(row.id, row.name, meta.inputModalities, meta.outputModalities);
  row.kind = classification.kind;
  row.coding = classification.coding;
  row.modes = [...modes];
  row.supportedParameters = meta.supportedParameters;
}

// Zero-price rows are retained but marked free. They are only eligible in
// the explicit `free` selection mode, so credits/free tiers (NVIDIA) are
// usable without silently entering normal paid selection.
row.free = row.pricing.input === 0 && row.pricing.output === 0;

// Direct providers: borrow the canonical owner slug so benchmark data is
// visible. This also normalizes provider-qualified ids ("qwen/qwen3.8-27b"
// → "qwen/qwen3-8-27b"). Ambiguous ids are left unresolved, never guessed.
if (row.providerID !== "openrouter") {
  const resolved = resolveCanonical(canonicalIndex, row.canonicalID ?? "", row.id, row.name);
  if (resolved) row.canonicalID = resolved;
}

// Benchmarks: curated first, then the OpenRouter map (direct, then tail).
let bench: Benchmarks | null = benchmarksFor(row.canonicalID ?? undefined);
if (!bench && orBenchmarks.size > 0) {
  bench =
    orBenchmarks.get(row.canonicalID ?? "") ??
    orBenchmarks.get(row.key) ??
    orBenchmarks.get(row.id) ??
    null;
  if (!bench && row.canonicalID) {
    const tail = row.canonicalID.split("/").pop() ?? "";
    for (const [k, v] of orBenchmarks) {
      if (k.split("/").pop() === tail) {
        bench = v;
        break;
      }
    }
  }
}
row.benchmarks = bench;

// Scores: reported axes win; unreported axes fall back to the derived
// prior for that same axis, so a missing benchmark is a gap, not a zero.
if (row.providerID !== "openrouter" && row.canonicalID) {
  const meta = canonicalMeta.get(normalizeModelSlug(row.canonicalID));
  if (meta) {
    if (!row.family) row.family = meta.family;
    if (!row.releaseDate) row.releaseDate = meta.releaseDate;
  }
}

// Missing benchmark axes fall back to metadata priors keyed by the
// canonical model, so a model scores the same on every provider.
const metadataScores: AxisScores = scoresFromMetadata({
  id: row.canonicalID ?? row.id,
  name: row.name,
  family: row.family,
  releaseDate: row.releaseDate,
  knowledge: "",
  context: row.context,
  capabilities: { reasoning: row.reasoning, toolCall: row.toolCall, image: row.image },
});
const axes = bench ? scoresFromBenchmarks(bench, metadataScores) : metadataScores;
const axisFields = {
  reasoning: ["aime", "gpqa", "math", "intelligenceIndex"],
  code: ["sweBench", "terminalBench", "liveCodeBench", "codingIndex"],
  agentic: ["tauBench", "terminalBench", "osworld", "agenticIndex"],
  general: ["mmluPro", "lmarena", "ifeval", "intelligenceIndex"],
} as const;
const scoreSources = Object.fromEntries(
  (Object.keys(axisFields) as Array<keyof typeof axisFields>).map((axis) => [
    axis,
    bench && axisFields[axis].some((field) => (bench as unknown as Record<string, unknown>)[field] !== undefined)
      ? "benchmark"
      : "metadata",
  ]),
) as Record<"reasoning" | "code" | "agentic" | "general", "benchmark" | "metadata">;
row.scores = { ...axes, capability: capabilityFrom(axes, row.context) };
row.provenance = {
  metadata: "generated",
  benchmark: bench?.source ?? null,
  estimated: bench === null,
  estimatedFields: bench === null ? ["reasoning", "code", "agentic", "general"] : [],
  curated: [],
  scoreSources,
};

// Curation overlay wins last.
const cur = curation.models.get(row.key) ?? curation.models.get(row.canonicalID ?? "");
if (cur) {
  const curated: string[] = [];
  if (cur.toolCall !== undefined && cur.toolCall !== row.toolCall) {
    row.toolCall = cur.toolCall;
    curated.push("tool_call");
  }
  if (cur.capability !== undefined && cur.capability !== row.scores.capability) {
    row.scores.capability = cur.capability;
    curated.push("capability");
  }
  if (cur.tokensPerSecond !== undefined) {
    row.tokensPerSecond = cur.tokensPerSecond;
    curated.push("tokens_per_second");
  }
  row.provenance.curated = curated;
}

const override = modelOverrides.get(row.key) ?? modelOverrides.get(row.canonicalID ?? "");
if (override) applyModelOverrides(row, override);
  return row;
}

export interface RefreshResult {
  document: CatalogueDocument;
  file: string;
  warnings: string[];
  /** Rows removed by curation vetoes. */
  curatedVetoes: number;
}

export async function refreshCatalogue(
  layout: Layout,
  models: ReadonlyArray<Model<Api>>,
  options: { openRouterKey?: string | undefined } = {},
): Promise<RefreshResult> {
  const warnings: string[] = [];

  // OpenRouter's public catalog: capability flags (incl. tool support) and
  // tiered pricing that pi-ai's generated catalog does not carry.
  let orModels = new Map<string, import("./openrouter.js").OpenRouterModelMeta>();
  if (models.some((m) => m.provider === "openrouter")) {
    try {
      orModels = await fetchOpenRouterModels();
    } catch (error) {
      warnings.push(`openrouter catalog fetch failed: ${(error as Error).message}`);
    }
  }

  // Benchmarks: OpenRouter's API (needs a key), with a snapshot kept so an
  // outage never zeroes the scores.
  let orBenchmarks = new Map<string, Benchmarks>();
  const snapshotFile = join(layout.home, "catalogue", "openrouter-benchmarks.json");
  if (options.openRouterKey) {
    try {
      orBenchmarks = await fetchOpenRouterBenchmarks(options.openRouterKey);
      if (orBenchmarks.size > 0) writeOpenRouterBenchmarkSnapshot(orBenchmarks, snapshotFile);
    } catch (error) {
      warnings.push(`openrouter benchmarks fetch failed: ${(error as Error).message}`);
    }
  }
  if (orBenchmarks.size === 0 && existsSync(snapshotFile)) {
    try {
      const raw = JSON.parse(readFileSync(snapshotFile, "utf8")) as { benchmarks?: Record<string, Benchmarks> };
      for (const [k, v] of Object.entries(raw.benchmarks ?? {})) orBenchmarks.set(k, v);
    } catch {
      // a broken snapshot is a gap, not a crash
    }
  }

  // Cross-provider canonical index: direct providers publish bare ids, so a
  // row like "gpt-6-astra" must resolve to "openai/gpt-6-astra" before the
  // benchmark lookup. Curated, snapshot, and OpenRouter ids all contribute.
  const canonicalKeys = new Set<string>([
    ...Object.keys(BENCHMARKS),
    ...orBenchmarks.keys(),
    ...orModels.keys(),
  ]);
  const canonicalIndex = buildCanonicalIndex(canonicalKeys);

  // Metadata priors use family/release date; borrow them from the OpenRouter
  // row for the same canonical model so direct providers score identically.
  const canonicalMeta = new Map<string, import("./openrouter.js").OpenRouterModelMeta>();
  for (const [id, meta] of orModels) {
    const slug = normalizeModelSlug(meta.canonicalID ?? id);
    if (slug && !canonicalMeta.has(slug)) canonicalMeta.set(slug, meta);
  }

  const curation = loadCuration(layout);
  const modelOverrides = loadModelOverrides();
  const rows: CatalogueRow[] = [];
  let curatedVetoes = 0;

  for (const model of models) {
    if (isMetaModel(String(model.provider), model.id)) continue;
    const row = buildCatalogueRow(model, {
      orModels,
      orBenchmarks,
      canonicalIndex,
      canonicalMeta,
      curation,
      modelOverrides,
    });
    if (!row) {
      curatedVetoes += 1;
      continue;
    }
    rows.push(row);
  }

  const document = assembleDocument(rows);
  mkdirSync(dirname(layout.catalogueFile), { recursive: true });
  writeFileSync(layout.catalogueFile, JSON.stringify(document, null, 2) + "\n", "utf8");
  return { document, file: layout.catalogueFile, warnings, curatedVetoes };
}
