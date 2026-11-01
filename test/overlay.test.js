/**
 * Per-model overlay: authored axes/prices/modes win over generated data and
 * are marked curated; the composite is recomputed when axes change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyModelOverrides, loadModelOverrides } from "../dist/catalogue/overlay.js";

function row() {
  return {
    key: "p/model",
    providerID: "p",
    id: "model",
    name: "Model",
    family: "",
    releaseDate: "",
    context: 128_000,
    maxOutput: 16_000,
    reasoning: true,
    toolCall: true,
    image: false,
    capabilities: {
      reasoning: true,
      toolCall: true,
      image: false,
      input: ["text"],
      output: ["text"],
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
    },
    modes: ["reasoning", "tools"],
    canonicalID: "owner/model",
    pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    benchmarks: null,
    scores: { reasoning: 6, code: 6, agentic: 6, general: 6, capability: 6 },
    provenance: { metadata: "generated", benchmark: null, estimated: true, estimatedFields: [], curated: [] },
    free: false,
  };
}

test("overlay applies axes, composite, pricing, context, modes, and provenance", () => {
  const r = row();
  const changed = applyModelOverrides(r, {
    reasoning: 9.5,
    code: 8,
    agentic: 7,
    general: 6,
    input: 0.05,
    output: 0.5,
    context: 1_000_000,
    maxOutput: 128_000,
    modes: ["reasoning", "tools", "vision"],
  });
  assert.equal(r.scores.reasoning, 9.5);
  assert.equal(r.scores.code, 8);
  assert.ok(r.scores.capability > 6, "composite recomputed");
  assert.equal(r.pricing.input, 0.05);
  assert.equal(r.pricing.output, 0.5);
  assert.equal(r.context, 1_000_000);
  assert.equal(r.capabilities.contextWindow, 1_000_000);
  assert.equal(r.maxOutput, 128_000);
  assert.deepEqual(r.modes, ["reasoning", "tools", "vision"]);
  assert.equal(r.provenance.estimated, false);
  assert.ok(changed.includes("capability"));
  assert.ok(r.provenance.curated.includes("reasoning"));
});

test("explicit composite wins over recomputation; bad values are ignored", () => {
  const r = row();
  applyModelOverrides(r, { reasoning: 9, capability: 8.4, input: -1, general: 11 });
  assert.equal(r.scores.capability, 8.4);
  assert.equal(r.pricing.input, 1, "negative price ignored");
  assert.equal(r.scores.general, 6, "out-of-range axis ignored");
});

test("shipped model-overrides.toml starts with no overrides", () => {
  assert.equal(loadModelOverrides().size, 0);
});
