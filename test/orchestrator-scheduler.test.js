/**
 * Deterministic scheduler: scope, readiness, dependency order, and active-run
 * suppression. No model calls and no writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planSchedule } from "../dist/orchestrator/scheduler.js";
import { parsePlanMarker, renderPlanMarker } from "../dist/plan/schema.js";

const readyPlan = parsePlanMarker(
  '<!-- mc:plan {"v":1,"status":"ready","role":"build","verification":"verified","worktree":"required"} -->',
).plan;
const draftPlan = { ...readyPlan, status: "draft" };

function ref(number) {
  return { provider: "github", repo: "o/r", number };
}

function issue(number, overrides = {}) {
  const plan = overrides.plan === undefined ? readyPlan : overrides.plan;
  return {
    ref: ref(number),
    title: `Issue ${number}`,
    body: plan ? renderPlanMarker(plan) : "",
    state: "open",
    kind: "task",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["gate passes"],
    ...overrides,
    ...(plan ? { plan } : {}),
  };
}

test("project scope selects ready tasks in deterministic order", () => {
  const closed = issue(3, { state: "closed" });
  const issues = [
    issue(1),
    issue(2, { blockedBy: [ref(3)] }),
    closed,
    issue(4, { plan: draftPlan }),
    issue(5),
  ];
  const result = planSchedule({
    issues,
    scope: "project",
    runs: [{ status: "running", taskIssue: ref(5), issue: ref(5) }],
    maxParallel: 1,
  });
  assert.deepEqual(result.tasks.map((task) => task.issue.ref.number), [1, 3, 2, 4, 5]);
  assert.deepEqual(result.ready.map((task) => task.issue.ref.number), [1, 2]);
  assert.deepEqual(result.dispatch.map((task) => task.issue.ref.number), [1]);
  assert.equal(result.tasks.find((task) => task.issue.ref.number === 5).ready, false);
  assert.match(result.tasks.find((task) => task.issue.ref.number === 5).reason, /active run/);
  assert.equal(result.tasks.find((task) => task.issue.ref.number === 4).ready, false);
});

test("feature and epic scopes include only descendants", () => {
  const epic = issue(10, { kind: "epic" });
  const feature = issue(11, { kind: "feature", parent: ref(10) });
  const otherFeature = issue(12, { kind: "feature", parent: ref(10) });
  const task = issue(13, { parent: ref(11) });
  const otherTask = issue(14, { parent: ref(12) });
  const issues = [epic, feature, otherFeature, task, otherTask];

  const featureResult = planSchedule({ issues, scope: "feature", scopeRef: ref(11) });
  assert.deepEqual(featureResult.tasks.map((entry) => entry.issue.ref.number), [13]);

  const epicResult = planSchedule({ issues, scope: "epic", scopeRef: ref(10) });
  assert.deepEqual(epicResult.tasks.map((entry) => entry.issue.ref.number), [13, 14]);

  const missing = planSchedule({ issues, scope: "feature" });
  assert.match(missing.errors.join("\n"), /requires scopeRef/);
});

test("cycles are reported and not dispatchable", () => {
  const a = issue(20, { blockedBy: [ref(21)] });
  const b = issue(21, { blockedBy: [ref(20)] });
  const result = planSchedule({ issues: [a, b], scope: "project" });
  assert.match(result.errors.join("\n"), /dependency cycle/);
  assert.equal(result.ready.length, 0);
});
