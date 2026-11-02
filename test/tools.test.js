/**
 * Core tool ergonomics: batch command discovery and file-scoped text search.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { commandTool, searchTool } from "../dist/tools/index.js";
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
