/**
 * Map freshness: one git status is the cache key.
 *
 * A hit must not re-list or re-scan the tree, and a change must miss. A
 * repeated no-op build returning the cached map is the contract that makes
 * per-execution freshness affordable.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRepoMap } from "../dist/map/deterministic.js";

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: "ignore",
  });
}

describe("buildRepoMap freshness", () => {
  it("returns the cached map when HEAD and status are unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-map-fresh-"));
    try {
      git(root, "init", "-q");
      writeFileSync(join(root, "a.ts"), "export const A = 1;\n", "utf8");
      git(root, "add", "a.ts");
      git(root, "commit", "-q", "-m", "initial");

      const first = await buildRepoMap(root);
      assert.equal(first.cached, false);
      assert.equal(first.map.files.some((file) => file.path === "a.ts"), true);

      const second = await buildRepoMap(root);
      assert.equal(second.cached, true);

      writeFileSync(join(root, "a.ts"), "export const A = 2;\n", "utf8");
      const third = await buildRepoMap(root);
      assert.equal(third.cached, false);

      mkdirSync(join(root, "newdir"), { recursive: true });
      writeFileSync(join(root, "newdir/b.ts"), "export const B = 1;\n", "utf8");
      const fourth = await buildRepoMap(root);
      assert.equal(fourth.cached, false);
      assert.equal(fourth.map.files.some((file) => file.path === "newdir/b.ts"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
