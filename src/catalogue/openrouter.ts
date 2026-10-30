/**
 * machine_code — OpenRouter parsing and benchmark fetch.
 *
 * Copied from the model-selector OpenCode plugin (lib/fetch.ts) per plan.md.
 * Kept: model-catalog parsing (capabilities incl. tool support, tiered
 * pricing) and the benchmarks API parsing. Dropped: ollama, alibaba,
 * models.dev, free tiers, opencode-CLI reachability.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Benchmarks } from "./benchmarks.js";
import type { PriceBand, Pricing } from "./scoring.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_BENCHMARKS_URL = "https://openrouter.ai/api/v1/benchmarks";

/* ------------------------------------------------------------- models */

export interface OpenRouterModelMeta {
  id: string;
  name: string;
  family: string;
  releaseDate: string;
  context: number;
  maxOutput: number;
  canonicalID: string;
  capabilities: { reasoning: boolean; toolCall: boolean; image: boolean };
  pricing: Pricing;
}

interface OpenRouterModel {
  id?: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number;
  created?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    input_cache_read?: string | number;
    input_cache_write?: string | number;
    overrides?: Array<Record<string, unknown>>;
  };
  supported_parameters?: string[];
}

function numberOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function openRouterPrice(value: unknown): number {
  return Math.round(numberOf(value) * 1_000_000 * 1e12) / 1e12;
}

function hasOpenRouterPrice(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const n = Number(value);
  // Negative prices are sentinel values ("variable"/"see router"), not rates.
  return Number.isFinite(n) && n >= 0;
}

function openRouterPricing(model: OpenRouterModel): Pricing {
  const pricing = model.pricing ?? {};
  const rates = {
    input: openRouterPrice(pricing.prompt),
    output: openRouterPrice(pricing.completion),
    cacheRead: openRouterPrice(pricing.input_cache_read),
    cacheWrite: openRouterPrice(pricing.input_cache_write),
  };
  const tiers: PriceBand[] = (pricing.overrides ?? [])
    .map((override) => ({
      size: numberOf(override.min_prompt_tokens),
      input: openRouterPrice(override.prompt ?? pricing.prompt),
      output: openRouterPrice(override.completion ?? pricing.completion),
      cacheRead: openRouterPrice(override.input_cache_read ?? pricing.input_cache_read),
      cacheWrite: openRouterPrice(override.input_cache_write ?? pricing.input_cache_write),
    }))
    .filter((tier) => tier.size > 0)
    .sort((a, b) => a.size - b.size);
  return { ...rates, ...(tiers.length > 0 ? { tiers } : {}) };
}

export function normalizeOpenRouterSlug(slug: string): string {
  // anthropic/claude-opus-5.5-20260921 -> anthropic/claude-opus-5.5
  // Also normalize dot-version to dash-version so it matches curated
  // canonicals (claude-opus-5.5 vs claude-opus-5-5).
  return slug.replace(/-\d{8}$/, "").replace(/-20\d{6}$/, "").replace(/\./g, "-");
}

/** Convert OpenRouter's public model catalog into selector-ready metadata. */
export function parseOpenRouterModels(payload: unknown): Map<string, OpenRouterModelMeta> {
  const root = (payload ?? {}) as { data?: unknown };
  const out = new Map<string, OpenRouterModelMeta>();
  if (!Array.isArray(root.data)) return out;
  for (const raw of root.data) {
    if (!raw || typeof raw !== "object") continue;
    const model = raw as OpenRouterModel;
    const id = typeof model.id === "string" ? model.id : "";
    if (!id) continue;
    const input = model.architecture?.input_modalities ?? [];
    const output = model.architecture?.output_modalities ?? [];
    // The selector chooses chat models; leave image-generation and
    // embedding-only entries to dedicated tools.
    if (!input.includes("text") || !output.includes("text")) continue;
    if (!hasOpenRouterPrice(model.pricing?.prompt) || !hasOpenRouterPrice(model.pricing?.completion)) {
      continue;
    }
    const params = new Set(model.supported_parameters ?? []);
    const context = numberOf(model.context_length ?? model.top_provider?.context_length);
    const canonicalSlug = model.canonical_slug || id;
    const created = numberOf(model.created);
    out.set(id, {
      id,
      name: model.name || id,
      family: model.architecture?.tokenizer ?? id.split("/")[0] ?? "",
      releaseDate: created > 0 ? new Date(created * 1000).toISOString().slice(0, 10)! : "",
      context,
      maxOutput: numberOf(model.top_provider?.max_completion_tokens),
      canonicalID: normalizeOpenRouterSlug(canonicalSlug),
      capabilities: {
        reasoning:
          params.has("reasoning") || params.has("include_reasoning") || params.has("reasoning_effort"),
        toolCall: params.has("tools") || params.has("tool_choice"),
        image: input.includes("image"),
      },
      pricing: openRouterPricing(model),
    });
  }
  return out;
}

/* --------------------------------------------------------- benchmarks */

export function parseOpenRouterBenchmarks(payload: unknown): Map<string, Benchmarks> {
  const out = new Map<string, Benchmarks>();
  const root = (payload ?? {}) as Record<string, unknown>;
  const rows: unknown[] = Array.isArray(payload)
    ? (payload as unknown[])
    : Array.isArray(root.data)
      ? (root.data as unknown[])
      : Array.isArray(root.benchmarks)
        ? (root.benchmarks as unknown[])
        : [];
  // Merge multiple rows per model (different sources/categories) into one Benchmarks
  const merged = new Map<string, Benchmarks>();
  const getBench = (id: string): Benchmarks => {
    let b = merged.get(id);
    if (!b) {
      b = { source: "OpenRouter benchmarks" };
      merged.set(id, b);
    }
    return b;
  };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const rawId =
      (typeof r.model_permaslug === "string" && r.model_permaslug) ||
      (typeof r.model === "string" && r.model) ||
      (typeof r.canonicalID === "string" && r.canonicalID) ||
      (typeof r.id === "string" && r.id) ||
      (typeof r.slug === "string" && r.slug);
    if (!rawId) continue;
    const id = normalizeOpenRouterSlug(rawId);
    const bench = getBench(id);
    // Artificial Analysis indices (0-100)
    if (typeof r.intelligence_index === "number" && Number.isFinite(r.intelligence_index)) {
      const v = r.intelligence_index;
      if (bench.mmluPro === undefined || v > bench.mmluPro) bench.mmluPro = v;
      if (bench.gpqa === undefined || v > bench.gpqa) bench.gpqa = v;
    }
    if (typeof r.coding_index === "number" && Number.isFinite(r.coding_index)) {
      const v = r.coding_index;
      if (bench.sweBench === undefined || v > bench.sweBench) bench.sweBench = v;
      if (bench.liveCodeBench === undefined || v > bench.liveCodeBench) bench.liveCodeBench = v;
    }
    if (typeof r.agentic_index === "number" && Number.isFinite(r.agentic_index)) {
      const v = r.agentic_index;
      if (bench.tauBench === undefined || v > bench.tauBench) bench.tauBench = v;
      if (bench.terminalBench === undefined || v > bench.terminalBench) bench.terminalBench = v;
    }
    // OpenRouter direct accuracies (0-1 -> 0-100)
    if (r.source === "openrouter" && typeof r.benchmark_type === "string" && typeof r.accuracy === "number") {
      const pct = r.accuracy * 100;
      const bt = r.benchmark_type;
      if (bt === "gpqa_diamond" && (bench.gpqa === undefined || pct > bench.gpqa)) bench.gpqa = Math.round(pct * 10) / 10;
      else if (bt.startsWith("tau_bench") && (bench.tauBench === undefined || pct > bench.tauBench)) bench.tauBench = Math.round(pct * 10) / 10;
      else if (bt.includes("swe_bench") && (bench.sweBench === undefined || pct > bench.sweBench)) bench.sweBench = Math.round(pct * 10) / 10;
      else if (bt === "aime" && (bench.aime === undefined || pct > bench.aime)) bench.aime = Math.round(pct * 10) / 10;
    }
    // Design Arena Elo per category — keep max Elo as lmarena proxy
    if (r.source === "design-arena" && typeof r.elo === "number" && Number.isFinite(r.elo)) {
      const elo = r.elo;
      if (bench.lmarena === undefined || elo > bench.lmarena) bench.lmarena = elo;
    }
    // Generic fallback for direct benchmark fields
    const src = (r.scores && typeof r.scores === "object" ? r.scores : r) as Record<string, unknown>;
    for (const k of [
      "lmarena", "sweBench", "sweBenchMultimodal", "terminalBench", "tauBench",
      "aime", "gpqa", "liveCodeBench", "math", "mmluPro", "ifeval", "osworld", "mmmu",
    ] as const) {
      const v = src[k] ?? src[k.toLowerCase()] ?? (r.benchmarks as Record<string, unknown> | undefined)?.[k];
      if (typeof v === "number" && Number.isFinite(v) && (bench as unknown as Record<string, unknown>)[k] === undefined) {
        (bench as unknown as Record<string, unknown>)[k] = v;
      }
    }
    if (typeof r.source === "string" && bench.source === "OpenRouter benchmarks") {
      bench.source = `OpenRouter/${r.source}`;
    }
  }
  for (const [id, bench] of merged) {
    if (Object.keys(bench).length > 1) out.set(id, bench);
  }
  return out;
}

export function writeOpenRouterBenchmarkSnapshot(
  data: Map<string, Benchmarks>,
  path: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const obj = Object.fromEntries(data);
  writeFileSync(
    path,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), source: OPENROUTER_BENCHMARKS_URL, benchmarks: obj },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function getJSON(url: string, headers: Record<string, string>, timeoutMs = 20000): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

export async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelMeta>> {
  return parseOpenRouterModels(await getJSON(OPENROUTER_MODELS_URL, { accept: "application/json" }));
}

export async function fetchOpenRouterBenchmarks(openRouterKey: string): Promise<Map<string, Benchmarks>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${openRouterKey}`,
  };
  const urls = [
    OPENROUTER_BENCHMARKS_URL,
    `${OPENROUTER_BENCHMARKS_URL}?task_type=coding`,
    `${OPENROUTER_BENCHMARKS_URL}?task_type=intelligence`,
    `${OPENROUTER_BENCHMARKS_URL}?task_type=agentic`,
  ];
  for (const url of urls) {
    try {
      const payload = await getJSON(url, headers);
      const parsed = parseOpenRouterBenchmarks(payload);
      if (parsed.size > 0) return parsed;
    } catch {
      // try next url
    }
  }
  return new Map();
}
