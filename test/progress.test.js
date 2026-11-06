/**
 * Evidence-novelty loop detector: repeated evidence kills, new evidence and
 * mutations reset the stale streak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EvidenceTracker } from "../dist/state/progress.js";

test("a repeated evidence key kills after the stale limit", () => {
  const tracker = new EvidenceTracker(3);
  assert.equal(tracker.observe("read:src/a.ts@3:1").loop, false);
  assert.equal(tracker.observe("read:src/a.ts@3:1").loop, false);
  assert.equal(tracker.observe("read:src/a.ts@3:1").loop, false);
  const last = tracker.observe("read:src/a.ts@3:1");
  assert.equal(last.loop, true);
  assert.equal(last.stale, 3);
});

test("a new evidence key resets the stale streak", () => {
  const tracker = new EvidenceTracker(2);
  tracker.observe("a");
  assert.equal(tracker.observe("a").stale, 1);
  assert.equal(tracker.observe("b").stale, 0);
  assert.equal(tracker.observe("b").stale, 1);
  assert.equal(tracker.observe("b").loop, true);
});

test("an edit or mutating command resets the streak", () => {
  const tracker = new EvidenceTracker(2);
  tracker.observe("a");
  tracker.observe("a");
  assert.equal(tracker.observe("a").loop, true);
  assert.deepEqual(tracker.observe(null, true), { loop: false, stale: 0, novel: true });
  assert.equal(tracker.observe("a").stale, 1);
});

test("three identical tool errors stop a stuck loop", () => {
  const tracker = new EvidenceTracker(20, 3);
  assert.equal(tracker.observeError("error:issue:same").loop, false);
  assert.equal(tracker.observeError("error:issue:same").loop, false);
  const third = tracker.observeError("error:issue:same");
  assert.equal(third.loop, true);
  assert.equal(third.stale, 3);
});

test("parallel errors in one model turn are one strike", () => {
  const tracker = new EvidenceTracker(20, 3);
  assert.equal(tracker.observeError("error:issue:same", 5).loop, false);
  assert.equal(tracker.observeError("error:issue:same", 5).loop, false);
  assert.equal(tracker.observeError("error:issue:same", 5).loop, false);
  assert.equal(tracker.observeError("error:issue:same", 6).loop, false);
  assert.equal(tracker.observeError("error:issue:same", 7).loop, true);
});

test("a different error or a success resets the error streak", () => {
  const tracker = new EvidenceTracker(20, 3);
  tracker.observeError("error:issue:a");
  tracker.observeError("error:issue:a");
  assert.equal(tracker.observeError("error:issue:b").loop, false);
  tracker.observeError("error:issue:b");
  assert.equal(tracker.observeError("error:issue:b").loop, true);
  tracker.observe("read:src/a.ts@1", false);
  assert.equal(tracker.observeError("error:issue:b").loop, false);
});

test("memory operations do not count as evidence", () => {
  const tracker = new EvidenceTracker(2);
  tracker.observe("a");
  tracker.observe("a");
  const check = tracker.observe(null, false);
  assert.equal(check.stale, 1);
  assert.equal(check.loop, false);
});
