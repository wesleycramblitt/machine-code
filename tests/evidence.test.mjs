/**
 * Re-served evidence contract tests.
 *
 * Evidence must reach the model as native toolCall/toolResult pairs with the
 * exact original params (the same structure as live results), batched by
 * original turn — never as quoted text. Kept-window calls are excluded, and
 * over budget the oldest drops first with a named accounting line. Both
 * inspect bodies and issue:show reads re-serve; anything else stays live.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEvidence, changedIssuesText, evidenceHandle } from "../dist/context/evidence.js";
import { inspectTool } from "../dist/tools/inspect.js";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-evidence-"));
  writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n");
  writeFileSync(join(root, "b.ts"), "export function bar() {\n  return 2;\n}\n");
  return root;
}

function fakeCommand(text) {
  return {
    async execute() {
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

describe("buildEvidence", () => {
  it("serves native toolCall/toolResult pairs with exact original params", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const retained = [
        { id: "c2", tool: "inspect", params: { query: "b.ts" }, turn: 2 },
        { id: "c1", tool: "inspect", params: { query: "a.ts" }, turn: 1 },
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
        { id: "c3", tool: "inspect", params: { query: "b.ts" }, turn: 2 },
        { id: "c2", tool: "inspect", params: { query: "foo" }, turn: 1 },
        { id: "c1", tool: "inspect", params: { query: "a.ts" }, turn: 1 },
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

  it("re-serves issue:show reads as command pairs", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const command = fakeCommand("path: .machine_code/issues/features/todo/x.md\n\n# X\n\nDo the thing.");
      const showArgs = { action: "run", name: "issue:show", args: { slug: "x" } };
      const retained = [
        { id: "c9", tool: "command", params: showArgs, turn: 3 },
        { id: "c1", tool: "inspect", params: { query: "a.ts" }, turn: 1 },
      ];
      const out = await buildEvidence({
        retained,
        inspect,
        command,
        diff: async () => "",
        keptIds: new Set(),
        maxChars: 100_000,
      });
      const assistants = out.messages.filter((m) => m.role === "assistant");
      const commandPair = assistants.find((m) => m.content[0].name === "command");
      assert.ok(commandPair, "expected a command pair");
      assert.deepEqual(commandPair.content[0].arguments, showArgs);
      const idx = out.messages.indexOf(commandPair);
      const result = out.messages[idx + 1];
      assert.equal(result.role, "toolResult");
      assert.equal(result.toolName, "command");
      assert.equal(result.toolCallId, commandPair.content[0].id);
      assert.match(String(result.content[0].text), /Do the thing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips command entries when no command tool is provided", async () => {
    const command = fakeCommand("body");
    const retained = [
      { id: "c9", tool: "command", params: { action: "run", name: "issue:show", args: {} }, turn: 1 },
    ];
    const out = await buildEvidence({
      retained,
      inspect: undefined,
      diff: async () => "",
      keptIds: new Set(),
      maxChars: 100_000,
    });
    assert.equal(out.messages.length, 0);
    assert.equal(out.text, null);
  });

  it("excludes kept-window calls and drops oldest over budget", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const retained = [
        { id: "c3", tool: "inspect", params: { query: "b.ts" }, turn: 3 },
        { id: "c2", tool: "inspect", params: { query: "foo" }, turn: 2 },
        { id: "c1", tool: "inspect", params: { query: "a.ts" }, turn: 1 },
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
      assert.match(tight.text, /withheld for the evidence budget/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names every call with a stable handle", () => {
    const call = { tool: "inspect", params: { query: "a.ts" } };
    assert.match(evidenceHandle(call), /^ev[0-9a-f]{4}$/);
    assert.equal(evidenceHandle(call), evidenceHandle({ tool: "inspect", params: { query: "a.ts" } }));
  });

  it("withholds over budget instead of dropping silently, and lists handles", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const retained = [
        { id: "c3", tool: "inspect", params: { query: "b.ts" }, turn: 2 },
        { id: "c2", tool: "inspect", params: { query: "a.ts" }, turn: 1 },
      ];
      const out = await buildEvidence({
        retained,
        inspect,
        diff: async () => "",
        keptIds: new Set(),
        maxChars: 120,
      });
      assert.match(out.text, /withheld for the evidence budget/);
      assert.match(out.text, /ev[0-9a-f]{4}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours pruned handles", async () => {
    const root = makeRepo();
    try {
      const inspect = inspectTool({ root, processes: undefined });
      const call = { id: "c1", tool: "inspect", params: { query: "a.ts" }, turn: 1 };
      const out = await buildEvidence({
        retained: [call],
        inspect,
        diff: async () => "",
        keptIds: new Set(),
        maxChars: 100_000,
        dropped: new Set([evidenceHandle(call)]),
      });
      assert.equal(out.messages.length, 0);
      assert.equal(out.text, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("changedIssuesText", () => {
  it("renders changed issue bodies from the run log", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-changedissues-"));
    try {
      const runDir = join(root, "run");
      const issuesDir = join(root, ".machine_code", "issues", "features", "todo");
      mkdirSync(issuesDir, { recursive: true });
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(issuesDir, "x.md"), "# X\n\nDo the thing.\n", "utf8");
      writeFileSync(
        join(runDir, "issues-changed.json"),
        JSON.stringify([".machine_code/issues/features/todo/x.md", ".machine_code/issues/features/todo/gone.md"]),
        "utf8",
      );
      const text = changedIssuesText(root, runDir);
      assert.ok(text);
      assert.match(text, /not in git/);
      assert.match(text, /Do the thing/);
      assert.match(text, /gone\.md[\s\S]*no longer at this path/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null without a change log", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-changedissues-"));
    try {
      assert.equal(changedIssuesText(root, join(root, "run")), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
