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

test("map extracts file docs and symbol docs from comments", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-docs-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "a.ts"),
      "/** File documentation for the module. */\n/** Adds two values. */\nexport function add(a: number, b: number) { return a + b; }\n",
      "utf8",
    );
    writeFileSync(
      join(root, "src", "a.py"),
      '"""Python module documentation."""\n\ndef compute():\n    """Computes the result."""\n    return 1\n',
      "utf8",
    );
    const built = await buildRepoMap(root, { refresh: true });
    const ts = built.map.files.find((file) => file.path === "src/a.ts");
    const py = built.map.files.find((file) => file.path === "src/a.py");
    assert.match(ts.doc, /File documentation/);
    assert.match(ts.symbols.find((symbol) => symbol.name === "add").doc, /Adds two values/);
    assert.match(py.doc, /Python module documentation/);
    assert.match(py.symbols.find((symbol) => symbol.name === "compute").doc, /Computes the result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("map resolves relative imports into module edges", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-imports-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n', "utf8");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const built = await buildRepoMap(root, { refresh: true });
    assert.deepEqual(built.map.files.find((file) => file.path === "src/a.ts").imports, ["src/b.ts"]);
    assert.equal(built.map.files.find((file) => file.path === "src/b.ts").imports, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("map extracts symbols and docs for Java, Ruby, and C", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-langs-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "Service.java"),
      "/** Service docs. */\npublic class Service {\n  /** Runs the service. */\n  public void run() {}\n}\n",
      "utf8",
    );
    writeFileSync(
      join(root, "src", "service.rb"),
      "# Ruby service docs.\nclass Service\n  # Runs it.\n  def run\n  end\nend\n",
      "utf8",
    );
    writeFileSync(
      join(root, "src", "add.c"),
      "/** Adds two numbers. */\nint add(int a, int b) { return a + b; }\n",
      "utf8",
    );
    const built = await buildRepoMap(root, { refresh: true });
    const java = built.map.files.find((file) => file.path === "src/Service.java");
    const ruby = built.map.files.find((file) => file.path === "src/service.rb");
    const c = built.map.files.find((file) => file.path === "src/add.c");
    assert.match(java.symbols.find((symbol) => symbol.name === "Service")?.doc ?? "", /Service docs/);
    assert.match(java.symbols.find((symbol) => symbol.name === "run")?.doc ?? "", /Runs the service/);
    assert.match(ruby.symbols.find((symbol) => symbol.name === "run")?.doc ?? "", /Runs it/);
    assert.match(c.symbols.find((symbol) => symbol.name === "add")?.doc ?? "", /Adds two numbers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("map resolves Python and Rust local imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-imports-lang-"));
  try {
    mkdirSync(join(root, "src", "pkg"), { recursive: true });
    mkdirSync(join(root, "src", "baz"), { recursive: true });
    writeFileSync(join(root, "src", "pkg", "a.py"), "from .b import value\n", "utf8");
    writeFileSync(join(root, "src", "pkg", "b.py"), "value = 1\n", "utf8");
    writeFileSync(join(root, "src", "foo.rs"), "mod bar;\nuse crate::baz::qux;\n", "utf8");
    writeFileSync(join(root, "src", "bar.rs"), "pub fn bar() {}\n", "utf8");
    writeFileSync(join(root, "src", "baz", "qux.rs"), "pub fn qux() {}\n", "utf8");
    const built = await buildRepoMap(root, { refresh: true });
    assert.deepEqual(built.map.files.find((file) => file.path === "src/pkg/a.py").imports, ["src/pkg/b.py"]);
    assert.deepEqual(built.map.files.find((file) => file.path === "src/foo.rs").imports, ["src/bar.rs", "src/baz/qux.rs"]);
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

test("a bare read of a large file returns a partial first page", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-large-"));
  try {
    const body = "export function big() {\n" + "  // filler\n".repeat(12000) + "}\n";
    writeFileSync(join(root, "big.ts"), body, "utf8");
    const read = readTool({ root, commands: CORE_COMMANDS });
    const result = await read.execute("1", { path: "big.ts" });
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /PARTIAL view: lines 1-/);
    assert.match(text, /continue with offset/);
    assert.match(text, /1: export function big/);
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
