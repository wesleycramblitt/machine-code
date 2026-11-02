/**
 * Run state: facts, working set, artifacts, ingestion, prompt rendering, and
 * the explicit `context` tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RunStateStore } from "../dist/context/state.js";
import { renderPromptMessages } from "../dist/context/render.js";
import { contextTool } from "../dist/tools/context.js";
import { CORE_COMMANDS } from "../dist/commands/registry.js";

function tempDir(prefix = "mc-state-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

const system = { role: "system", content: "system prompt" };
const user = { role: "user", content: "original goal" };
const assistant = ({ id = "c1", name = "read", args = {}, text = "I will inspect the target." } = {}) => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    { type: "toolCall", id, name, arguments: args },
  ],
});
const result = ({ id = "c1", name = "read", text = "1: one\n2: two", isError = false } = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});

test("state records decisions, next, focus, and artifacts", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r1", goal: "fix the lag" });
    store.note("decision", "Cache modelPreview per draw.");
    store.note("next", "Read newRunInsert, then edit.");
    store.focus(["src/tui.ts:2216-2256"]);
    const block = store.renderBlock();
    assert.match(block, /Goal: fix the lag/);
    assert.match(block, /Cache modelPreview per draw/);
    assert.match(block, /Next: Read newRunInsert/);
    assert.match(block, /src\/tui\.ts:2216-2256/);
    assert.ok(existsSync(join(dir, "state.jsonl")));
    assert.ok(existsSync(join(dir, "state.md")));
    assert.match(readFileSync(join(dir, "state.md"), "utf8"), /Run state: r1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestTurn records read facts, artifacts, working set, and changes", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r2", goal: "goal" });
    store.ingestTurn(
      [system, user, assistant({ args: { path: "src/tui.ts", offset: 10, limit: 5 } }), result()],
      1,
    );
    const read = store.getState().facts.find((fact) => fact.key.startsWith("read:"));
    assert.ok(read);
    assert.equal(read.refs[0].path, "src/tui.ts");
    assert.deepEqual(read.refs[0].range, [10, 14]);
    assert.ok(read.refs[0].artifact);
    assert.equal(store.getArtifact(read.refs[0].artifact), "1: one\n2: two");
    assert.equal(store.getState().workingSet.length, 1);

    store.ingestTurn(
      [
        system,
        user,
        assistant({ id: "c2", name: "edit", args: { path: "src/tui.ts" } }),
        result({ id: "c2", name: "edit", text: "edited src/tui.ts (1 replacement)" }),
      ],
      2,
    );
    assert.equal(read.status, "stale", "older ref to the changed path is stale");
    const change = store.getState().facts.find((fact) => fact.kind === "change");
    assert.ok(change);
    assert.match(change.text, /edited src\/tui\.ts/);
    assert.equal(store.getState().phase, "act");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit context focus survives automatic ingestion", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r3", goal: "goal" });
    store.focus(["src/other.ts:1-3"]);
    const contextCall = assistant({ id: "c3", name: "context", args: { action: "focus" }, text: "" });
    store.ingestTurn(
      [system, user, contextCall, result({ id: "c3", name: "context", text: "focused 1 ref" })],
      1,
    );
    assert.equal(store.getState().workingSet[0].path, "src/other.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render keeps only state plus the last step", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r4", goal: "the goal" });
    store.note("decision", "Use the map first.");
    const old = [
      assistant({ id: "old", args: { path: "old.ts", offset: 1, limit: 1 } }),
      result({ id: "old", text: "OLD-TOOL-BODY" }),
    ];
    const last = [
      assistant({ id: "new", args: { path: "new.ts", offset: 1, limit: 1 } }),
      result({ id: "new", text: "NEW-TOOL-BODY" }),
    ];
    const rendered = renderPromptMessages([system, user, ...old, ...last], store, "MAP-INDEX");
    const serialized = JSON.stringify(rendered.messages);
    assert.match(serialized, /the goal/);
    assert.match(serialized, /Use the map first/);
    assert.match(serialized, /MAP-INDEX/);
    assert.match(serialized, /NEW-TOOL-BODY/);
    assert.doesNotMatch(serialized, /OLD-TOOL-BODY/);
    assert.equal(rendered.messages[0].role, "system");
    assert.equal(rendered.messages[1].role, "user");
    assert.equal(rendered.messages[2].role, "assistant");
    assert.equal(rendered.messages[3].role, "toolResult");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render never sends an orphan tool call", () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r5", goal: "goal" });
    const rendered = renderPromptMessages([system, user, assistant()], store);
    assert.equal(rendered.messages.length, 2);
    assert.equal(rendered.messages[1].role, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context tool notes, focuses, recalls, and reports state", async () => {
  const dir = tempDir();
  try {
    const store = new RunStateStore({ runDir: dir, runId: "r6", goal: "goal" });
    const artifact = store.putArtifact("exact bytes");
    const tool = contextTool({ root: dir, commands: CORE_COMMANDS, state: store });
    let outcome = await tool.execute("1", {
      action: "note",
      kind: "decision",
      text: "Use the smallest range.",
    });
    assert.equal(outcome.isError, undefined);
    outcome = await tool.execute("2", { action: "focus", refs: ["src/a.ts:1-2"] });
    assert.equal(outcome.isError, undefined);
    outcome = await tool.execute("3", { action: "recall", id: artifact.id });
    assert.match(outcome.content.map((c) => c.text ?? "").join("\n"), /exact bytes/);
    outcome = await tool.execute("4", { action: "state" });
    const text = outcome.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /Use the smallest range/);
    assert.match(text, /src\/a\.ts:1-2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
