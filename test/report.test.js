/**
 * Run inspection: live model deltas and authoritative turn text group cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingChunks, touchedPaths, childRuns } from "../dist/report/run.js";

test("thinking chunks combine live deltas and final turn text", () => {
  const events = [
    { t: "2026-01-01T00:00:01Z", type: "model_delta", call: 1, kind: "thinking", text: "consider " },
    { t: "2026-01-01T00:00:02Z", type: "model_delta", call: 1, kind: "thinking", text: "the parser" },
    { t: "2026-01-01T00:00:03Z", type: "model_delta", call: 1, kind: "text", text: "draft" },
    { t: "2026-01-01T00:00:04Z", type: "model_call_end", call: 1, text: "final answer" },
  ];
  const chunks = thinkingChunks(events);
  assert.deepEqual(chunks.map((chunk) => chunk.kind), ["thinking", "text"]);
  assert.equal(chunks[0].text, "consider the parser");
  assert.equal(chunks[1].text, "final answer");
  assert.equal(chunks[1].complete, true);
});

test("thinking chunks keep retries separate when call indices reset", () => {
  const events = [
    { t: "2026-01-01T00:00:01Z", type: "model_select", call: 0 },
    { t: "2026-01-01T00:00:02Z", type: "model_delta", call: 1, kind: "text", text: "first draft" },
    { t: "2026-01-01T00:00:03Z", type: "model_call_end", call: 1, text: "first answer" },
    { t: "2026-01-01T00:00:04Z", type: "model_select", call: 0 },
    { t: "2026-01-01T00:00:05Z", type: "model_delta", call: 1, kind: "text", text: "second draft" },
    { t: "2026-01-01T00:00:06Z", type: "model_call_end", call: 1, text: "second answer" },
  ];
  const chunks = thinkingChunks(events);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["first answer", "second answer"]);
  assert.equal(chunks[0].attempt, 1);
  assert.equal(chunks[1].attempt, 2);
});

test("touched paths and child runs are derived from events and lineage", () => {
  const events = [
    { t: "2026-01-01T00:00:01Z", type: "tool_call", tool: "write", args: { path: "src/a.ts" } },
    { t: "2026-01-01T00:00:02Z", type: "tool_call", tool: "edit", args: { path: "src/b.ts" } },
    { t: "2026-01-01T00:00:03Z", type: "tool_call", tool: "read", args: { path: "README.md" } },
  ];
  assert.deepEqual(touchedPaths(events), ["src/a.ts", "src/b.ts"]);
  const runs = [
    { id: "parent" },
    { id: "child", parentRunId: "parent", startedAt: "2026-01-01T00:00:00Z" },
    { id: "other", parentRunId: "nope", startedAt: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(childRuns(runs, "parent").map((run) => run.id), ["child"]);
});
