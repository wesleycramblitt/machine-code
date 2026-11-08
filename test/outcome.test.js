/**
 * Outcome summaries: every run gets a deterministic account of what stopped
 * it, what it produced, and what the model said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { summarizeRun, readStateView } from "../dist/state/outcome.js";

function summary(overrides = {}) {
  return {
    agent: "research",
    status: "blocked",
    request: "plan the work",
    turns: 25,
    modelCalls: 28,
    usage: { totalTokens: 145_798 },
    cost: { actual: 0 },
    ...overrides,
  };
}

test("turn cap summary says what stopped and that no issues were created", () => {
  const outcome = summarizeRun({
    summary: summary({ error: "turn cap reached (25) before the run finished" }),
    events: [
      { t: "2026-11-03T01:41:36.621Z", type: "run_start", agent: "research" },
      { t: "2026-11-03T01:41:44.520Z", type: "tool_call_start", toolCallId: "t1", tool: "read", args: { path: "plans/plan.md", offset: 1, limit: 250 } },
      { t: "2026-11-03T01:41:44.562Z", type: "tool_call", toolCallId: "t1", tool: "read", isError: false },
      { t: "2026-11-03T01:42:05.318Z", type: "model_call_end", text: "Need to read the rest of plan.md.", stopReason: "toolUse" },
      { t: "2026-11-03T01:42:05.326Z", type: "turn_cap", turns: 25 },
    ],
  });
  assert.equal(outcome.stopReason, "turn-cap");
  assert.match(outcome.headline, /turn cap \(25\)/);
  assert.match(outcome.text, /none created — the research run did not create any issues/);
  assert.match(outcome.text, /Read: plans\/plan\.md/);
  assert.match(outcome.text, /Response: none/);
  assert.match(outcome.text, /Last model text: Need to read the rest/);
});

test("completed summary lists created issues, plans, changes, and the response", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "completed", turns: 6, modelCalls: 6, usage: { totalTokens: 4_200 }, cost: { actual: 0.01 } }),
    events: [
      { type: "issue_created", number: 12, kind: "epic", title: "Finish verification" },
      { type: "issue_created", number: 13, kind: "feature", title: "Gates" },
      { type: "plan_updated", issue: 14, status: "ready", verification: "verified" },
      { type: "tool_call_start", toolCallId: "e1", tool: "edit", args: { path: "src/loop.ts" } },
      { type: "tool_call", toolCallId: "e1", tool: "edit", isError: false },
    ],
    finalText: "Result: created the issue graph.\nEvidence: issue tree 12",
  });
  assert.equal(outcome.stopReason, "completed");
  assert.match(outcome.text, /Issues: #12 epic "Finish verification"; #13 feature "Gates"/);
  assert.match(outcome.text, /Plans: #14/);
  assert.match(outcome.text, /Changes: src\/loop\.ts/);
  assert.match(outcome.text, /Response:\nResult: created the issue graph/);
});

test("a repeated tool call block is reported as the stop reason", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "repeated identical tool calls detected" }),
    events: [
      { type: "tool_call_start", toolCallId: "s1", tool: "search", args: { mode: "map", path: "." } },
      { type: "loop_blocked", tool: "search", repeats: 2 },
    ],
  });
  assert.equal(outcome.stopReason, "loop");
  assert.match(outcome.text, /repeated identical tool calls/);
});

test("a completed run with a recovered plan checkpoint is completed", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "completed", error: undefined }),
    events: [
      { type: "loop_blocked", tool: "read", reason: "plan-required", plan: true },
      { type: "plan_recovered", chars: 480 },
      { type: "tool_call_start", toolCallId: "e1", tool: "edit", args: { path: "src/a.ts" } },
      { type: "tool_call", toolCallId: "e1", tool: "edit", isError: false },
    ],
    finalText: "Result: done",
  });
  assert.equal(outcome.stopReason, "completed");
  assert.match(outcome.headline, /^Completed/);
  assert.doesNotMatch(outcome.text, /did not finish cleanly/);
});

test("the terminal loop block decides the headline", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "repeated identical tool calls detected" }),
    events: [
      { type: "loop_blocked", tool: "read", reason: "plan-required", plan: true },
      { type: "loop_blocked", tool: "read", reason: "repeat", repeats: 2 },
    ],
  });
  assert.equal(outcome.stopReason, "loop");
  assert.match(outcome.headline, /repeated identical tool calls/);
  assert.doesNotMatch(outcome.headline, /no concrete build plan/);
});

test("an evidence loop block is reported as no new evidence", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "no new evidence; loop detected" }),
    events: [
      { type: "tool_call_start", toolCallId: "r1", tool: "read", args: { path: "src/cli.ts", offset: 800 } },
      { type: "loop_blocked", tool: "read", reason: "loop", stale: 20 },
    ],
  });
  assert.equal(outcome.stopReason, "loop");
  assert.match(outcome.headline, /no new evidence/);
  assert.match(outcome.text, /no new evidence/);
});

test("a no-progress block is not reported as a repeated identical call", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "research continued without an edit, write, or command" }),
    events: [
      { type: "tool_call_start", toolCallId: "s1", tool: "search", args: { mode: "files", pattern: "src/tui*" } },
      { type: "loop_blocked", tool: "search", reason: "no-progress", noProgressCalls: 12 },
    ],
  });
  assert.equal(outcome.stopReason, "loop");
  assert.match(outcome.headline, /research continued without an edit, write, or command/);
  assert.match(outcome.text, /research continued without an edit, write, or command/);
  assert.doesNotMatch(outcome.text, /repeated identical tool calls/);
});

test("a next-action block says the next action is missing", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "research continued without a next action" }),
    events: [
      { type: "tool_call_start", toolCallId: "s1", tool: "read", args: { path: "src/tui.ts" } },
      { type: "loop_blocked", tool: "read", reason: "next-required", noProgressCalls: 6 },
    ],
  });
  assert.equal(outcome.stopReason, "loop");
  assert.match(outcome.text, /research continued without a next action/);
});

test("summary falls back to the last thinking when the model produced no text", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "turn cap reached (25) before the run finished" }),
    events: [
      { type: "model_request", call: 1 },
      { type: "model_delta", call: 1, kind: "thinking", text: "Read the first chunk. " },
      { type: "model_delta", call: 1, kind: "thinking", text: "Need to read the rest." },
      { type: "turn_cap", turns: 25 },
    ],
  });
  assert.match(outcome.text, /Last thinking: Read the first chunk\. Need to read the rest\./);
});

test("a blocked run with no special stop event reports blocked", () => {
  const outcome = summarizeRun({
    summary: summary({ status: "blocked", error: "acceptance gates failed: typescript:test" }),
    events: [],
  });
  assert.equal(outcome.stopReason, "blocked");
  assert.match(outcome.headline, /Blocked: acceptance gates failed/);
});

test("readStateView reads next action and active decisions without side effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-outcome-"));
  try {
    writeFileSync(
      join(dir, "state.jsonl"),
      [
        JSON.stringify({ type: "phase", phase: "act" }),
        JSON.stringify({ type: "next", text: "create the Epic" }),
        JSON.stringify({
          type: "fact",
          fact: { id: "f_0", kind: "decision", text: "use issue tool directly", turn: 2, status: "active" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const view = readStateView(dir);
    assert.equal(view?.phase, "act");
    assert.equal(view?.nextAction, "create the Epic");
    assert.equal(view?.facts?.[0]?.kind, "decision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
