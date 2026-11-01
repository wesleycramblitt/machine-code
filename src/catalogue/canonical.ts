/**
 * machine_code — cross-provider canonical model resolution.
 *
 * Direct providers (OpenCode, Groq, Google) publish bare ids ("gpt-6-astra")
 * while the benchmark and OpenRouter catalogues key models by owner slug
 * ("openai/gpt-6-astra"). Without a canonical id those rows can only use
 * metadata priors. This module normalizes ids and builds a lookup from both
 * the full key and its model tail, marking tails that collide across owners
 * as ambiguous instead of guessing.
 */

const OWNER_ALIASES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  xiaomimimo: "xiaomi",
  minimaxai: "minimax",
  "moonshot-ai": "moonshotai",
};

/** Normalize case/punctuation and fold known organization aliases. */
export function normalizeModelSlug(value: string): string {
  let lower = value.toLowerCase();
  const slash = lower.indexOf("/");
  if (slash > 0) {
    const owner = lower.slice(0, slash);
    const alias = OWNER_ALIASES[owner];
    if (alias) lower = `${alias}${lower.slice(slash)}`;
  }
  return lower
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type CanonicalIndex = Map<string, string | null>;

/**
 * Index canonical keys for lookup. Each key is registered under its full
 * normalized slug and its normalized model tail. A tail shared by different
 * keys resolves to null (ambiguous) and is never used.
 */
export function buildCanonicalIndex(keys: Iterable<string>): CanonicalIndex {
  // `anthropic/claude-haiku-4-5` and `anthropic/claude-haiku-4.5` normalize to
  // the same identity. Keep the first spelling: callers order benchmark-backed
  // keys before OpenRouter aliases.
  const byFull = new Map<string, string>();
  for (const key of keys) {
    const full = normalizeModelSlug(key);
    if (full && !byFull.has(full)) byFull.set(full, key);
  }
  const index: CanonicalIndex = new Map();
  const register = (slug: string, key: string): void => {
    const existing = index.get(slug);
    if (existing === undefined || existing === key) {
      index.set(slug, key);
      return;
    }
    if (existing === null) return; // already genuinely ambiguous
    // OpenRouter exposes some models under both a bare id and an owner slug.
    // That is not a real conflict: the owner-qualified key is canonical.
    const existingQualified = existing.includes("/");
    const keyQualified = key.includes("/");
    if (keyQualified && !existingQualified) {
      index.set(slug, key);
      return;
    }
    if (!keyQualified && existingQualified) return;
    index.set(slug, null);
  };
  for (const key of byFull.values()) {
    const tail = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    for (const slug of new Set([normalizeModelSlug(key), normalizeModelSlug(tail)])) {
      if (slug) register(slug, key);
    }
  }
  return index;
}

/** Resolve a model id/name to a canonical key; ambiguous or missing → undefined. */
export function resolveCanonical(index: CanonicalIndex, ...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = index.get(normalizeModelSlug(candidate));
    if (resolved) return resolved;
  }
  return undefined;
}
