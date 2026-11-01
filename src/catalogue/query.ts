/**
 * machine_code — catalogue search/filter/sort primitives shared by the CLI and
 * the TUI. Pure functions so the model explorer is testable without a terminal.
 */
import type { CapabilityAxis } from "../config.js";
import type { CatalogueRow } from "./types.js";

export type ModelSort =
  | "capability"
  | "fit"
  | "reasoning"
  | "code"
  | "agentic"
  | "general"
  | "context"
  | "price-in"
  | "price-out"
  | "name";

export interface ModelQuery {
  /** Free-text over key, name, family, provider, canonical id. */
  text?: string;
  providers?: ReadonlySet<string> | readonly string[];
  families?: ReadonlySet<string> | readonly string[];
  /** Restrict to zero-price offers. */
  freeOnly?: boolean;
  /** Restrict to coding candidates. */
  codingOnly?: boolean;
  /** Restrict to tool-calling models. */
  toolCall?: boolean;
  /** Restrict to models with at least this neutral capability. */
  minCapability?: number;
  /** Per-axis hard minimums. */
  minAxes?: Partial<Record<CapabilityAxis, number>>;
  /** Minimum role-weighted fit, when weights are supplied. */
  minFit?: number;
  weights?: Partial<Record<CapabilityAxis, number>>;
  sort?: ModelSort;
  descending?: boolean;
  limit?: number;
}

function asSet<T>(value: ReadonlySet<T> | readonly T[] | undefined): ReadonlySet<T> | undefined {
  if (!value) return undefined;
  return value instanceof Set ? value : new Set(value);
}

function normalizedWeights(weights?: Partial<Record<CapabilityAxis, number>>): Record<CapabilityAxis, number> | null {
  if (!weights) return null;
  const axes: CapabilityAxis[] = ["reasoning", "code", "agentic", "general"];
  const out = { reasoning: 0.25, code: 0.25, agentic: 0.25, general: 0.25 };
  let sum = 0;
  for (const axis of axes) {
    const value = weights[axis];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[axis] = value;
    sum += out[axis];
  }
  if (sum <= 0) return null;
  for (const axis of axes) out[axis] /= sum;
  return out;
}

export function modelFit(row: CatalogueRow, weights?: Partial<Record<CapabilityAxis, number>>): number {
  const w = normalizedWeights(weights);
  if (!w) return row.scores.capability;
  return (
    row.scores.reasoning * w.reasoning +
    row.scores.code * w.code +
    row.scores.agentic * w.agentic +
    row.scores.general * w.general
  );
}

export function isFreeModel(row: CatalogueRow): boolean {
  return row.free === true || (row.pricing.input === 0 && row.pricing.output === 0);
}

export function matchesModelText(row: CatalogueRow, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return (
    row.key.toLowerCase().includes(q) ||
    row.id.toLowerCase().includes(q) ||
    row.name.toLowerCase().includes(q) ||
    row.family.toLowerCase().includes(q) ||
    row.providerID.toLowerCase().includes(q) ||
    (row.canonicalID ?? "").toLowerCase().includes(q)
  );
}

function sortValue(row: CatalogueRow, sort: ModelSort, weights?: Partial<Record<CapabilityAxis, number>>): number | string {
  switch (sort) {
    case "fit":
      return modelFit(row, weights);
    case "reasoning":
      return row.scores.reasoning;
    case "code":
      return row.scores.code;
    case "agentic":
      return row.scores.agentic;
    case "general":
      return row.scores.general;
    case "context":
      return row.context;
    case "price-in":
      return row.pricing.input;
    case "price-out":
      return row.pricing.output;
    case "name":
      return row.name.toLowerCase();
    case "capability":
    default:
      return row.scores.capability;
  }
}

export function filterModels(rows: readonly CatalogueRow[], query: ModelQuery = {}): CatalogueRow[] {
  const providers = asSet(query.providers);
  const families = asSet(query.families);
  const filtered = rows.filter((row) => {
    if (providers && !providers.has(row.providerID)) return false;
    if (families && !families.has(row.family || "other")) return false;
    if (query.freeOnly && !isFreeModel(row)) return false;
    if (query.codingOnly && row.coding === false) return false;
    if (query.toolCall && !row.toolCall) return false;
    if (query.text && !matchesModelText(row, query.text)) return false;
    if (query.minCapability !== undefined && row.scores.capability < query.minCapability) return false;
    if (query.minFit !== undefined && modelFit(row, query.weights) < query.minFit) return false;
    for (const [axis, floor] of Object.entries(query.minAxes ?? {}) as Array<[CapabilityAxis, number]>) {
      if (floor > 0 && row.scores[axis] < floor) return false;
    }
    return true;
  });

  const sort = query.sort ?? "capability";
  const descending = query.descending ?? (sort !== "price-in" && sort !== "price-out" && sort !== "name");
  const sorted = [...filtered].sort((a, b) => {
    const av = sortValue(a, sort, query.weights);
    const bv = sortValue(b, sort, query.weights);
    let cmp = 0;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return descending ? -cmp : cmp;
  });
  return query.limit !== undefined ? sorted.slice(0, Math.max(0, query.limit)) : sorted;
}

export function groupModels(
  rows: readonly CatalogueRow[],
  group: "provider" | "family" | "none" = "provider",
): Array<{ key: string; rows: CatalogueRow[] }> {
  if (group === "none") return [{ key: "all", rows: [...rows] }];
  const map = new Map<string, CatalogueRow[]>();
  for (const row of rows) {
    const key = group === "provider" ? row.providerID : row.family || "other";
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({ key, rows: list }));
}

/** Every offer for the same canonical model, for the model detail pane. */
export function siblingOffers(rows: readonly CatalogueRow[], row: CatalogueRow): CatalogueRow[] {
  if (!row.canonicalID) return [row];
  return rows.filter((candidate) => candidate.canonicalID === row.canonicalID);
}

export function cheapestOffer(offers: readonly CatalogueRow[]): CatalogueRow | undefined {
  return [...offers].sort((a, b) => {
    const ac = a.pricing.input + a.pricing.output;
    const bc = b.pricing.input + b.pricing.output;
    return ac - bc || a.key.localeCompare(b.key);
  })[0];
}
