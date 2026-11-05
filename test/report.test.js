/**
 * Run inspection: live model deltas and authoritative turn text group cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingChunks, touchedPaths, childRuns, relatedRuns, runMetrics, exceededLimits } from "../dist/report/run.js";

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

test("run metrics summarize calls, context, changes, gates, and limits", () => {
  const summary = {
      id: "r-eval",
      agent: "build",
      status: "blocked",
      stopReason: "loop",
      modelCalls: 4,
      usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420 },
      cost: { actual: 0.01, estimated: 0 },
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:02.500Z",
    };
    const events = [
      { t: "2026-01-01T00:00:00.100Z", type: "model_select", key: "provider/model" },
      { t: "2026-01-01T00:00:00.200Z", type: "model_call_end" },
      { t: "2026-01-01T00:00:00.300Z", type: "tool_call", tool: "read" },
      { t: "2026-01-01T00:00:00.400Z", type: "tool_call", tool: "edit", args: { path: "src/a.ts" } },
      { t: "2026-01-01T00:00:00.500Z", type: "loop_blocked", reason: "loop" },
      { t: "2026-01-01T00:00:00.600Z", type: "gates", passed: false, results: [{ command: "typescript:test", passed: false }] },
    ];
    const metrics = runMetrics(summary, events);
    assert.equal(metrics.model, "provider/model");
    assert.equal(metrics.modelCalls, 4);
    assert.equal(metrics.toolCalls, 2);
    assert.equal(metrics.toolCallsByTool.read, 1);
    assert.equal(metrics.loopReason, "loop");
    assert.equal(metrics.gates?.failed[0], "typescript:test");
    assert.deepEqual(metrics.changedPaths, ["src/a.ts"]);
    assert.equal(metrics.wallMs, 2_500);

    assert.deepEqual(exceededLimits(metrics, { maxCalls: 10, maxCost: 1 }), []);
    assert.match(exceededLimits(metrics, { maxCalls: 1, maxTokens: 100 })[0], /model calls 4 > 1/);
});

test("related runs include lineage and same-orchestration task siblings", () => {
  const summary = {
    id: "build",
    orchestrationId: "orch-1",
    taskIssue: { repo: "o/r", number: 5 },
    rootRunId: "build",
    parentRunId: "parent",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const runs = [
    summary,
    { id: "parent", startedAt: "2025-12-31T00:00:00Z" },
    { id: "review", orchestrationId: "orch-1", taskIssue: { repo: "o/r", number: 5 }, startedAt: "2026-01-01T00:00:01Z" },
    { id: "fork", rootRunId: "build", startedAt: "2026-01-01T00:00:02Z" },
    { id: "other", orchestrationId: "orch-2", taskIssue: { repo: "o/r", number: 6 }, startedAt: "2026-01-01T00:00:03Z" },
  ];
  assert.deepEqual(relatedRuns(runs, summary).map((run) => run.id), ["fork", "review", "parent"]);
});
