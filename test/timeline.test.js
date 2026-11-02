/**
 * Timeline selection: streaming deltas are coalesced and render no row, so the
 * cursor must skip them instead of disappearing on an invisible event.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isTimelineEvent, stepTimelineSelection } from "../dist/tui/timeline.js";

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
