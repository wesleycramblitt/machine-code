/**
 * Catalogue query primitives shared by `models` and the TUI explorer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { filterModels, groupModels, siblingOffers, modelFit } from "../dist/catalogue/query.js";

function row(provider, id, overrides = {}) {
  return {
    key: `${provider}/${id}`,
    providerID: provider,
    id,
    name: id,
    family: overrides.family ?? "family",
    releaseDate: "2026-01-01",
    context: overrides.context ?? 100000,
    maxOutput: 8000,
    reasoning: true,
    toolCall: true,
    image: false,
    capabilities: { reasoning: true, toolCall: true, image: false, input: ["text"], output: ["text"], contextWindow: 100000, maxOutputTokens: 8000 },
    kind: "chat",
    coding: overrides.coding ?? true,
    modes: ["reasoning"],
    canonicalID: overrides.canonicalID ?? `canonical/${id}`,
    pricing: overrides.pricing ?? { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    benchmarks: null,
    scores: {
      reasoning: overrides.reasoning ?? 7,
      code: overrides.code ?? 7,
      agentic: overrides.agentic ?? 7,
      general: overrides.general ?? 7,
      capability: overrides.capability ?? 7,
    },
    provenance: { metadata: "generated", benchmark: null, estimated: false, estimatedFields: [], curated: [] },
    free: overrides.free,
  };
}

test("model search, provider/free/coding/axis filters, and sorting", () => {
  const rows = [
    row("openrouter", "alpha", { free: true, pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, code: 9, capability: 8 }),
    row("opencode", "beta", { code: 5, capability: 6, family: "other" }),
    row("openrouter", "image-gen", { coding: false, capability: 9 }),
  ];
  assert.deepEqual(filterModels(rows, { text: "alpha" }).map((m) => m.id), ["alpha"]);
  assert.deepEqual(filterModels(rows, { freeOnly: true }).map((m) => m.id), ["alpha"]);
  assert.deepEqual(filterModels(rows, { codingOnly: true }).map((m) => m.id).sort(), ["alpha", "beta"]);
  assert.deepEqual(filterModels(rows, { families: ["other"] }).map((m) => m.id), ["beta"]);
  assert.deepEqual(filterModels(rows, { minAxes: { code: 6 } }).map((m) => m.id).sort(), ["alpha", "image-gen"]);
  assert.deepEqual(filterModels(rows, { sort: "price-in" }).map((m) => m.id), ["alpha", "beta", "image-gen"]);
  assert.equal(filterModels(rows, { sort: "code" })[0].id, "alpha");
});

test("role weights affect fit, grouping, and sibling offers", () => {
  const a = row("openrouter", "alpha", { reasoning: 9, code: 5, agentic: 5, general: 5 });
  const b = row("opencode", "beta", { reasoning: 5, code: 9, agentic: 9, general: 5 });
  const fit = modelFit(a, { reasoning: 0.25, code: 0.5, agentic: 0.25, general: 0 });
  assert.ok(Math.abs(fit - 6) < 1e-9);
  const groups = groupModels([a, b], "provider");
  assert.deepEqual(groups.map((group) => group.key), ["opencode", "openrouter"]);
  const offers = siblingOffers([a, b, { ...a, key: "other/alpha", providerID: "other" }], a);
  assert.equal(offers.length, 2);
});
