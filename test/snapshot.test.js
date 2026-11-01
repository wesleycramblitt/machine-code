/**
 * Committed model snapshot: deterministic per-owner model files and
 * per-provider/owner offer files, plus the shipped data/models and data/offers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { snapshotFiles } from "../dist/catalogue/snapshot.js";

function row(key, overrides = {}) {
  return {
    key,
    providerID: key.split("/")[0],
    id: key.slice(key.indexOf("/") + 1),
    name: `Model ${key}`,
    family: "Test",
    releaseDate: "2026-01-01",
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
    kind: "chat",
    coding: true,
    modes: ["reasoning", "tools"],
    free: false,
    canonicalID: `owner/${key.split("/")[1]}`,
    pricing: {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
      tiers: [{ size: 100_000, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0.3 }],
    },
    benchmarks: { source: "test", sweBench: 70 },
    scores: { reasoning: 8, code: 7, agentic: 6, general: 5, capability: 6.6 },
    tokensPerSecond: 42,
    provenance: {
      metadata: "generated",
      benchmark: "test",
      estimated: false,
      estimatedFields: [],
      curated: ["reasoning"],
      scoreSources: { reasoning: "benchmark", code: "metadata", agentic: "benchmark", general: "metadata" },
    },
    ...overrides,
  };
}

function parseSnapshot(doc) {
  const files = snapshotFiles(doc);
  const parsed = new Map(files.map((file) => [file.path, parse(file.content)]));
  return { files, parsed };
}

function readShipped() {
  const root = fileURLToPath(new URL("../data", import.meta.url));
  const models = {};
  const offers = {};
  for (const rel of readdirSync(join(root, "models"), { recursive: true })) {
    if (!rel.endsWith(".toml") || rel === "_meta.toml") continue;
    const parsed = parse(readFileSync(join(root, "models", rel), "utf8"));
    Object.assign(models, parsed.models ?? {});
  }
  for (const rel of readdirSync(join(root, "offers"), { recursive: true })) {
    if (!rel.endsWith(".toml")) continue;
    const parsed = parse(readFileSync(join(root, "offers", rel), "utf8"));
    Object.assign(offers, parsed.offers ?? {});
  }
  const meta = parse(readFileSync(join(root, "models", "_meta.toml"), "utf8")).meta;
  return { models, offers, meta };
}

test("snapshot splits models and offers deterministically", () => {
  const doc = {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    providers: {},
    sources: [],
    models: [row("p/b"), row("p/a")],
  };
  const first = snapshotFiles(doc);
  const second = snapshotFiles(doc);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((file) => file.path),
    ["models/_meta.toml", "models/owner.toml", "offers/p/owner.toml"],
  );
  const { parsed } = parseSnapshot(doc);
  const meta = parsed.get("models/_meta.toml").meta;
  assert.equal(meta.model_count, 2);
  assert.equal(meta.offer_count, 2);
  const models = parsed.get("models/owner.toml").models;
  assert.deepEqual(Object.keys(models), ["owner/a", "owner/b"]);
  const a = models["owner/a"];
  assert.equal(a.kind, "chat");
  assert.equal(a.coding, true);
  assert.deepEqual(a.capabilities.input, ["text"]);
  assert.equal(a.score_sources.reasoning, "benchmark");
  assert.equal(a.score_sources.code, undefined, "metadata axes are omitted");
  assert.equal(a.provenance.estimated, false);
  assert.equal(a.benchmarks.sweBench, 70);
  const offers = parsed.get("offers/p/owner.toml").offers;
  const offer = offers["p/a"];
  assert.equal(offer.model, "owner/a");
  assert.equal(offer.pricing.tiers[0].size, 100_000);
  assert.equal(offer.tokens_per_second, 42);
});

test("canonical model keeps capabilities once; offers keep only differences", () => {
  const paid = row("openrouter/owner/model", {
    canonicalID: "owner/model",
    context: 200_000,
    maxOutput: 32_000,
    pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  });
  const free = row("free/owner/model", {
    canonicalID: "owner/model",
    context: 64_000,
    maxOutput: 8_000,
    free: true,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const { parsed } = parseSnapshot({
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    providers: {},
    sources: [],
    models: [paid, free],
  });
  const meta = parsed.get("models/_meta.toml").meta;
  assert.equal(meta.model_count, 1);
  assert.equal(meta.offer_count, 2);
  const model = parsed.get("models/owner.toml").models["owner/model"];
  assert.equal(model.context, 200_000);
  assert.equal(model.max_output, 32_000);
  const paidOffers = parsed.get("offers/openrouter/owner.toml").offers;
  const freeOffers = parsed.get("offers/free/owner.toml").offers;
  assert.deepEqual(Object.keys(paidOffers), ["openrouter/owner/model"]);
  assert.deepEqual(Object.keys(freeOffers), ["free/owner/model"]);
  assert.equal(freeOffers["free/owner/model"].free, true);
  assert.equal(freeOffers["free/owner/model"].context, 64_000);
  assert.equal(freeOffers["free/owner/model"].max_output, 8_000);
  assert.equal(paidOffers["openrouter/owner/model"].context, undefined);
});

test("shipped data/models and data/offers are a valid, complete snapshot", () => {
  const { models, offers, meta } = readShipped();
  const keys = Object.keys(models);
  assert.equal(meta.model_count, keys.length);
  assert.ok(keys.length > 100, "snapshot contains the current catalogue");
  assert.equal(meta.offer_count, Object.keys(offers).length);
  const sample = models["openai/gpt-6-luna-pro"];
  assert.ok(sample, "known model is present");
  assert.equal(sample.kind, "chat");
  assert.equal(sample.coding, true);
  assert.ok(sample.capabilities.input.includes("text"));
  assert.ok(Array.isArray(sample.modes));
  assert.equal(typeof sample.scores.capability, "number");
  assert.ok(offers["openrouter/openai/gpt-6-luna-pro"]);
  const image = models["google/gemini-3-1-flash-lite-image"];
  assert.equal(image.kind, "image");
  assert.equal(image.coding, false);
});
