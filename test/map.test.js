/**
 * Deterministic repository map: symbol extraction, render, outline, and the
 * surgical read/search paths built on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildRepoMap,
  outlineFile,
  rangeAround,
  renderMapIndex,
  renderRepoMap,
  symbolRange,
} from "../dist/map/deterministic.js";
import { readTool, searchTool } from "../dist/tools/index.js";
import { CORE_COMMANDS, runCommand } from "../dist/commands/registry.js";

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-map-"));
  writeFileSync(
    join(root, "sample.ts"),
    [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(root, "sample.py"), "def gamma():\n    return 3\n\nclass Delta:\n    pass\n", "utf8");
  writeFileSync(join(root, ".env"), "SECRET=1\n", "utf8");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "hidden.ts"), "export function hidden() {}\n", "utf8");
  return root;
}

test("map is deterministic and excludes secrets and ignored dirs", async () => {
  const root = tempRepo();
  try {
    const first = await buildRepoMap(root, { refresh: true });
    const second = await buildRepoMap(root, { refresh: true });
    assert.equal(JSON.stringify(first.map), JSON.stringify(second.map));
    assert.match(JSON.stringify(first.map), /sample\.ts/);
    assert.doesNotMatch(JSON.stringify(first.map), /\.env|node_modules|hidden\.ts/);
    assert.equal(first.map.files.find((file) => file.path === "sample.ts").symbols.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("map render filters by path and includes symbols", async () => {
  const root = tempRepo();
  try {
    const built = await buildRepoMap(root, { refresh: true });
    const all = renderRepoMap(built.map);
    assert.match(all, /sample\.ts \(8\) — alpha 1, beta 5/);
    const index = renderMapIndex(built.map);
    assert.match(index, /Repo map: 2 files/);
    assert.match(index, /core:map --path/);
    const filtered = renderRepoMap(built.map, { path: "sample.ts" });
    assert.match(filtered, /sample\.ts/);
    assert.doesNotMatch(filtered, /sample\.py/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outline, symbol ranges, and around resolve from the map", async () => {
  const root = tempRepo();
  try {
    const file = await outlineFile(root, "sample.ts");
    assert.ok(file);
    assert.deepEqual(file.symbols.map((symbol) => symbol.name), ["alpha", "beta"]);
    assert.deepEqual(symbolRange(file, "alpha"), { name: "alpha", kind: "function", start: 1, end: 3 });
    assert.equal(rangeAround(file, 2)?.name, "alpha");
    assert.equal(rangeAround(file, 5)?.name, "beta");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search outline/map/symbols and read symbol are surgical", async () => {
  const root = tempRepo();
  try {
    const search = searchTool({ root, commands: CORE_COMMANDS });
    const outline = await search.execute("1", { mode: "outline", path: "sample.ts" });
    const outlineText = outline.content.map((c) => c.text ?? "").join("\n");
    assert.match(outlineText, /sample\.ts \(8 lines\)/);
    assert.match(outlineText, /1 function alpha/);
    assert.match(outlineText, /5 function beta/);

    const map = await search.execute("2", { mode: "map", path: "sample.ts" });
    assert.match(map.content.map((c) => c.text ?? "").join("\n"), /sample\.ts \(8\) — alpha 1, beta 5/);

    const symbols = await search.execute("3", { mode: "symbols", pattern: "alpha" });
    assert.match(symbols.content.map((c) => c.text ?? "").join("\n"), /sample\.ts:1 function alpha/);

    const read = readTool({ root, commands: CORE_COMMANDS });
    const alpha = await read.execute("4", { path: "sample.ts", symbol: "alpha" });
    const alphaText = alpha.content.map((c) => c.text ?? "").join("\n");
    assert.match(alphaText, /sample\.ts:1-3 \(alpha\)/);
    assert.match(alphaText, /1: export function alpha/);
    assert.doesNotMatch(alphaText, /beta/);

    const around = await read.execute("5", { path: "sample.ts", around: 5 });
    const aroundText = around.content.map((c) => c.text ?? "").join("\n");
    assert.match(aroundText, /sample\.ts:5-7 \(beta\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare read of a large file returns the outline", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-large-"));
  try {
    const body = "export function big() {\n" + "  // filler\n".repeat(4000) + "}\n";
    writeFileSync(join(root, "big.ts"), body, "utf8");
    const read = readTool({ root, commands: CORE_COMMANDS });
    const result = await read.execute("1", { path: "big.ts" });
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /full read exceeds 24576 bytes/);
    assert.match(text, /1 function big/);
    assert.match(text, /Read a symbol or a range/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core:map status and render use the same cache", async () => {
  const root = tempRepo();
  try {
    const status = await runCommand("core:map", { action: "status" }, { root, commands: CORE_COMMANDS });
    assert.equal(status.isError, false);
    assert.match(status.text, /files: 2/);
    assert.match(status.text, /symbols: 4/);
    const render = await runCommand("core:map", { action: "render", path: "." }, { root, commands: CORE_COMMANDS });
    assert.equal(render.isError, false);
    assert.match(render.text, /sample\.ts/);
    assert.match(render.text, /sample\.py/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
