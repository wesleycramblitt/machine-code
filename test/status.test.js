import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterRuns,
  sortRuns,
  headerCounts,
  awaitingHuman,
} from "../dist/tui/status.js";

function run(overrides = {}) {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: overrides.id ?? `run-${Math.random().toString(36).slice(2, 7)}`,
    repoRoot: "/repo",
    agent: "build",
    mode: "verified",
    request: "r",
    status: "completed",
    pid: 1,
    startedAt: nowIso,
    lastActivityAt: nowIso,
    turns: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { actual: 0, estimated: 0 },
    modelCalls: 1,
    ...overrides,
  };
}

test("filter buckets and sorting", () => {
  const runs = [
    run({ id: "a", status: "running" }),
    run({ id: "b", status: "awaiting_input" }),
    run({ id: "c", status: "completed", cost: { actual: 0.5, estimated: 0 } }),
    run({ id: "d", status: "blocked" }),
    run({ id: "e", status: "failed" }),
  ];
  assert.deepEqual(filterRuns(runs, "active").map((r) => r.id), ["a", "b"]);
  assert.deepEqual(filterRuns(runs, "awaiting").map((r) => r.id), ["b"]);
  assert.deepEqual(filterRuns(runs, "paused").map((r) => r.id), ["d"]);
  assert.deepEqual(filterRuns(runs, "completed").map((r) => r.id).sort(), ["c", "e"]);
  assert.equal(sortRuns(runs, "cost")[0].id, "c");
  assert.equal(sortRuns(runs, "severity")[0].id, "a");
  assert.deepEqual(sortRuns(runs, "number").map((r) => r.id), ["a", "b", "c", "d", "e"]);
});

test("header counts and the awaiting-human queue", () => {
  const now = Date.now();
  const runs = [
    run({ id: "a", status: "running" }),
    run({ id: "b", status: "awaiting_input", itemId: "demo" }),
    run({ id: "c", status: "paused" }),
    run({ id: "d", status: "blocked" }),
    run({ id: "e", status: "completed", prState: "open", prNumber: 91 }),
  ];
  const counts = headerCounts(runs, now);
  assert.equal(counts.active, 1);
  assert.equal(counts.awaiting, 1);
  assert.equal(counts.blocked, 1);

  const queue = awaitingHuman(runs, now);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, "question");
  assert.equal(queue[0].itemId, "demo");
});
