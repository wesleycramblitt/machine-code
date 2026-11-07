/**
 * Timeline selection: streaming deltas are coalesced and render no row, so the
 * cursor must skip them instead of disappearing on an invisible event.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeTimelineEvent, isTimelineEvent, lastTimelineIndex, stepTimelineSelection } from "../dist/tui/timeline.js";

const events = [
  { type: "run_start" },
  { type: "model_request" },
  { type: "model_delta" },
  { type: "model_call_end" },
  { type: "model_delta" },
  { type: "tool_call" },
];

test("timeline events skip streaming deltas in both directions", () => {
  assert.equal(isTimelineEvent(events[0]), true);
  assert.equal(isTimelineEvent(events[2]), false);
  assert.equal(stepTimelineSelection(events, 1, 1), 3);
  assert.equal(stepTimelineSelection(events, 3, -1), 1);
  assert.equal(stepTimelineSelection(events, 4, 1), 5);
  assert.equal(stepTimelineSelection(events, 4, -1), 3);
});

test("timeline selection stays put at the ends", () => {
  assert.equal(stepTimelineSelection(events, 0, -1), 0);
  assert.equal(stepTimelineSelection(events, 5, 1), 5);
  assert.equal(stepTimelineSelection([], 0, 1), 0);
  assert.equal(stepTimelineSelection([{ type: "model_delta" }], 0, 1), 0);
});

test("routine internals are hidden unless verbose is requested", () => {
  const mixed = [
    { type: "run_start" },
    { type: "context_state", turn: 1 },
    { type: "checkpoint", turn: 1 },
    { type: "model_select", call: 1, key: "p/m" },
    { type: "model_select", call: 0, key: "p/m" },
    { type: "tool_call", tool: "read" },
    { type: "run_summary", stopReason: "completed" },
  ];
  assert.equal(isTimelineEvent(mixed[1]), false);
  assert.equal(isTimelineEvent(mixed[2]), false);
  assert.equal(isTimelineEvent(mixed[3]), false);
  assert.equal(isTimelineEvent(mixed[4]), true);
  assert.equal(isTimelineEvent(mixed[1], true), true);
  assert.equal(lastTimelineIndex(mixed), 6);
  assert.equal(lastTimelineIndex([{ type: "model_delta" }]), -1);
});

test("event descriptions are one-line and ANSI-free", () => {
  assert.equal(describeTimelineEvent({ type: "tool_call", tool: "read", isError: false }), "read ok");
  assert.match(describeTimelineEvent({ type: "turn_cap", turns: 25 }), /25/);
  assert.doesNotMatch(describeTimelineEvent({ type: "error_classified", kind: "rate-limit" }), /\x1b/);
});

test("tool args render as human one-liners, not JSON", async () => {
  const { describeToolArgs } = await import("../dist/tui/timeline.js");
  assert.equal(describeToolArgs("read", { path: "src/a.ts", symbol: "runLoop" }), "src/a.ts#runLoop");
  assert.equal(describeToolArgs("read", { path: "src/a.ts", offset: 10, limit: 20 }), "src/a.ts#10:20");
  assert.equal(describeToolArgs("edit", { path: "src/a.ts", edits: [{}, {}] }), "src/a.ts · 2 hunks");
  assert.equal(describeToolArgs("search", { pattern: "foo", mode: "text" }), '"foo" text');
  assert.equal(describeToolArgs("search", { pattern: "foo" }), '"foo"');
  assert.equal(describeToolArgs("command", { action: "run", name: "core:status" }), "run core:status");
  assert.equal(describeToolArgs("mystery", { path: "x", name: "y" }), "x y");
  assert.equal(describeToolArgs("read", null), "");
});

test("waitingForRun names the open model, tool, process, or child wait", async () => {
  const { waitingForRun } = await import("../dist/tui/timeline.js");
  const t = "2026-01-01T00:00:00.000Z";
  // Open model request: waiting on that model.
  assert.equal(
    waitingForRun({ status: "running", lastActivityAt: t }, [
      { type: "model_request", call: 1, provider: "openai", model: "gpt-5", t },
    ]).label,
    "model openai/gpt-5",
  );
  // Streaming deltas flag the wait as flowing, not stuck.
  assert.equal(
    waitingForRun({ status: "running", lastActivityAt: t }, [
      { type: "model_request", call: 1, provider: "openai", model: "gpt-5", t },
      { type: "model_delta", call: 1, kind: "text", text: "hi", t },
    ]).streaming,
    true,
  );
  // Completed model + open tool: the tool wins as the newest open marker.
  const toolWait = waitingForRun({ status: "running", lastActivityAt: t }, [
    { type: "model_request", call: 1, provider: "p", model: "m", t },
    { type: "model_call_end", call: 1, provider: "p", model: "m", stopReason: "tool", t },
    { type: "tool_call_start", toolCallId: "a", tool: "search", args: { pattern: "foo" }, t },
  ]);
  assert.equal(toolWait.kind, "tool");
  assert.match(toolWait.label, /search/);
  assert.match(toolWait.label, /foo/);
  // Closed tool with nothing open: still busy between steps.
  assert.equal(
    waitingForRun({ status: "running", lastActivityAt: t }, [
      { type: "tool_call_start", toolCallId: "a", tool: "read", t },
      { type: "tool_call", toolCallId: "a", tool: "read", isError: false, t },
    ]).kind,
    "working",
  );
  // Terminal runs never wait.
  assert.equal(
    waitingForRun({ status: "completed", lastActivityAt: t }, [
      { type: "model_request", call: 1, t },
    ]),
    null,
  );
  // Unanswered ask waits on the human, not the model.
  assert.equal(
    waitingForRun(
      { status: "awaiting_input", lastActivityAt: t },
      [{ type: "question", questionId: "q", t }],
      { hasPendingQuestion: true },
    ).kind,
    "input",
  );
});
