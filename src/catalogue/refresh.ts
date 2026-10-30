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
import { benchmarksFor, type Benchmarks } from "./benchmarks.js";
import {
  fetchOpenRouterBenchmarks,
  fetchOpenRouterModels,
  normalizeOpenRouterSlug,
  writeOpenRouterBenchmarkSnapshot,
  OPENROUTER_MODELS_URL,
} from "./openrouter.js";
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
 * - ":free" variants are quota- and app-gated (OpenRouter rejects them for
 *   unknown apps); free tiers are deliberately not part of v1;
 * - ":batch" variants are asynchronous batch endpoints, not interactive.
 */
function isMetaModel(providerID: string, id: string): boolean {
  if (id === "auto") return true;
  if (id.endsWith(":free") || id.endsWith(":batch")) return true;
  return providerID === "openrouter" && id.startsWith("openrouter/");
}

function canonicalFor(providerID: string, id: string): string | null {
  if (providerID === "openrouter") return normalizeOpenRouterSlug(id);
  if (id.includes("/")) return id;
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

export interface RefreshResult {
  document: CatalogueDocument;
  file: string;
  warnings: string[];
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

  const curation = loadCuration(layout);
  const rows: CatalogueRow[] = [];

  for (const model of models) {
    if (isMetaModel(String(model.provider), model.id)) continue;
    const row = rowFromModel(model);

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
    }

    // Zero-price endpoints are promo/router/quota-gated (OpenRouter gates
    // them by app); v1 runs on real rate cards the spend ledger can meter.
    if (row.pricing.input === 0 && row.pricing.output === 0) continue;

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
    const metadataScores: AxisScores = scoresFromMetadata({
      id: row.id,
      name: row.name,
      family: row.family,
      releaseDate: row.releaseDate,
      knowledge: "",
      context: row.context,
      capabilities: { reasoning: row.reasoning, toolCall: row.toolCall, image: row.image },
    });
    const axes = bench ? scoresFromBenchmarks(bench, metadataScores) : metadataScores;
    row.scores = { ...axes, capability: capabilityFrom(axes, row.context) };
    row.provenance = {
      metadata: "generated",
      benchmark: bench?.source ?? null,
      estimated: bench === null,
      estimatedFields: bench === null ? ["reasoning", "code", "agentic", "general"] : [],
      curated: [],
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
      if (cur.veto === true) curated.push("veto");
      row.provenance.curated = curated;
    }

    rows.push(row);
  }

  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const byProvider = new Map<string, number>();
  for (const row of rows) byProvider.set(row.providerID, (byProvider.get(row.providerID) ?? 0) + 1);
  const sources = [...byProvider.entries()].map(([id, count]) => ({
    id,
    url: id === "openrouter" ? OPENROUTER_MODELS_URL : `pi-ai generated catalog (${id})`,
    models: count,
  }));

  const document: CatalogueDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources,
    models: rows,
  };
  mkdirSync(dirname(layout.catalogueFile), { recursive: true });
  writeFileSync(layout.catalogueFile, JSON.stringify(document, null, 2) + "\n", "utf8");
  return { document, file: layout.catalogueFile, warnings };
}
