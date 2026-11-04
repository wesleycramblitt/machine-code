/**
 * Task preload inference: explicit task paths, inferred tests, and safety
 * filters. Preloaded files seed the working context, not the transcript.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractTaskPaths, inferPreloadFiles } from "../dist/context/preload.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mc-preload-"));
  mkdirSync(join(root, "src", "orchestrator"), { recursive: true });
  mkdirSync(join(root, "src", "context"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "orchestrator", "state.ts"), "export const state = 1;\n", "utf8");
  writeFileSync(join(root, "src", "context", "state.ts"), "export const context = 1;\n", "utf8");
  writeFileSync(join(root, "test", "orchestrator-state.test.js"), "test('state', () => {});\n", "utf8");
  writeFileSync(join(root, "test", "context-state.test.js"), "test('context', () => {});\n", "utf8");
  writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export const bad = 1;\n", "utf8");
  return root;
}

test("task preload keeps an explicit source and infers its test", () => {
  const root = fixture();
  try {
    const text = "Add a helper in `src/orchestrator/state.ts` and test it.";
    assert.deepEqual(extractTaskPaths(root, text), ["src/orchestrator/state.ts"]);
    assert.deepEqual(inferPreloadFiles(root, text, 4), [
      "src/orchestrator/state.ts",
      "test/orchestrator-state.test.js",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task preload reads packet context and ignores vendor paths", () => {
  const root = fixture();
  try {
    const text = JSON.stringify({
      context: ["src/context/state.ts", "node_modules/pkg/index.ts"],
      goal: "Add context lineage",
    });
    assert.deepEqual(inferPreloadFiles(root, text, 4), [
      "src/context/state.ts",
      "test/context-state.test.js",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task preload returns nothing when no task path exists", () => {
  const root = fixture();
  try {
    assert.deepEqual(inferPreloadFiles(root, "Improve the thing without naming a file.", 4), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
