#!/usr/bin/env node
// Determinism + regression check for task-file suggestions.
// Pure function of (map bytes, request): same inputs must yield same outputs.
// Run: node scripts/check-suggest.mjs (after npm run build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepoMap } from "../dist/map/deterministic.js";
import { suggestTaskFilesFromMap } from "../dist/map/suggest.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

test("suggest is deterministic across map rebuilds", async () => {
  const req =
    "From the runs page, issue deletion should be gated just like run deletion. " +
    "There should be a page that pops up with information and final confirmation so you have to hit D twice.";
  const a = await buildRepoMap(root, { refresh: true });
  const b = await buildRepoMap(root, { refresh: true });
  const ra = suggestTaskFilesFromMap(a.map, req, 3).map((e) => e.path);
  const rb = suggestTaskFilesFromMap(b.map, req, 3).map((e) => e.path);
  assert.deepEqual(ra, rb);
});

test("issue-deletion request surfaces the delete flow files", async () => {
  const req =
    "From the runs page, issue deletion should be gated just like run deletion. " +
    "There should be a page that pops up with information and final confirmation so you have to hit D twice.";
  const built = await buildRepoMap(root);
  assert.ok(built.map.files.length > 100, "map should cover the repo");
  const top = suggestTaskFilesFromMap(built.map, req, 5).map((e) => e.path);
  for (const want of ["src/tui/screens/delete.ts", "src/tui/screens/delete-keys.ts"]) {
    assert.ok(top.includes(want), `expected ${want} in top 5, got: ${top.join(", ")}`);
  }
});

test("empty request suggests nothing (never throws)", async () => {
  const built = await buildRepoMap(root);
  assert.deepEqual(suggestTaskFilesFromMap(built.map, "", 3), []);
  assert.deepEqual(suggestTaskFilesFromMap(built.map, "the and for", 3), []);
});
