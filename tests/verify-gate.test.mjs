/**
 * Gate self-run refusal tests.
 *
 * Gates run after finish via runCommand directly. The model must not run
 * them mid-run: an early issue-curation:verify failure ("nothing changed yet")
 * teaches verify-avoidance, and script runs in a build loop. Both are
 * refused with a redirect to finish; describe/list stay available.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandTool } from "../dist/tools/index.js";
import { CORE_COMMANDS } from "../dist/commands/registry.js";

function researchCtx(root) {
  return {
    root,
    commands: CORE_COMMANDS,
    tools: ["command"],
    allowMutations: false,
    capabilities: ["code:read", "context:inherit", "issue:write"],
  };
}

describe("gate self-run refusal", () => {
  it("refuses issue-curation:verify runs with a finish redirect", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-gate-"));
    try {
      const tool = commandTool(researchCtx(root));
      const out = await tool.execute(
        "t1",
        { action: "run", name: "issue-curation:verify", args: {} },
        new AbortController().signal,
      );
      assert.equal(out.isError, true);
      assert.match(out.content.map((c) => c.text ?? "").join("\n"), /runs in gates after finish/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses reference:verify runs with a finish redirect", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-gate-"));
    try {
      const tool = commandTool(researchCtx(root));
      const out = await tool.execute(
        "t1",
        { action: "run", name: "reference:verify", args: {} },
        new AbortController().signal,
      );
      assert.equal(out.isError, true);
      assert.match(out.content.map((c) => c.text ?? "").join("\n"), /runs in gates after finish/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still allows describing the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-gate-"));
    try {
      const tool = commandTool(researchCtx(root));
      const out = await tool.execute(
        "t1",
        { action: "describe", name: "issue-curation:verify" },
        new AbortController().signal,
      );
      assert.ok(!out.isError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
