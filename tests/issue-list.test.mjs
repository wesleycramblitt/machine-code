/**
 * issue:list filter validation tests.
 *
 * A bad kind/status filter used to silently match nothing, and the model read
 * "no issues found" as "no issues exist" (observed: 65-turn list/show loop
 * over kind:"todo"). Filters now fail fast with the valid vocabulary, and
 * genuinely empty results echo the filters.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { issueCommands } from "../dist/commands/issues.js";

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "mc-issue-list-"));
  const dir = join(root, ".machine_code", "issues", "features", "todo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sample-thing.md"),
    "id: abc123\nbranch: mc/sample-thing-abc123\nfiles: src/a.ts\nacceptance: script:build\n\n# Sample thing\n\nDo the thing.\n",
    "utf8",
  );
  const ctx = { root, repoRoot: root, commands: new Map(), processes: undefined };
  const list = issueCommands(root).find((c) => c.name === "issue:list");
  assert.ok(list);
  return { root, ctx, list };
}

describe("issue:list filter validation", () => {
  it("rejects a status used as kind", async () => {
    const { ctx, list, root } = makeRoot();
    try {
      const r = await list.handler({ kind: "todo" }, ctx);
      assert.equal(r.isError, true);
      assert.match(r.text, /bad kind/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown status", async () => {
    const { ctx, list, root } = makeRoot();
    try {
      const r = await list.handler({ status: "bogus" }, ctx);
      assert.equal(r.isError, true);
      assert.match(r.text, /bad status/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts kind aliases and echoes filters when empty", async () => {
    const { ctx, list, root } = makeRoot();
    try {
      const alias = await list.handler({ kind: "feature" }, ctx);
      assert.equal(alias.isError, false);
      assert.match(alias.text, /sample-thing/);
      const empty = await list.handler({ kind: "bugs" }, ctx);
      assert.equal(empty.isError, false);
      assert.match(empty.text, /no issues found \(kind: bugs\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
