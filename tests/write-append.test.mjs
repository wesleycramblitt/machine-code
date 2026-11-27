/**
 * `write` can finish a large file in chunks.
 *
 * A response budget can cut a single giant tool call; chunking with `append`
 * makes a retry idempotent because the truncated call never ran. The first
 * chunk replaces, later chunks append.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTool } from "../dist/tools/index.js";

function context(root) {
  return { root, commands: new Map() };
}

async function run(tool, params) {
  return tool.execute("call-1", params, new AbortController().signal);
}

describe("write append", () => {
  it("replaces on the first chunk and appends later chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-write-"));
    try {
      const tool = writeTool(context(root));
      const first = await run(tool, { path: "src/a.ts", content: "line one\n" });
      assert.equal(first.isError, undefined);
      const second = await run(tool, { path: "src/a.ts", content: "line two\n", append: true });
      assert.equal(second.isError, undefined);
      assert.match(second.content[0].text, /appended src\/a\.ts/);
      assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "line one\nline two\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
