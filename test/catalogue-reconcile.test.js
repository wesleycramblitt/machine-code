/**
 * Live catalogue reconcile: dynamic listings add/remove rows, stale or
 * disabled providers keep theirs, curation vetoes hold, OpenRouter works
 * from an injected catalog (no network in tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadCatalogue } from "../dist/catalogue/load.js";
import { reconcileCatalogue } from "../dist/catalogue/reconcile.js";
import { buildCatalogueRow, assembleDocument } from "../dist/catalogue/refresh.js";
import { buildCanonicalIndex } from "../dist/catalogue/canonical.js";
import { BENCHMARKS } from "../dist/catalogue/benchmarks.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mc-reconcile-"));
  const home = mkdtempSync(join(tmpdir(), "mc-reconcile-home-"));
  const layout = {
    home,
    machineConfig: join(home, "config.toml"),
    curation: join(home, "curation.toml"),
    catalogueFile: join(home, "catalogue", "models.json"),
    repoRoot: root,
    repoDir: join(root, ".machine_code"),
    localDir: join(root, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(root, ".machine_code", "local", "runs"),
  };
  return { root, home, layout };
}

function fakeModel(provider, id, extra = {}) {
  return {
    id,
    provider,
    name: id,
    api: "openai-completions",
    type: "chat",
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 2048,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...extra,
  };
}

function emptyCtx() {
  return {
    orModels: new Map(),
    orBenchmarks: new Map(),
    canonicalIndex: buildCanonicalIndex(Object.keys(BENCHMARKS)),
    canonicalMeta: new Map(),
    curation: { models: new Map() },
    modelOverrides: new Map(),
  };
}

function seedDoc(layout, rows) {
  const built = rows.map((m) => buildCatalogueRow(m, emptyCtx())).filter(Boolean);
  const doc = assembleDocument(built);
  mkdirSync(join(layout.home, "catalogue"), { recursive: true });
  writeFileSync(layout.catalogueFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return doc;
}

function fakeModels(providers) {
  // providers: { [id]: { models: [...] } }
  return {
    getProviders: () => Object.entries(providers).map(([id, p]) => ({
      id,
      getModels: () => {
        if (p.throw) throw new Error(p.throw);
        return p.models;
      },
    })),
  };
}

test("fresh dynamic listing adds new models and prunes vanished ones", async () => {
  const { layout } = setup();
  try {
    seedDoc(layout, [fakeModel("ollama", "keep"), fakeModel("ollama", "old")]);
    const models = fakeModels({ ollama: { models: [fakeModel("ollama", "keep"), fakeModel("ollama", "new")] } });
    const result = await reconcileCatalogue(layout, models, () => true, { openRouterModels: null });
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, ["ollama/new"]);
    assert.deepEqual(result.removed, ["ollama/old"]);
    const doc = loadCatalogue(layout.catalogueFile);
    const keys = doc.models.map((r) => r.key).sort();
    assert.ok(keys.includes("ollama/keep"));
    assert.ok(keys.includes("ollama/new"));
    assert.ok(!keys.includes("ollama/old"));
    // New rows carry metadata estimates, never benchmark claims.
    const added = doc.models.find((r) => r.key === "ollama/new");
    assert.equal(added.provenance.estimated, true);
  } finally {
    rmSync(layout.repoRoot, { recursive: true, force: true });
    rmSync(layout.home, { recursive: true, force: true });
  }
});

test("unfresh listings never delete rows", async () => {
  const { layout } = setup();
  try {
    seedDoc(layout, [fakeModel("ollama", "keep"), fakeModel("ollama", "stale")]);
    const before = readFileSync(layout.catalogueFile, "utf8");
    const models = fakeModels({ ollama: { models: [fakeModel("ollama", "keep")] } });
    const result = await reconcileCatalogue(layout, models, () => false, { openRouterModels: null });
    assert.equal(result.changed, false);
    assert.deepEqual(result.removed, []);
    assert.equal(readFileSync(layout.catalogueFile, "utf8"), before, "file untouched when nothing changed");
  } finally {
    rmSync(layout.repoRoot, { recursive: true, force: true });
    rmSync(layout.home, { recursive: true, force: true });
  }
});

test("disabled providers and static rows are left alone", async () => {
  const { layout } = setup();
  try {
    // openai is active but static: its rows must survive even though the
    // live list no longer contains them (only full refresh rewrites statics).
    // ghost-provider is absent from the collection entirely (as a disabled
    // provider would be): its rows must survive too.
    seedDoc(layout, [fakeModel("openai", "gone"), { ...fakeModel("ghost", "old"), provider: "ghost" }, fakeModel("ollama", "keep")]);
    const models = fakeModels({
      openai: { models: [] },
      ollama: { models: [fakeModel("ollama", "keep")] },
    });
    const result = await reconcileCatalogue(layout, models, () => true, { openRouterModels: null });
    assert.equal(result.changed, false);
    assert.deepEqual(result.removed, []);
    const doc = loadCatalogue(layout.catalogueFile);
    assert.ok(doc.models.some((r) => r.key === "openai/gone"));
    assert.ok(doc.models.some((r) => r.key === "ghost/old"));
  } finally {
    rmSync(layout.repoRoot, { recursive: true, force: true });
    rmSync(layout.home, { recursive: true, force: true });
  }
});

test("openrouter reconciles from the injected catalog", async () => {
  const { layout } = setup();
  try {
    seedDoc(layout, [
      { ...fakeModel("openrouter", "old-model"), name: "Old", contextWindow: 1000, maxTokens: 100 },
    ]);
    const meta = (id, name) => ({
      id,
      name,
      family: "test",
      releaseDate: "2026-01-01",
      context: 32000,
      maxOutput: 4000,
      canonicalID: `test/${id}`,
      capabilities: { reasoning: false, toolCall: true, image: false },
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: [],
      moderated: false,
      pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    const models = fakeModels({ openrouter: { models: [] } });
    const orModels = new Map([["new-model", meta("new-model", "New")]]);
    const result = await reconcileCatalogue(layout, models, () => false, { openRouterModels: orModels });
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, ["openrouter/new-model"]);
    assert.deepEqual(result.removed, ["openrouter/old-model"]);
    const doc = loadCatalogue(layout.catalogueFile);
    const added = doc.models.find((r) => r.key === "openrouter/new-model");
    assert.equal(added.family, "test", "overlay applied to reconciled rows");
    assert.equal(added.context, 32000);
  } finally {
    rmSync(layout.repoRoot, { recursive: true, force: true });
    rmSync(layout.home, { recursive: true, force: true });
  }
});

test("curation vetoes block re-adding removed models", async () => {
  const { layout } = setup();
  try {
    writeFileSync(layout.curation, `[models."ollama/banned"]\nveto = true\n`, "utf8");
    seedDoc(layout, [fakeModel("ollama", "keep")]);
    const models = fakeModels({ ollama: { models: [fakeModel("ollama", "keep"), fakeModel("ollama", "banned")] } });
    const result = await reconcileCatalogue(layout, models, () => true, { openRouterModels: null });
    assert.equal(result.added.includes("ollama/banned"), false);
    const doc = loadCatalogue(layout.catalogueFile);
    assert.ok(!doc.models.some((r) => r.key === "ollama/banned"));
  } finally {
    rmSync(layout.repoRoot, { recursive: true, force: true });
    rmSync(layout.home, { recursive: true, force: true });
  }
});

test("router and batch variants never become rows", async () => {
  const { layout } = setup();
  try {
    seedDoc(layout, [fakeModel("openrouter", "stale-model")]);
    const meta = (id) => ({
      id,
      name: id,
      family: "test",
      releaseDate: "2026-01-01",
      context: 8000,
      maxOutput: 1000,
      canonicalID: id,
      capabilities: { reasoning: false, toolCall: true, image: false },
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: [],
      moderated: false,
      pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const models = fakeModels({ openrouter: [] });
    // Upstream lists router/batch endpoints alongside models; none may land
    // in the catalogue, and stale ones already there are pruned.
    const orModels = new Map([
      ["openrouter/auto", meta("openrouter/auto")],
      ["some/batch-model:batch", meta("some/batch-model:batch")],
      ["real-model", meta("real-model")],
    ]);
    const result = await reconcileCatalogue(layout, models, () => true, { openRouterModels: orModels });
    assert.deepEqual(result.added, ["openrouter/real-model"]);
    assert.deepEqual(result.removed, ["openrouter/stale-model"]);
    const doc = loadCatalogue(layout.catalogueFile);
    const keys = doc.models.map((r) => r.key);
    assert.ok(!keys.some((k) => k.endsWith(":batch") || k === "openrouter/auto" || k.startsWith("openrouter/openrouter/")));
  } finally {
    rmSync(layout.repoRoot, { recursive: true, force: true });
    rmSync(layout.home, { recursive: true, force: true });
  }
});
