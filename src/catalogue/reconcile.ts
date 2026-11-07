/**
 * machine_code — live catalogue reconcile.
 *
 * The catalogue file is the selector's source of truth, but model listings
 * are discovered live per run (Ollama /api/tags, OpenAI-compatible /models,
 * OpenRouter's public catalog). Without reconcile, adding or removing a model
 * is invisible until someone runs `catalogue refresh` by hand.
 *
 * reconcileCatalogue replays just the dynamic parts: for each provider whose
 * listing was freshly fetched this process, rows for vanished models are
 * dropped and rows for new models are built with the same enrichment as a
 * full refresh (benchmark overlay, canonical resolution, curation, committed
 * overrides). Anything that was not freshly listed is left untouched, so an
 * unreachable provider or a disabled one never loses rows. Static builtin
 * rows are also untouched — they change only with releases, via refresh.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { loadCatalogue } from "./load.js";
import {
  assembleDocument,
  buildCatalogueRow,
  hasListingMetadata,
  isMetaModel,
  loadCuration,
  type RowBuildContext,
} from "./refresh.js";
import { loadModelOverrides } from "./overlay.js";
import { BENCHMARKS, type Benchmarks } from "./benchmarks.js";
import { buildCanonicalIndex, normalizeModelSlug } from "./canonical.js";
import { fetchOpenRouterModels, type OpenRouterModelMeta } from "./openrouter.js";
import { fetchLiveListing } from "./discovery.js";
import { loadProviderDefinitions } from "../data.js";
import type { Layout } from "../paths.js";
import type { CatalogueRow } from "./types.js";

export interface ReconcileResult {
  changed: boolean;
  added: string[];
  removed: string[];
  warnings: string[];
}

function readBenchmarkSnapshot(home: string): Map<string, Benchmarks> {
  const out = new Map<string, Benchmarks>();
  const snapshotFile = join(home, "catalogue", "openrouter-benchmarks.json");
  if (!existsSync(snapshotFile)) return out;
  try {
    const raw = JSON.parse(readFileSync(snapshotFile, "utf8")) as { benchmarks?: Record<string, Benchmarks> };
    for (const [key, value] of Object.entries(raw.benchmarks ?? {})) out.set(key, value);
  } catch {
    // a broken snapshot is a gap, not a crash
  }
  return out;
}

/** Minimal Model for an OpenRouter catalog entry (the overlay fills the rest). */
function openRouterModel(id: string, meta: OpenRouterModelMeta): Model<Api> {
  return {
    id,
    provider: "openrouter",
    name: meta.name || id,
    api: "openai-completions",
    type: "chat",
    reasoning: meta.capabilities.reasoning,
    contextWindow: meta.context,
    maxTokens: meta.maxOutput,
    input: [...meta.inputModalities],
    cost: {
      input: meta.pricing.input,
      output: meta.pricing.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
  } as Model<Api>;
}

export async function reconcileCatalogue(
  layout: Layout,
  models: MutableModels,
  isFresh: (providerId: string) => boolean | undefined,
  opts: { openRouterModels?: Map<string, OpenRouterModelMeta> | null; liveListings?: Map<string, Set<string> | null> } = {},
): Promise<ReconcileResult> {
  const warnings: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const doc = loadCatalogue(layout.catalogueFile);
  if (!doc) return { changed: false, added, removed, warnings };

  const definitions = loadProviderDefinitions();
  const active = new Set<string>();
  const liveByProvider = new Map<string, Model<Api>[]>();
  try {
    for (const provider of models.getProviders()) {
      active.add(provider.id);
      try {
        liveByProvider.set(provider.id, [...provider.getModels()] as Model<Api>[]);
      } catch (error) {
        warnings.push(`${provider.id}: could not read live models (${(error as Error).message}); catalogue left alone`);
      }
    }
  } catch (error) {
    warnings.push(`could not list providers (${(error as Error).message}); catalogue left alone`);
    return { changed: false, added, removed, warnings };
  }

  const dynamicIds = new Set(
    Object.entries(definitions)
      .filter(([, def]) => def.discovery === "openai-compatible" || def.discovery === "ollama")
      .map(([id]) => id)
      .filter((id) => active.has(id)),
  );

  // OpenRouter's public catalog is keyless; a successful fetch is authoritative.
  // Pass opts.openRouterModels in tests; null skips OpenRouter entirely.
  let orModels: Map<string, OpenRouterModelMeta> | null = null;
  if (active.has("openrouter") && opts.openRouterModels !== null) {
    if (opts.openRouterModels !== undefined) {
      orModels = opts.openRouterModels;
    } else {
      try {
        orModels = await fetchOpenRouterModels();
      } catch (error) {
        warnings.push(`openrouter catalog fetch failed (${(error as Error).message}); openrouter rows left alone`);
      }
    }
  }

  const orBenchmarks = readBenchmarkSnapshot(layout.home);
  const canonicalKeys = new Set<string>([
    ...Object.keys(BENCHMARKS),
    ...orBenchmarks.keys(),
    ...(orModels ? orModels.keys() : []),
  ]);
  const canonicalIndex = buildCanonicalIndex(canonicalKeys);
  const canonicalMeta = new Map<string, OpenRouterModelMeta>();
  if (orModels) {
    for (const [id, meta] of orModels) {
      const slug = normalizeModelSlug(meta.canonicalID ?? id);
      if (slug && !canonicalMeta.has(slug)) canonicalMeta.set(slug, meta);
    }
  }
  const ctx: RowBuildContext = {
    orModels: orModels ?? new Map(),
    orBenchmarks,
    canonicalIndex,
    canonicalMeta,
    curation: loadCuration(layout),
    modelOverrides: loadModelOverrides(),
  };

  const existing = new Map(doc.models.map((row) => [row.key, row]));
  /** provider -> live keys, or null when the listing cannot be trusted. */
  const trusted = new Map<string, Set<string> | null>();

  for (const id of dynamicIds) {
    if (isFresh(id) !== true) {
      // Stale or never-attempted listings (unconfigured key, offline host)
      // keep their rows silently; the run's own discovery warnings, if any,
      // already reported the underlying failure.
      trusted.set(id, null);
      continue;
    }
    const live = liveByProvider.get(id) ?? [];
    trusted.set(id, new Set(live.filter((m) => !isMetaModel(String(m.provider), m.id)).map((m) => `${id}/${m.id}`)));
  }
  // Live listings (providers marked live_listings): membership is verified
  // against a fresh /models fetch instead of pi-ai's static baseline, so
  // retired models are pruned even though their static rows carry metadata.
  // Unknown live ids are only reported — never built without metadata.
  // Pass opts.liveListings in tests; production fetches (failures keep rows).
  for (const [id, def] of Object.entries(definitions)) {
    if (!def.liveListings || !def.baseUrl || !active.has(id)) continue;
    const override = opts.liveListings?.get(id);
    if (override !== undefined) {
      trusted.set(id, override);
      continue;
    }
    try {
      const fetched = await fetchLiveListing({ baseUrl: def.baseUrl, envKeys: def.envKeys }, id);
      if (!fetched.ok) {
        if (fetched.reason === "failed") {
          warnings.push(`live listing unavailable for ${id} (${fetched.error}); rows left alone`);
        }
        trusted.set(id, null);
      } else {
        trusted.set(id, new Set([...fetched.ids].filter((mid) => !isMetaModel(id, mid)).map((modelId) => `${id}/${modelId}`)));
      }
    } catch (error) {
      warnings.push(`live listing failed for ${id} (${error instanceof Error ? error.message : String(error)}); rows left alone`);
      trusted.set(id, null);
    }
  }
  if (orModels && active.has("openrouter")) {
    // A fetched public catalog is authoritative for removals.
    trusted.set("openrouter", new Set([...orModels.keys()].filter((id) => !isMetaModel("openrouter", id)).map((id) => `openrouter/${id}`)));
  }

  const keep: CatalogueRow[] = [];
  for (const row of doc.models) {
    const scope = trusted.get(row.providerID);
    if (scope === undefined) {
      // Not a reconciled provider: leave the row exactly as is.
      keep.push(row);
      continue;
    }
    if (scope === null) {
      keep.push(row);
      continue;
    }
    if (scope.has(row.key)) {
      keep.push(row);
      continue;
    }
    removed.push(row.key);
  }

  const openRouterNew = new Map<string, OpenRouterModelMeta>();
  if (orModels) {
    for (const [id, meta] of orModels) {
      const key = `openrouter/${id}`;
      if (!existing.has(key)) openRouterNew.set(id, meta);
    }
  }

  // New rows: dynamic live listings plus fresh OpenRouter catalog entries.
  // Meta models (routers, batch endpoints) are never rows, same as refresh.
  // Bare live listings (ids without pricing or context metadata) are skipped
  // with a warning instead of entering the catalogue as false-free rows.
  const candidates: Array<{ provider: string; model: Model<Api> }> = [];
  for (const id of dynamicIds) {
    const scope = trusted.get(id);
    if (scope === null || scope === undefined) continue;
    for (const model of liveByProvider.get(id) ?? []) {
      const key = `${id}/${model.id}`;
      if (existing.has(key) || isMetaModel(String(model.provider), model.id)) continue;
      if (!hasListingMetadata(model)) {
        warnings.push(`${key} listed live without pricing or context metadata; skipped (needs pi-ai update)`);
        continue;
      }
      candidates.push({ provider: id, model });
    }
  }
  if (orModels && active.has("openrouter")) {
    for (const [id, meta] of openRouterNew) {
      const key = `openrouter/${id}`;
      if (!existing.has(key) && !isMetaModel("openrouter", id)) {
        candidates.push({ provider: "openrouter", model: openRouterModel(id, meta) });
      }
    }
  }
  for (const { model } of candidates) {
    try {
      const row = buildCatalogueRow(model, ctx);
      if (row) {
        keep.push(row);
        added.push(row.key);
      }
    } catch (error) {
      warnings.push(`could not build row for ${model.provider}/${model.id}: ${(error as Error).message}`);
    }
  }

  // Live-listed ids with no row anywhere have no metadata to build from:
  // report them instead of guessing rows.
  {
    const known = new Set([...existing.keys(), ...added]);
    for (const [id, def] of Object.entries(definitions)) {
      if (!def.liveListings) continue;
      const scope = trusted.get(id);
      if (scope === null || scope === undefined) continue;
      for (const key of scope) {
        if (!known.has(key)) {
          known.add(key);
          warnings.push(`${key} listed live without catalogue metadata; skipped (needs pi-ai update)`);
        }
      }
    }
  }

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, added, removed, warnings };
  }
  const document = assembleDocument(keep);
  try {
    mkdirSync(dirname(layout.catalogueFile), { recursive: true });
    writeFileSync(layout.catalogueFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  } catch (error) {
    warnings.push(`could not write catalogue (${(error as Error).message})`);
    return { changed: false, added, removed, warnings };
  }
  return { changed: true, added, removed, warnings };
}
