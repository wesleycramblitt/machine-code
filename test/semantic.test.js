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
import {
  buildSemanticTask,
  clearSemanticDirty,
  isSemanticFresh,
  loadSemantic,
  markSemanticDirty,
  mergeSemantic,
  readSemanticDirty,
  renderSemanticIndex,
  runSemanticModel,
} from "../dist/map/semantic.js";

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-semantic-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "src", "a.ts"), "export function alpha() {}\n", "utf8");
  writeFileSync(join(root, "lib", "b.ts"), "export function beta() {}\n", "utf8");
  return root;
}

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

test("runSemanticModel accumulates streamed text and usage", async () => {
  const fakeModels = {
    stream: () => ({
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
