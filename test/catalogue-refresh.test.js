/**
 * Catalogue refresh: bare live listings are skipped (no junk rows), vetoed
 * keys are reported, and provider assume_free zeroes pricing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applyAssumedFree, hasListingMetadata, refreshCatalogue } from "../dist/catalogue/refresh.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mc-refresh-"));
  const home = mkdtempSync(join(tmpdir(), "mc-refresh-home-"));
  return {
    root,
    home,
    layout: {
      home,
      machineConfig: "",
      curation: join(home, "curation.toml"),
      catalogueFile: join(home, "catalogue", "models.json"),
      repoRoot: root,
      repoDir: join(root, ".machine_code"),
      localDir: join(root, ".machine_code", "local"),
      policyFile: "",
      runsDir: join(root, ".machine_code", "local", "runs"),
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function fakeModel(provider, id, extra = {}) {
  return {
    id,
    provider,
    name: id,
    api: "openai-completions",
    type: "chat",
    reasoning: false,
    contextWindow: 32768,
    maxTokens: 4096,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    ...extra,
  };
}

test("hasListingMetadata rejects bare id-only listings", () => {
  assert.equal(hasListingMetadata({ contextWindow: 100, maxTokens: 100 }), true);
  assert.equal(hasListingMetadata({ contextWindow: 0, maxTokens: 0 }), false);
  assert.equal(hasListingMetadata({}), false);
});

test("refresh skips bare live rows and reports vetoed keys", async () => {
  const { layout, cleanup } = setup();
  try {
    writeFileSync(layout.curation, '[models."zz/vetoed"]\nveto = true\n', "utf8");
    const result = await refreshCatalogue(
      layout,
      [
        fakeModel("zz", "good"),
        { ...fakeModel("zz", "bare"), contextWindow: 0, maxTokens: 0 },
        fakeModel("zz", "vetoed"),
      ],
      {},
    );
    const keys = result.document.models.map((r) => r.key);
    assert.ok(keys.includes("zz/good"));
    assert.ok(!keys.includes("zz/bare"));
    assert.ok(!keys.includes("zz/vetoed"));
    assert.ok(result.warnings.some((w) => w.includes("zz/bare") && w.includes("skipped")));
    assert.deepEqual(result.curatedVetoKeys, ["zz/vetoed"]);
    assert.equal(result.curatedVetoes, 1);
  } finally {
    cleanup();
  }
});

test("live listings carry over static rows for live ids and drop dead ones", async () => {
  const { layout, cleanup } = setup();
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { buildCatalogueRow, assembleDocument } = await import("../dist/catalogue/refresh.js");
    const { buildCanonicalIndex } = await import("../dist/catalogue/canonical.js");
    const { BENCHMARKS } = await import("../dist/catalogue/benchmarks.js");
    const ctx = {
      orModels: new Map(),
      orBenchmarks: new Map(),
      canonicalIndex: buildCanonicalIndex(Object.keys(BENCHMARKS)),
      canonicalMeta: new Map(),
      curation: { models: new Map() },
      modelOverrides: new Map(),
    };
    const full = (id) => ({
      id,
      provider: "groq",
      name: id,
      api: "openai-completions",
      type: "chat",
      reasoning: false,
      contextWindow: 131072,
      maxTokens: 32768,
      input: ["text"],
      cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    });
    const doc = assembleDocument(
      [full("keep"), full("dead")].map((m) => buildCatalogueRow(m, ctx)).filter((r) => r !== null),
    );
    mkdirSync(join(layout.home, "catalogue"), { recursive: true });
    writeFileSync(layout.catalogueFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const bare = (id) => ({ ...full(id), contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const result = await refreshCatalogue(layout, [bare("keep"), bare("gone-new")], {
      liveListings: new Map([["groq", new Set(["groq/keep", "groq/gone-new"])]]),
    });
    const keys = result.document.models.map((r) => r.key);
    assert.ok(keys.includes("groq/keep"), "live static row carried over with metadata");
    assert.ok(!keys.includes("groq/dead"), "vanished row dropped");
    assert.ok(!keys.includes("groq/gone-new"), "bare live id not added as a row");
    assert.ok(result.warnings.some((w) => w.includes("groq/dead") || w.includes("dropped")));
    assert.ok(result.warnings.some((w) => w.includes("groq/gone-new") && w.includes("skipped")));
  } finally {
    cleanup();
  }
});

test("refresh prunes dead live-listed rows and carries over live static rows", async () => {
  const { layout, cleanup } = setup();
  try {
    const live = new Map([["groq", new Set(["groq/keep", "groq/carried", "groq/ghost"])]]);
    const first = await refreshCatalogue(
      layout,
      [fakeModel("groq", "keep"), fakeModel("groq", "dead"), fakeModel("groq", "carried")],
      { liveListings: live },
    );
    assert.deepEqual(
      first.document.models.map((r) => r.key).sort(),
      ["groq/carried", "groq/keep"],
    );
    assert.ok(first.warnings.some((w) => w.includes("groq/dead")));
    assert.ok(first.warnings.some((w) => w.includes("groq/ghost") && w.includes("skipped")));
  } finally {
    cleanup();
  }
});

test("applyAssumedFree zeroes only flagged providers", () => {
  const row = (providerID, key) => ({
    key,
    providerID,
    pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    free: false,
    provenance: { curated: [] },
  });
  const rows = [row("google", "google/a"), row("groq", "groq/b")];
  const touched = applyAssumedFree(rows, { google: { assumeFree: true } });
  assert.deepEqual(touched, ["google/a"]);
  assert.deepEqual(rows[0].pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(rows[0].free, true);
  assert.deepEqual(rows[0].provenance.curated, ["assume_free"]);
  assert.equal(rows[1].free, false);
  assert.equal(rows[1].pricing.input, 1);
  assert.deepEqual(applyAssumedFree(rows, {}), []);
});
