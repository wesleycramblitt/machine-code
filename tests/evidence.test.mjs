/**
 * Re-served evidence contract tests.
 *
 * Evidence must reach the model as native toolCall/toolResult pairs with the
 * exact original params (the same structure as live results), batched by
 * original turn — never as quoted text. Kept-window calls are excluded, and
 * over budget the oldest drops first with a named accounting line.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEvidence, MAX_RETAINED_CALLS } from "../dist/context/evidence.js";
import { inspectTool } from "../dist/tools/inspect.js";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-evidence-"));
  writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n");
  writeFileSync(join(root, "b.ts"), "export function bar() {\n  return 2;\n}\n");
  return root;
}

describe("buildEvidence", () => {
  it("serves native toolCall/toolResult pairs with exact original params", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const retained = [
        { id: "c2", params: { query: "b.ts" }, turn: 2 },
        { id: "c1", params: { query: "a.ts" }, turn: 1 },
      ];
      const out = await buildEvidence({
        retained,
        inspect,
        diff: async () => "",
        keptIds: new Set(),
        maxChars: 100_000,
      });
      assert.equal(out.messages.length, 4);
      const [assistant, result] = out.messages;
      assert.equal(assistant.role, "assistant");
      assert.equal(assistant.content[0].type, "toolCall");
      assert.equal(assistant.content[0].name, "inspect");
      // Oldest first: turn-1 batch leads.
      assert.deepEqual(assistant.content[0].arguments, { query: "a.ts" });
      assert.equal(result.role, "toolResult");
      assert.equal(result.toolName, "inspect");
      assert.equal(result.toolCallId, assistant.content[0].id);
      assert.ok(String(result.content[0].text).includes("export function foo"));
      // Synthetic ids, not the original call ids.
      assert.ok(!["c1", "c2"].includes(assistant.content[0].id));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("batches same-turn calls into one assistant message", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const retained = [
        { id: "c3", params: { query: "b.ts" }, turn: 2 },
        { id: "c2", params: { query: "foo" }, turn: 1 },
        { id: "c1", params: { query: "a.ts" }, turn: 1 },
      ];
      const out = await buildEvidence({
        retained,
        inspect,
        diff: async () => "",
        keptIds: new Set(),
        maxChars: 100_000,
      });
      assert.equal(out.messages[0].role, "assistant");
      assert.equal(out.messages[0].content.length, 2);
      assert.deepEqual(
        out.messages[0].content.map((b) => b.arguments),
        [{ query: "a.ts" }, { query: "foo" }],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes kept-window calls and drops oldest over budget", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const retained = [
        { id: "c3", params: { query: "b.ts" }, turn: 3 },
        { id: "c2", params: { query: "foo" }, turn: 2 },
        { id: "c1", params: { query: "a.ts" }, turn: 1 },
      ];
      const kept = await buildEvidence({
        retained,
        inspect,
        diff: async () => "",
        keptIds: new Set(["c3"]),
        maxChars: 100_000,
      });
      const queries = kept.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content.map((b) => b.arguments.query));
      assert.deepEqual(queries, ["a.ts", "foo"]);

      const tight = await buildEvidence({
        retained,
        inspect,
        diff: async () => "",
        keptIds: new Set(),
        maxChars: 300,
      });
      assert.ok(tight.messages.length < kept.messages.length);
      assert.match(tight.text, /omitted for budget/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains at most 30 distinct calls", () => {
    assert.equal(MAX_RETAINED_CALLS, 30);
  });
});
