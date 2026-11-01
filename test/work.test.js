/**
 * Navigable work hierarchy: issues → runs, planning/untracked sections, and
 * attention filtering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWorkIndex } from "../dist/tui/work.js";

const ref = (number) => ({ provider: "github", repo: "o/r", number });
function issue(number, kind, title, extra = {}) {
  return { ref: ref(number), title, body: "", state: "open", kind, labels: [], children: [], blockedBy: [], blocking: [], acceptance: [], ...extra };
}
function run(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, id: overrides.id ?? `run-${Math.random().toString(36).slice(2, 6)}`, repoRoot: "/repo",
    agent: "build", mode: "verified", request: "r", status: "running", pid: 1,
    startedAt: now, lastActivityAt: now, turns: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { actual: 0, estimated: 0 }, modelCalls: 1, ...overrides,
  };
}

test("work index nests issues and runs and separates untracked work", () => {
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const task = issue(31, "task", "Task", { parent: feature.ref });
  const task0 = issue(21, "task", "Task 0", { parent: feature.ref, reserved: { for: feature.ref, kind: "feature-pr" }, labels: ["mc:reserved"] });
  const runs = [
    run({ id: "a", issue: task.ref, status: "awaiting_input" }),
    run({ id: "plan", agent: "architect", mode: "", status: "completed" }),
    run({ id: "free", agent: "general", mode: "", status: "completed" }),
  ];
  const index = buildWorkIndex({ issues: [epic, feature, task, task0], runs });
  assert.equal(index.byRunId.get("a").run.status, "awaiting_input");
  assert.ok(index.rows.some((row) => row.kind === "issue" && row.issue.ref.number === 10));
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free"]);
  assert.deepEqual(index.planning.map((entry) => entry.id), ["plan"]);
  assert.ok(index.attention >= 1);
  const filtered = buildWorkIndex({ issues: [epic, feature, task, task0], runs, attentionOnly: true });
  assert.ok(filtered.rows.some((row) => row.kind === "run" && row.run.id === "a"));
  assert.ok(!filtered.rows.some((row) => row.kind === "run" && row.run.id === "free"));
});
