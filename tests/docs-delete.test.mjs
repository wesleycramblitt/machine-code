/**
 * Research docs-deletion tests.
 *
 * Research holds knowledge:write but not code:write, so the generic mutation
 * gate used to reject core:delete everywhere. The docs carve-out permits
 * deletion under docs/ only; anything else still refuses, and
 * research:verify counts deletions as changes (a delete-only run must pass).
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandTool } from "../dist/tools/index.js";
import { CORE_COMMANDS } from "../dist/commands/registry.js";
import { researchVerifyCommand } from "../dist/commands/research.js";

function researchCtx(root) {
  return {
    root,
    commands: CORE_COMMANDS,
    tools: ["command"],
    allowMutations: false,
    capabilities: ["code:read", "context:inherit", "knowledge:write", "run:read", "issue:write"],
  };
}

describe("research docs deletion", () => {
  it("allows core:delete under docs/ without code:write", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-docsdel-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "stale.md"), "# stale\n", "utf8");
      const tool = commandTool(researchCtx(root));
      const out = await tool.execute("t1", { action: "run", name: "core:delete", args: { path: "docs/stale.md" } }, new AbortController().signal);
      assert.equal(out.isError, undefined);
      const text = out.content.map((c) => c.text ?? "").join("\n");
      assert.match(text, /deleted docs\/stale\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses core:delete outside docs/ without code:write", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-docsdel-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "keep.ts"), "export {};\n", "utf8");
      const tool = commandTool(researchCtx(root));
      const out = await tool.execute("t1", { action: "run", name: "core:delete", args: { path: "src/keep.ts" } }, new AbortController().signal);
      assert.equal(out.isError, true);
      const text = out.content.map((c) => c.text ?? "").join("\n");
      assert.match(text, /only delete under docs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("research:verify passes on a docs-only deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-verifydel-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
      execFileSync("git", ["config", "user.name", "t"], { cwd: root });
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "old.md"), "# old\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
      rmSync(join(root, "docs", "old.md"));
      const out = await researchVerifyCommand.handler({}, { root, repoRoot: root });
      assert.equal(out.isError, false);
      assert.match(out.text, /docs\/old\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
