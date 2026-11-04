/**
 * Semantic map: dirty tracking, bounded task prompt, validation, merge, and
 * freshness. The model call itself is covered by the eval replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRepoMap } from "../dist/map/deterministic.js";
import { readSemanticChanges, recordSemanticChange } from "../dist/map/changes.js";
import {
  buildSemanticTask,
  buildModuleIndex,
  clearSemanticDirty,
  isSemanticFresh,
  loadSemantic,
  loadSemanticOrDeterministic,
  markSemanticDirty,
  mergeModuleIndex,
  mergeSemantic,
  readSemanticDirty,
  renderModuleGraph,
  renderSemanticIndex,
  runSemanticModel,
  saveSemanticMap,
  searchSemantic,
} from "../dist/map/semantic.js";

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-semantic-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "src", "a.ts"), "export function alpha() {}\n", "utf8");
  writeFileSync(join(root, "lib", "b.ts"), "export function beta() {}\n", "utf8");
  return root;
}

test("semantic loading falls back to the cached deterministic map", async () => {
  const root = tempRepo();
  try {
    await buildRepoMap(root, { refresh: true });
    const semantic = loadSemanticOrDeterministic(root);
    assert.ok(semantic);
    assert.equal(semantic.model, "deterministic");
    assert.ok(semantic.modules.src);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic summaries prefer file documentation", async () => {
  const root = tempRepo();
  try {
    writeFileSync(
      join(root, "src", "a.ts"),
      "/** Authentication broker service. */\nexport function alpha() { return 1; }\n",
      "utf8",
    );
    const built = await buildRepoMap(root, { refresh: true });
    const index = buildModuleIndex(built.map);
    assert.match(index.modules.src.summary, /Authentication broker service/);
    assert.ok(index.modules.src.keywords?.includes("authentication"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module index and graph include deterministic import edges", async () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "src", "a.ts"), 'import { beta } from "../lib/b.js";\nexport function alpha() { return beta(); }\n', "utf8");
    const built = await buildRepoMap(root, { refresh: true });
    const index = buildModuleIndex(built.map);
    assert.ok(index.modules.src.deps?.includes("lib"));
    const graph = renderModuleGraph(built.map, index, "alpha");
    assert.match(graph, /src .*→.*lib/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the deterministic semantic map persists for the TUI and search", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    const index = buildModuleIndex(built.map);
    saveSemanticMap(root, index);
    const loaded = loadSemantic(root);
    assert.ok(loaded);
    assert.equal(loaded.model, "deterministic");
    assert.ok(isSemanticFresh(loaded, built.map, []));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic dirty tracking and freshness", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    markSemanticDirty(root, ["src/a.ts", "src/a.ts"]);
    assert.deepEqual(readSemanticDirty(root), ["src/a.ts"]);
    const task = buildSemanticTask({ root, map: built.map, existing: null, dirtyPaths: readSemanticDirty(root) });
    assert.match(task.prompt, /Modules: lib, src/);
    assert.match(task.prompt, /Dirty paths: src\/a\.ts/);
    const merged = mergeSemantic({
      root,
      map: built.map,
      existing: null,
      modules: task.modules,
      model: "test/model",
      response: JSON.stringify({
        modules: {
          src: { summary: "Source module.", keyFiles: ["src/a.ts"], editHints: ["Edit alpha here."] },
          lib: { summary: "Library module.", keyFiles: ["lib/b.ts"] },
        },
      }),
      dirtyPaths: readSemanticDirty(root),
    });
    assert.ok(merged);
    assert.equal(merged.modules.src.summary, "Source module.");
    assert.deepEqual(merged.modules.src.keyFiles, ["src/a.ts"]);
    assert.deepEqual(readSemanticDirty(root), []);
    const loaded = loadSemantic(root);
    assert.ok(loaded);
    assert.ok(isSemanticFresh(loaded, built.map, []));
    markSemanticDirty(root, ["src/a.ts"]);
    assert.equal(isSemanticFresh(loaded, built.map, readSemanticDirty(root)), false);
    clearSemanticDirty(root);
    assert.deepEqual(readSemanticDirty(root), []);
    assert.match(renderSemanticIndex(loaded), /<semantic-map>/);
    assert.match(renderSemanticIndex(loaded), /src — Source module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deterministic module index gives key files, symbols, and searchable keywords", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    const index = buildModuleIndex(built.map);
    assert.ok(index.modules.src);
    assert.ok(index.modules.src.keyFiles?.includes("src/a.ts"));
    assert.ok(index.modules.src.keywords?.includes("alpha"));
    assert.match(index.modules.src.summary, /alpha/);
    const matches = searchSemantic(index, "alpha");
    assert.equal(matches[0].module, "src");

    const overlay = {
      ...index,
      model: "test/model",
      generatedAt: "now",
      modules: {
        src: {
          summary: "Annotated source.",
          keyFiles: ["src/a.ts"],
          keywords: ["custom"],
        },
      },
    };
    const merged = mergeModuleIndex(index, overlay);
    assert.equal(merged.modules.src.summary, "Annotated source.");
    assert.ok(merged.modules.src.keywords?.includes("alpha"));
    assert.ok(merged.modules.src.keywords?.includes("custom"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large files get a searchable file entry with section keywords", async () => {
  const root = tempRepo();
  try {
    const body = ["/* ------------------------------------------------------------- runs */"];
    for (let i = 0; i < 420; i += 1) body.push(`const filler${i} = ${i};`);
    body.push("/* ------------------------------------------------- orchestrate keys */");
    writeFileSync(join(root, "src", "big.ts"), body.join("\n"), "utf8");
    const built = await buildRepoMap(root, { refresh: true });
    const index = buildModuleIndex(built.map);
    const entry = index.modules["src/big.ts"];
    assert.ok(entry, "large file has a file-level entry");
    assert.equal(entry.file, true);
    assert.ok(entry.keywords?.includes("orchestrate"));
    const matches = searchSemantic(index, "orchestrate run keys");
    assert.equal(matches[0].module, "src/big.ts");
    // Startup map stays module-level; file entries are search results.
    const rendered = renderSemanticIndex(index);
    assert.doesNotMatch(rendered, /src\/big\.ts —/);
    assert.match(rendered, /src —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic validation drops unknown paths and empty responses", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    const bad = mergeSemantic({
      root,
      map: built.map,
      existing: null,
      modules: ["src"],
      model: "test/model",
      response: JSON.stringify({
        modules: {
          src: { summary: "", keyFiles: ["missing.ts"] },
          unknown: { summary: "No such module." },
        },
      }),
      dirtyPaths: [],
    });
    assert.equal(bad, null);
    const partial = mergeSemantic({
      root,
      map: built.map,
      existing: null,
      modules: ["src"],
      model: "test/model",
      response: JSON.stringify({
        modules: { src: { summary: "Source.", keyFiles: ["missing.ts", "src/a.ts"] } },
      }),
      dirtyPaths: [],
    });
    assert.ok(partial);
    assert.deepEqual(partial.modules.src.keyFiles, ["src/a.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty-module refresh keeps existing annotations", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    const first = mergeSemantic({
      root,
      map: built.map,
      existing: null,
      modules: ["src", "lib"],
      model: "test/model",
      response: JSON.stringify({
        modules: {
          src: { summary: "Old source." },
          lib: { summary: "Old library." },
        },
      }),
      dirtyPaths: [],
    });
    assert.ok(first);
    markSemanticDirty(root, ["src/a.ts"]);
    const task = buildSemanticTask({ root, map: built.map, existing: first, dirtyPaths: readSemanticDirty(root) });
    assert.match(task.prompt, /Modules: src/);
    assert.doesNotMatch(task.prompt, /Modules: lib, src/);
    const next = mergeSemantic({
      root,
      map: built.map,
      existing: first,
      modules: task.modules,
      model: "test/model",
      response: JSON.stringify({ modules: { src: { summary: "New source." } } }),
      dirtyPaths: readSemanticDirty(root),
    });
    assert.ok(next);
    assert.equal(next.modules.src.summary, "New source.");
    assert.equal(next.modules.lib.summary, "Old library.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic search ranks keywords, key files, and summaries", () => {
  const semantic = {
    schema: 1,
    baseCommit: "",
    mapHash: "",
    generatedAt: "",
    model: "test/model",
    modules: {
      "src/context": {
        summary: "Run state, facts, artifacts, and prompt rendering.",
        keyFiles: ["src/context/state.ts", "src/context/render.ts"],
        keywords: ["state.md", "events.jsonl", "run state"],
      },
      "src/tools": {
        summary: "Tool implementations and schemas.",
        keyFiles: ["src/tools/index.ts"],
      },
    },
  };
  const matches = searchSemantic(semantic, "where is state.md written?");
  assert.equal(matches[0].module, "src/context");
  assert.ok(matches[0].score > 0);
  const index = renderSemanticIndex(semantic, 4_096, "state.md");
  assert.match(index, /src\/context — Run state/);
  assert.match(index, /files: src\/context\/state.ts/);
  assert.match(index, /<semantic-map>/);
});

test("runSemanticModel accumulates streamed text and usage", async () => {
  const fakeModels = {
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "hello " };
        yield { type: "text_delta", delta: "world" };
      },
      async result() {
        return {
          usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { total: 0.001 },
          },
          stopReason: "stop",
        };
      },
    }),
  };
  const result = await runSemanticModel(fakeModels, { id: "fake" }, "prompt");
  assert.equal(result.text, "hello world");
  assert.equal(result.usage.totalTokens, 12);
  assert.equal(result.stopReason, "stop");
});

test("change digest is bounded, path-filtered, and included in the task", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    recordSemanticChange(root, {
      runId: "r1",
      turn: 3,
      agent: "build",
      model: "test/model",
      path: "src/a.ts",
      tool: "edit",
      detail: "edited src/a.ts (1 replacement) · intent: cache the preview",
    });
    recordSemanticChange(root, {
      runId: "r1",
      turn: 4,
      agent: "build",
      path: "lib/b.ts",
      tool: "write",
      detail: "wrote 10 bytes",
    });
    assert.equal(readSemanticChanges(root).length, 2);
    const filtered = readSemanticChanges(root, ["src/a.ts"]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent, "build");
    assert.equal(filtered[0].model, "test/model");
    const task = buildSemanticTask({
      root,
      map: built.map,
      existing: null,
      dirtyPaths: ["src/a.ts"],
    });
    assert.match(task.prompt, /Recent changes/);
    assert.match(task.prompt, /build \(test\/model\) src\/a\.ts/);
    assert.doesNotMatch(task.prompt, /lib\/b\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a change during refresh keeps the path dirty", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    markSemanticDirty(root, ["src/a.ts"]);
    recordSemanticChange(root, {
      runId: "r1",
      turn: 1,
      agent: "build",
      path: "src/a.ts",
      tool: "edit",
      detail: "first edit",
      t: "2026-01-01T00:00:00.000Z",
    });
    const task = buildSemanticTask({
      root,
      map: built.map,
      existing: null,
      dirtyPaths: ["src/a.ts"],
    });
    recordSemanticChange(root, {
      runId: "r1",
      turn: 2,
      agent: "build",
      path: "src/a.ts",
      tool: "edit",
      detail: "second edit while the map call is in flight",
      t: "2099-01-01T00:00:00.000Z",
    });
    const merged = mergeSemantic({
      root,
      map: built.map,
      existing: null,
      modules: task.modules,
      model: "test/model",
      response: JSON.stringify({
        modules: { src: { summary: "Source." }, lib: { summary: "Library." } },
      }),
      dirtyPaths: ["src/a.ts"],
      changeCutoff: task.changeCutoff,
    });
    assert.ok(merged);
    assert.deepEqual(readSemanticDirty(root), ["src/a.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
