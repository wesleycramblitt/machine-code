/**
 * Core tool ergonomics: batch command discovery and file-scoped text search.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { commandTool, editTool, globTool, grepTool, mapTool, readTool, searchTool, writeTool } from "../dist/tools/index.js";
import { contextTool } from "../dist/tools/context.js";
import { CORE_COMMANDS, runCommand } from "../dist/commands/registry.js";
import { RunStateStore } from "../dist/context/state.js";

test("command list returns every schema in one call", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "list" });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /core:status/);
  assert.match(text, /core:diff/);
  assert.match(text, /"path"/);
});

test("core:diff can compare a base ref to HEAD", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-diff-base-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.local");
    git("config", "user.name", "T");
    writeFileSync(join(root, "a.txt"), "one\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "one");
    writeFileSync(join(root, "a.txt"), "two\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "two");
    const result = await runCommand("core:diff", { base: "HEAD~1" }, { root, commands: CORE_COMMANDS });
    assert.notEqual(result.isError, true);
    assert.match(result.text, /\+two/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command list with a name describes it directly", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "list", name: "core:status" });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /core:status/);
});

test("command describe points at tools, not commands", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "describe", name: "read" });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /read is a tool, not a command/);
});

test("command describe reports a tool the role does not have", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS, tools: ["search", "glob"] });
  const result = await tool.execute("id", { action: "describe", name: "read" });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /read is a tool, but this role does not have it/);
  assert.match(text, /search, glob/);
});

test("unknown command suggests the closest name", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "run", name: "core:statu", args: {} });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /unknown command: core:statu/);
  assert.match(text, /Did you mean core:status\?/);
});

test("command accepts the {command, args} spelling", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const prepared = tool.prepareArguments({ command: "core:status", args: {} });
  assert.equal(prepared.name, "core:status");
  assert.equal(prepared.action, "run");
  assert.equal(prepared.command, undefined);
});

test("read refuses secret files", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-secret-"));
  try {
    writeFileSync(join(root, ".env"), "TOKEN=SECRET\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: ".env" });
    assert.equal(result.isError, true);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /refusing to read a secret file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search graph renders module import edges", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-graph-"));
  try {
    mkdirSync(join(root, "src", "a"), { recursive: true });
    mkdirSync(join(root, "src", "b"), { recursive: true });
    writeFileSync(join(root, "src", "a", "index.ts"), 'import { b } from "../b/index.js";\nexport const a = b;\n', "utf8");
    writeFileSync(join(root, "src", "b", "index.ts"), "export const b = 1;\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "graph", pattern: "a" });
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /<module-graph>/);
    assert.match(text, /src\/a .*→.*src\/b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic search returns module summaries and key files", async () => {
  const semantic = {
    schema: 1,
    baseCommit: "",
    mapHash: "",
    generatedAt: "",
    model: "test/model",
    modules: {
      "src/context": {
        summary: "Run state, facts, artifacts, and prompt rendering.",
        keyFiles: ["src/context/state.ts"],
        keywords: ["state.md"],
      },
    },
  };
  const tool = searchTool({
    root: process.cwd(),
    commands: CORE_COMMANDS,
    semantic: () => semantic,
  });
  const result = await tool.execute("id", { mode: "semantic", pattern: "state.md" });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /src\/context/);
  assert.match(text, /files: src\/context\/state\.ts/);
});

test("auto is the default; pattern plus file searches text", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-"));
  try {
    writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n', "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "package.json", pattern: "scripts" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /package\.json:1/);
    assert.match(text, /scripts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default bare identifier locates definitions and references", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-sym-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src.ts"), "export function alpha() { return 1; }\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { pattern: "alpha" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /definitions:/);
    assert.match(text, /src\.ts:1/);
    assert.match(text, /alpha/);
    assert.match(text, /references:/);
    assert.match(text, /next: read \{ "path": "src\.ts", "around": 1 \}/);
    assert.doesNotMatch(text, /no symbols/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default bare file path returns its outline", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-outline-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src.ts"), "export function alpha() { return 1; }\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "src.ts" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /alpha/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locate mode annotates references with the enclosing symbol", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-locate-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const lines = [
      "export function outer() {",
      "  const target = 1;",
      "  return target;",
      "}",
      "",
      "export function other() {",
      "  return 0;",
      "}",
    ];
    writeFileSync(join(root, "a.ts"), lines.join("\n") + "\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "locate", pattern: "target" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /0 definition\(s\), 2 reference\(s\)/);
    assert.doesNotMatch(text, /definitions:/);
    assert.match(text, /\[in outer\]/);
    assert.match(text, /next: read \{ "path": "a\.ts", "around": 2 \}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit symbols with no hits points at locate", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-symempty-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src.ts"), "export function alpha() { return 1; }\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "symbols", pattern: "zzz-no-such-symbol" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /no symbols matching "zzz-no-such-symbol"/);
    assert.match(text, /try map \{ "action": "locate", "pattern": "zzz-no-such-symbol" \}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text with no matches points at locate", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-nomatch-"));
  try {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "text", pattern: "zzz-no-such-string" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /no matches for "zzz-no-such-string"/);
    assert.match(text, /try grep \{ "pattern": "zzz-no-such-string", "ignoreCase": true \}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped edit miss returns the current scope text", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-miss-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(
      join(root, "a.ts"),
      "export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 2;\n}\n",
      "utf8",
    );
    const tool = editTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", {
      path: "a.ts",
      symbol: "foo",
      oldString: "  return 999;",
      newString: "  return 3;",
    });
    assert.equal(result.isError, true);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /no match in a\.ts \(symbol foo\)/);
    assert.match(text, /Closest current text:/);
    assert.match(text, /return 1;/);
    assert.doesNotMatch(text, /return 2;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscoped edit miss re-anchors at the closest current text", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-unscoped-miss-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n", "utf8");
    const tool = editTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", {
      path: "a.ts",
      oldString: "  return 999;",
      newString: "  return 2;",
    });
    assert.equal(result.isError, true);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /no match in a\.ts/);
    assert.match(text, /Closest current text:/);
    assert.match(text, /return 1;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit ignores copied line numbers and indentation drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-fuzzy-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n", "utf8");
    const tool = editTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", {
      path: "a.ts",
      oldString: "1: export function foo() {\n2:     return 1;\n3: }",
      newString: "export function foo() {\n  return 2;\n}",
    });
    assert.notEqual(result.isError, true);
    assert.match(readFileSync(join(root, "a.ts"), "utf8"), /return 2;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read around a huge symbol returns a bounded page", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-around-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const body = Array.from({ length: 300 }, (_, index) => `  const v${index} = ${index};`).join("\n");
    writeFileSync(join(root, "a.ts"), `export function huge() {\n${body}\n}\n`, "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "a.ts", around: 150 });
    assert.notEqual(result.isError, true);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /around 150/);
    assert.match(text, /is 302 lines/);
    const numbered = text.split("\n").filter((line) => /^\d+:/.test(line));
    assert.ok(numbered.length <= 45, `window is bounded (got ${numbered.length} lines)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a typed command rejects shell-shaped args", async () => {
  const result = await runCommand(
    "core:show",
    { cmd: "git show 03ad06d" },
    { root: process.cwd(), commands: CORE_COMMANDS },
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /unknown cmd/);
  assert.match(result.text, /no shell/);
});

test("path with line and column answers at that position", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-pos-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src.ts"), "export function alpha() { return 1; }\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "src.ts", line: 1, column: 16 });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /src\.ts:1:16/);
    assert.match(text, /alpha/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locate answers references when no symbol matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-fallback-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src.ts"), 'const filter = "cwd";\nconsole.log(filter);\n', "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { pattern: "cwd" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /src\.ts:1/);
    assert.doesNotMatch(text, /no symbols/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("map exposes structure actions with a clear routing description", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-map-tool-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "alpha.ts"), "export function alpha() { return 1; }\n", "utf8");
    writeFileSync(join(root, "src", "beta.ts"), "export function beta() { return alpha(); }\n", "utf8");
    const tool = mapTool({ root, commands: CORE_COMMANDS });
    assert.match(tool.description, /code structure/);
    assert.match(tool.description, /Use grep for text/);

    const outline = await tool.execute("id", { action: "outline", path: "src/alpha.ts" });
    assert.match(outline.content.map((c) => c.text ?? "").join("\n"), /alpha/);

    const symbols = await tool.execute("id", { action: "symbols", pattern: "alpha" });
    assert.match(symbols.content.map((c) => c.text ?? "").join("\n"), /src\/alpha\.ts/);

    const locate = await tool.execute("id", { action: "locate", pattern: "alpha" });
    assert.match(locate.content.map((c) => c.text ?? "").join("\n"), /alpha/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob lists matching repo-relative paths and honors excludes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-glob-"));
  try {
    mkdirSync(join(root, "src", "tui"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src", "tui", "b.ts"), "export const b = 2;\n", "utf8");
    writeFileSync(join(root, "src", "notes.md"), "# notes\n", "utf8");
    writeFileSync(join(root, "node_modules", "pkg", "hidden.ts"), "export const h = 3;\n", "utf8");
    const tool = globTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { pattern: "src/**/*.ts" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /src\/a\.ts/);
    assert.match(text, /src\/tui\/b\.ts/);
    assert.doesNotMatch(text, /notes\.md/);
    assert.doesNotMatch(text, /node_modules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep is literal, case-insensitive on request, and glob-scoped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-grep-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "const GRAY = 1;\nconst other = 2;\n", "utf8");
    writeFileSync(join(root, "src", "b.md"), "gray is a color\n", "utf8");
    const tool = grepTool({ root, commands: CORE_COMMANDS });
    const insensitive = await tool.execute("id", { pattern: "gray", ignoreCase: true });
    const insensitiveText = insensitive.content.map((c) => c.text ?? "").join("\n");
    assert.match(insensitiveText, /src\/a\.ts:1/);
    assert.match(insensitiveText, /src\/b\.md:1/);

    const scoped = await tool.execute("id", { pattern: "gray", ignoreCase: true, glob: "*.ts" });
    const scopedText = scoped.content.map((c) => c.text ?? "").join("\n");
    assert.match(scopedText, /src\/a\.ts/);
    assert.doesNotMatch(scopedText, /src\/b\.md/);

    const missing = await tool.execute("id", { pattern: "zzz-nope" });
    const missingText = missing.content.map((c) => c.text ?? "").join("\n");
    assert.match(missingText, /no matches for "zzz-nope"/);
    assert.match(missingText, /ignoreCase: true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text search carries context lines with each hit", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-ctx-"));
  try {
    const lines = ["line one", "line two", "needle here", "line four", "line five"];
    writeFileSync(join(root, "a.txt"), lines.join("\n") + "\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "text", pattern: "needle" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /a\.txt:3:needle here/);
    assert.match(text, /line two/);
    assert.match(text, /line four/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text hits in a huge file name a read-around line", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-big-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const lines = Array.from(
      { length: 900 },
      (_, i) => `const pad${i} = "padding line number ${i} to pass forty bytes easily";`,
    );
    lines[450] = 'const target = "needle";';
    writeFileSync(join(root, "big.ts"), lines.join("\n") + "\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "text", pattern: "needle" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /big\.ts:451/);
    assert.match(text, /"around": 451/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text hits in a small file carry no large-file hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-small-"));
  try {
    writeFileSync(join(root, "a.txt"), "needle\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "text", pattern: "needle" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /needle/);
    assert.doesNotMatch(text, /around/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read uses a symbol range even when offset or limit is also passed", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-symbol-"));
  try {
    writeFileSync(
      join(root, "a.ts"),
      "export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 2;\n}\n",
      "utf8",
    );
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "a.ts", symbol: "foo", limit: 1 });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /export function foo/);
    assert.doesNotMatch(text, /export function bar/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read treats strict-schema null optionals as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-null-"));
  try {
    writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "a.ts", symbol: "foo", around: null, offset: null, limit: null });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /export function foo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read falls back to the first match for a nested symbol", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-nested-"));
  try {
    const lines = ["export function outer() {", ...Array.from({ length: 30 }, (_, i) => `  const pad${i} = ${i};`)];
    lines.push("  const handleKey = (data: string) => {", "    return data;", "  };", "}");
    writeFileSync(join(root, "a.ts"), lines.join("\n"), "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "a.ts", symbol: "handleKey" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /const handleKey/);
    assert.match(text, /not a top-level map symbol/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search rejects an unknown mode with the allowed list", async () => {
  const tool = searchTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { mode: "nonsense", pattern: "x" });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /unknown search mode "nonsense"/);
  assert.match(text, /text/);
});

test("read pages a large file with no skipped lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-"));
  try {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(80)}`);
    writeFileSync(join(root, "big.txt"), lines.join("\n"), "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const seen = [];
    let offset = 1;
    for (let page = 0; page < 30; page++) {
      const result = await tool.execute("id", { path: "big.txt", offset, limit: 2000 });
      assert.equal(result.isError, undefined);
      const text = result.content.map((c) => c.text ?? "").join("\n");
      const numbers = [...text.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      seen.push(...numbers);
      const next = text.match(/continue with offset (\d+)\]/);
      if (!next) break;
      const nextOffset = Number(next[1]);
      assert.ok(nextOffset > numbers.at(-1), "next offset advances past delivered lines");
      offset = nextOffset;
    }
    assert.deepEqual(seen, Array.from({ length: 3000 }, (_, i) => i + 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read follows Claude-style page, partial-view, and allow_large rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-claude-"));
  try {
    const partial = Array.from({ length: 12_000 }, (_, i) => `line ${i + 1} ${"x".repeat(8)}`).join("\n") + "\n";
    writeFileSync(join(root, "partial.txt"), partial, "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const page = await tool.execute("id", { path: "partial.txt" });
    const pageText = page.content.map((c) => c.text ?? "").join("\n");
    assert.match(pageText, /PARTIAL view: lines 1-/);
    assert.match(pageText, /continue with offset/);
    const wholePartial = await tool.execute("id", { path: "partial.txt", allow_large: true });
    assert.match(
      wholePartial.content.map((c) => c.text ?? "").join("\n"),
      /^12000: line 12000/m,
      "allow_large bypasses the cached partial page",
    );

    const tooBig = Array.from({ length: 26_000 }, (_, i) => `line ${i + 1} ${"x".repeat(10)}`).join("\n") + "\n";
    writeFileSync(join(root, "big.txt"), tooBig, "utf8");
    const refused = await tool.execute("id", { path: "big.txt" });
    assert.equal(refused.isError, true);
    assert.match(refused.content.map((c) => c.text ?? "").join("\n"), /whole-file read is limited/);

    const large = await tool.execute("id", { path: "big.txt", allow_large: true });
    assert.equal(large.isError, undefined);
    const largeText = large.content.map((c) => c.text ?? "").join("\n");
    assert.match(largeText, /^1: line 1/m);
    assert.match(largeText, /^26000: line 26000/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read truncates one oversized line and still advances", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-line-"));
  try {
    writeFileSync(join(root, "huge.txt"), "x".repeat(150_000) + "\nshort\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const first = await tool.execute("id", { path: "huge.txt", offset: 1, limit: 10 });
    const firstText = first.content.map((c) => c.text ?? "").join("\n");
    assert.match(firstText, /line 1 truncated at 102400 bytes/);
    assert.match(firstText, /continue with offset 2/);
    const second = await tool.execute("id", { path: "huge.txt", offset: 2 });
    const secondText = second.content.map((c) => c.text ?? "").join("\n");
    assert.match(secondText, /^2: short$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read section returns one heading block and lists headings on a miss", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-section-"));
  try {
    writeFileSync(
      join(root, "doc.md"),
      "intro\n## Configuration\nname = x\n## Usage\nrun it\n",
      "utf8",
    );
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "doc.md", section: "Configuration" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /doc\.md:2-3 \(section Configuration\)/);
    assert.match(text, /name = x/);
    assert.doesNotMatch(text, /run it/);

    const missing = await tool.execute("id", { path: "doc.md", section: "Nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content.map((c) => c.text ?? "").join("\n"), /Configuration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read stores exact bytes in the evidence ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-ledger-"));
  const runDir = mkdtempSync(join(tmpdir(), "mc-read-ledger-run-"));
  try {
    const file = join(root, "src.ts");
    writeFileSync(file, "export function target() { return 1; }\n", "utf8");
    const store = new RunStateStore({ runDir, runId: "r-read-ledger", goal: "goal", repoRoot: root });
    const tool = readTool({ root, commands: CORE_COMMANDS, state: store });
    const first = await tool.execute("id", { path: "src.ts" });
    const firstText = first.content.map((c) => c.text ?? "").join("\n");
    assert.match(firstText, /target/);
    const stat = statSync(file);
    const sig = `${stat.mtimeMs}:${stat.size}`;
    assert.equal(store.cachedRead("src.ts#full", sig), firstText);

    writeFileSync(file, "export function target() { return 2; }\n", "utf8");
    const second = await tool.execute("id", { path: "src.ts" });
    const secondText = second.content.map((c) => c.text ?? "").join("\n");
    assert.match(secondText, /return 2/);
    assert.notEqual(secondText, firstText);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("context expand returns a symbol with imports, callers, and tests", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-context-expand-"));
  const runDir = mkdtempSync(join(tmpdir(), "mc-context-expand-run-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "src", "a.ts"),
      "import { helper } from './dep.js';\nexport function target() { return helper(); }\n",
      "utf8",
    );
    writeFileSync(join(root, "src", "dep.ts"), "export function helper() { return 1; }\n", "utf8");
    writeFileSync(join(root, "src", "consumer.ts"), "import { target } from './a.js';\ntarget();\n", "utf8");
    writeFileSync(join(root, "test", "a.test.js"), "test('target', () => {});\n", "utf8");
    const store = new RunStateStore({ runDir, runId: "r-expand", goal: "goal", repoRoot: root });
    const tool = contextTool({ root, commands: CORE_COMMANDS, state: store });
    const result = await tool.execute("id", { action: "expand", target: "src/a.ts#target" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /src\/a\.ts:\d+-\d+ \(target\)/);
    assert.match(text, /return helper/);
    assert.match(text, /src\/dep\.ts \(import\)/);
    assert.match(text, /src\/consumer\.ts \(caller\)/);
    assert.match(text, /test\/a\.test\.js \(test\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("read reads several symbols or sections in one call", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-batch-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(
      join(root, "src.ts"),
      "export function alpha() { return 1; }\nexport function beta() { return 2; }\n",
      "utf8",
    );
    writeFileSync(join(root, "doc.md"), "## First\nalpha\n## Second\nbeta\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });

    const symbols = await tool.execute("id", { path: "src.ts", symbols: ["alpha", "beta"] });
    assert.equal(symbols.isError, undefined);
    const symbolText = symbols.content.map((c) => c.text ?? "").join("\n");
    assert.match(symbolText, /src\.ts:\d+-\d+ \(alpha\)/);
    assert.match(symbolText, /return 1/);
    assert.match(symbolText, /src\.ts:\d+-\d+ \(beta\)/);
    assert.match(symbolText, /return 2/);

    const sections = await tool.execute("id", { path: "doc.md", sections: ["First", "Second"] });
    assert.equal(sections.isError, undefined);
    const sectionText = sections.content.map((c) => c.text ?? "").join("\n");
    assert.match(sectionText, /\(section First\)/);
    assert.match(sectionText, /alpha/);
    assert.match(sectionText, /\(section Second\)/);
    assert.match(sectionText, /beta/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit applies several hunks atomically and can scope to one symbol", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-batch-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const file = join(root, "src.ts");
    writeFileSync(
      file,
      "export function alpha() { return 1; }\nexport function beta() { return 1; }\n",
      "utf8",
    );
    const tool = editTool({ root, commands: CORE_COMMANDS });

    const unscoped = await tool.execute("id", { path: "src.ts", oldString: "return 1;", newString: "return 10;" });
    assert.equal(unscoped.isError, true, "duplicate anchor must fail without a scope");

    const scoped = await tool.execute("id", {
      path: "src.ts",
      symbol: "alpha",
      oldString: "return 1;",
      newString: "return 10;",
    });
    assert.equal(scoped.isError, undefined);
    assert.match(readFileSync(file, "utf8"), /alpha\(\) \{ return 10; \}/);
    assert.match(readFileSync(file, "utf8"), /beta\(\) \{ return 1; \}/);

    const batch = await tool.execute("id", {
      path: "src.ts",
      edits: [
        { oldString: "alpha", newString: "Alpha" },
        { oldString: "beta", newString: "Beta" },
      ],
    });
    assert.equal(batch.isError, undefined);
    const finalText = readFileSync(file, "utf8");
    assert.match(finalText, /function Alpha/);
    assert.match(finalText, /function Beta/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read reports an offset past the end with the line count", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-eof-"));
  try {
    writeFileSync(join(root, "small.txt"), "one\ntwo\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "small.txt", offset: 999 });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /past the end of small\.txt/);
    assert.match(text, /\(3 lines\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initRepoWithSecrets() {
  const root = mkdtempSync(join(tmpdir(), "mc-search-safe-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "secret.txt\nnode_modules\n.env\n", "utf8");
  writeFileSync(join(root, "keep.ts"), "export const SECRET = 1;\n", "utf8");
  writeFileSync(join(root, "other.txt"), "SECRET other\n", "utf8");
  writeFileSync(join(root, "secret.txt"), "SECRET\n", "utf8");
  writeFileSync(join(root, ".env"), "TOKEN=SECRET\n", "utf8");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "pkg.js"), "SECRET\n", "utf8");
  return root;
}

test("search files rejects '*' and never lists ignored or secret files", async () => {
  const root = initRepoWithSecrets();
  try {
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const all = await tool.execute("id", { mode: "files", pattern: "*" });
    assert.equal(all.isError, true);
    assert.match(all.content.map((c) => c.text ?? "").join("\n"), /matches everything/);

    const listed = await tool.execute("id", { mode: "files", pattern: "*.ts" });
    const text = listed.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /keep\.ts/);
    assert.doesNotMatch(text, /secret\.txt|node_modules|\.env/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search files expands brace globs and outline accepts a pattern path", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-brace-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "data", "a.md"), "# a\n", "utf8");
    writeFileSync(join(root, "data", "b.toml"), "x = 1\n", "utf8");
    writeFileSync(join(root, "data", "c.json"), "{}\n", "utf8");
    writeFileSync(join(root, "src", "app.ts"), "export function run() {}\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });

    const files = await tool.execute("id", { mode: "files", pattern: "data/**/*.{md,toml}" });
    const filesText = files.content.map((c) => c.text ?? "").join("\n");
    assert.match(filesText, /data\/a\.md/);
    assert.match(filesText, /data\/b\.toml/);
    assert.doesNotMatch(filesText, /c\.json/);

    const rooted = await tool.execute("id", { mode: "files", pattern: "src/*.ts", path: "src" });
    assert.match(rooted.content.map((c) => c.text ?? "").join("\n"), /src\/app\.ts/);

    const bare = await tool.execute("id", { mode: "files", pattern: "*.ts", path: "src" });
    assert.match(bare.content.map((c) => c.text ?? "").join("\n"), /src\/app\.ts/);

    const outline = await tool.execute("id", { mode: "outline", pattern: "src/app.ts" });
    assert.equal(outline.isError, undefined);
    assert.match(outline.content.map((c) => c.text ?? "").join("\n"), /src\/app\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sections mode finds comment headings inside a large file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-sections-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "big.ts"),
      [
        "/* ------------------------------------------------------------- runs */",
        "const x = 1;",
        "  /* --------------------------------------------------------- run keys */",
        "// ---- orchestrate keys ----",
        "## not a section in ts",
      ].join("\n"),
      "utf8",
    );
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "sections", path: "src/big.ts" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /1: \/\* -+ runs \*\//);
    assert.match(text, /3: \/\* -+ run keys \*\//);
    assert.match(text, /4: \/\/ ---- orchestrate keys ----/);
    assert.doesNotMatch(text, /not a section/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text search returns repo-relative paths for a directory scope", async () => {
  const root = initRepoWithSecrets();
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "a.ts"), "export const HIT = 1;\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const scoped = await tool.execute("id", { mode: "text", pattern: "HIT", path: "sub" });
    const text = scoped.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /^sub\/a\.ts:1:/m, "directory-scoped search keeps the root prefix");
    assert.doesNotMatch(text, /^a\.ts:1:/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search auto locates an identifier and outlines a file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-auto-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src.ts"), "export function alpha() { return 1; }\n", "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });

    const symbol = await tool.execute("id", { mode: "auto", pattern: "alpha" });
    assert.equal(symbol.isError, undefined);
    assert.match(symbol.content.map((c) => c.text ?? "").join("\n"), /alpha/);

    const outline = await tool.execute("id", { mode: "auto", path: "src.ts", pattern: "alpha" });
    assert.equal(outline.isError, undefined);
    const text = outline.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /src\.ts/);
    assert.match(text, /alpha/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text search respects ignore rules and a specific paths list", async () => {
  const root = initRepoWithSecrets();
  try {
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const broad = await tool.execute("id", { mode: "text", pattern: "SECRET" });
    const broadText = broad.content.map((c) => c.text ?? "").join("\n");
    assert.doesNotMatch(broadText, /secret\.txt|\.env|node_modules/);

    const scoped = await tool.execute("id", {
      mode: "text",
      pattern: "SECRET",
      paths: ["keep.ts", "other.txt"],
    });
    const scopedText = scoped.content.map((c) => c.text ?? "").join("\n");
    assert.match(scopedText, /keep\.ts:1/);
    assert.match(scopedText, /other\.txt:1/);
    assert.doesNotMatch(scopedText, /secret\.txt/);

    const secretScoped = await tool.execute("id", {
      mode: "text",
      pattern: "SECRET",
      paths: ["keep.ts", ".env"],
    });
    const secretText = secretScoped.content.map((c) => c.text ?? "").join("\n");
    assert.match(secretText, /keep\.ts:1/);
    assert.doesNotMatch(secretText, /\.env/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read prepareArguments treats null strings as absent selectors", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-nullstr-"));
  try {
    writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const prepared = tool.prepareArguments({
      path: "a.ts",
      offset: 1,
      limit: 100,
      symbol: "null",
      symbols: null,
      around: null,
      section: "null",
      sections: null,
    });
    assert.deepEqual(prepared, {
      path: "a.ts",
      offset: 1,
      limit: 100,
    });
    const result = await tool.execute("id", prepared);
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /export function foo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit prepareArguments drops empty-string old/newString alongside edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-emptystr-"));
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const tool = editTool({ root, commands: CORE_COMMANDS });
    // The exact weak-model shape that stalled a build: real edits plus
    // empty-string single-hunk fields. Repair leaves a valid multi-hunk call.
    const prepared = tool.prepareArguments({
      path: "a.ts",
      oldString: "",
      newString: "",
      edits: [{ oldString: "export const a = 1;", newString: "export const a = 2;" }],
    });
    assert.deepEqual(prepared, {
      path: "a.ts",
      edits: [{ oldString: "export const a = 1;", newString: "export const a = 2;" }],
    });
    const result = await tool.execute("id", prepared);
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "export const a = 2;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit keeps a real deletion and drops empty anchors", async () => {
  const tool = editTool({ root: process.cwd(), commands: CORE_COMMANDS });
  // Empty replacement against a real anchor is a deletion: keep it.
  assert.deepEqual(
    tool.prepareArguments({ path: "a.ts", oldString: "x", newString: "" }),
    { path: "a.ts", oldString: "x", newString: "" },
  );
  // Empty hunks can never match; emptied arrays fall back to single-hunk validation.
  assert.deepEqual(
    tool.prepareArguments({ path: "a.ts", edits: [{ oldString: "", newString: "x" }] }),
    { path: "a.ts" },
  );
  // An empty path is absent, not the repo root.
  assert.deepEqual(tool.prepareArguments({ path: "", oldString: "x", newString: "y" }), {
    oldString: "x",
    newString: "y",
  });
});

test("command list treats a null-string name as absent", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const prepared = tool.prepareArguments({ action: "list", name: "null" });
  assert.deepEqual(prepared, { action: "list" });
  const result = await tool.execute("id", prepared);
  assert.equal(result.isError, undefined);
});

test("command list treats an empty name as absent", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const prepared = tool.prepareArguments({ action: "list", name: "" });
  assert.deepEqual(prepared, { action: "list" });
});

test("edit treats an empty edits array as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-empty-"));
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const tool = editTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", {
      path: "a.ts",
      oldString: "export const a = 1;",
      newString: "export const a = 2;",
      edits: [],
    });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /1 replacement/);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "export const a = 2;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search prepareArguments drops null-string mode and paths", () => {
  const tool = searchTool({ root: process.cwd(), commands: CORE_COMMANDS });
  assert.deepEqual(
    tool.prepareArguments({ mode: "null", pattern: "null", paths: ["null", "src"] }),
    { pattern: "null", paths: ["src"] },
  );
  assert.deepEqual(tool.prepareArguments({ mode: "text", pattern: "x" }), { mode: "text", pattern: "x" });
});

test("search prepareArguments drops a null path and merges path into paths", () => {
  const tool = searchTool({ root: process.cwd(), commands: CORE_COMMANDS });
  assert.deepEqual(tool.prepareArguments({ mode: "outline", path: "null" }), { mode: "outline" });
  // path and paths together mean the union, not an error.
  assert.deepEqual(
    tool.prepareArguments({ mode: "text", pattern: "x", path: "src", paths: ["lib"] }),
    { mode: "text", pattern: "x", paths: ["src", "lib"] },
  );
});

test("write prepareArguments drops a literal null path", () => {
  const tool = writeTool({ root: process.cwd(), commands: CORE_COMMANDS });
  assert.deepEqual(tool.prepareArguments({ path: "null", content: "x" }), { content: "x" });
  assert.deepEqual(tool.prepareArguments({ path: "src/a.ts", content: "x" }), { path: "src/a.ts", content: "x" });
});

test("edit merges a single hunk with an edits array instead of failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-edit-merge-"));
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\nexport const b = 1;\n", "utf8");
    const tool = editTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", {
      path: "a.ts",
      oldString: "export const a = 1;",
      newString: "export const a = 2;",
      edits: [{ oldString: "export const b = 1;", newString: "export const b = 2;" }],
    });
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "export const a = 2;\nexport const b = 2;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read combines symbols and sections in one call", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-merge-"));
  try {
    writeFileSync(
      join(root, "a.ts"),
      "export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n",
      "utf8",
    );
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const both = await tool.execute("id", { path: "a.ts", symbols: ["alpha"], sections: ["nope"] });
    assert.equal(both.isError, undefined);
    const text = both.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /alpha/);
    assert.match(text, /no section/);
    // A lone miss returns an informative note, not an error strike: the
    // model can try outline or search next instead of handling a failure.
    const miss = await tool.execute("id", { path: "a.ts", symbols: ["missing"] });
    assert.equal(miss.isError, undefined);
    assert.match(miss.content.map((c) => c.text ?? "").join("\n"), /no symbol: missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
