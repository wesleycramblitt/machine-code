/**
 * Core tool ergonomics: batch command discovery and file-scoped text search.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { commandTool, readTool, searchTool } from "../dist/tools/index.js";
import { CORE_COMMANDS } from "../dist/commands/registry.js";

test("command list returns every schema in one call", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "list" });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /core:status/);
  assert.match(text, /core:diff/);
  assert.match(text, /"path"/);
});

test("command list with a name points at describe", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "list", name: "core:status" });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /list takes no name/);
  assert.match(text, /describe name=core:status/);
});

test("command describe points at tools, not commands", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS });
  const result = await tool.execute("id", { action: "describe", name: "issue" });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /issue is a tool, not a command/);
});

test("command describe reports a tool the role does not have", async () => {
  const tool = commandTool({ root: process.cwd(), commands: CORE_COMMANDS, tools: ["read", "search"] });
  const result = await tool.execute("id", { action: "describe", name: "issue" });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /issue is a tool, but this role does not have it/);
  assert.match(text, /read, search/);
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

test("text search scoped to a file still works", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-search-"));
  try {
    writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n', "utf8");
    const tool = searchTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { mode: "text", path: "package.json", pattern: "scripts" });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /package\.json:1/);
    assert.match(text, /scripts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      const next = text.match(/call read with offset (\d+)\]/);
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

test("read truncates one oversized line and still advances", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-line-"));
  try {
    writeFileSync(join(root, "huge.txt"), "x".repeat(40_000) + "\nshort\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const first = await tool.execute("id", { path: "huge.txt", offset: 1, limit: 10 });
    const firstText = first.content.map((c) => c.text ?? "").join("\n");
    assert.match(firstText, /line 1 truncated at 24576 bytes/);
    assert.match(firstText, /call read with offset 2/);
    const second = await tool.execute("id", { path: "huge.txt", offset: 2 });
    const secondText = second.content.map((c) => c.text ?? "").join("\n");
    assert.match(secondText, /^2: short$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read reports an offset past the end of the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-read-eof-"));
  try {
    writeFileSync(join(root, "small.txt"), "one\ntwo\n", "utf8");
    const tool = readTool({ root, commands: CORE_COMMANDS });
    const result = await tool.execute("id", { path: "small.txt", offset: 999 });
    assert.equal(result.isError, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /past the end of small\.txt/);
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
