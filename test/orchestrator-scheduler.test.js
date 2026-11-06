/**
 * Deterministic scheduler: scope, readiness, dependency order, and active-run
 * suppression. No model calls and no writes.
 *
 * New model: scope is project|epic|feature (project sweeps every feature),
 * only kind==feature issues are scheduled, readiness needs no mc:plan marker,
 * and the reserved-anchor wedge detector is gone (cycle check kept).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planSchedule } from "../dist/orchestrator/scheduler.js";
import { parsePlanMarker, renderPlanMarker } from "../dist/plan/schema.js";

const readyPlan = parsePlanMarker(
  '<!-- mc:plan {"v":1,"status":"ready","role":"build","verification":"verified","worktree":"required"} -->',
).plan;

function ref(number) {
  return { provider: "github", repo: "o/r", number };
}

function issue(number, overrides = {}) {
  const { plan, body, acceptance, ...rest } = overrides;
  return {
    ref: ref(number),
    title: `Issue ${number}`,
    body: body ?? (plan ? renderPlanMarker(plan) : ""),
    state: "open",
    kind: "feature",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: acceptance ?? ["gate passes"],
    ...rest,
  };
}

test("project scope selects ready features in deterministic order", () => {
  const closed = issue(3, { state: "closed" });
  const issues = [
    issue(1),
    issue(2, { blockedBy: [ref(3)] }),
    closed,
    issue(4, { acceptance: [] }),
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
  assert.match(result.tasks.find((task) => task.issue.ref.number === 4).reason, /no acceptance criteria/);
});

test("no mc:plan marker is required for readiness", () => {
  const withPlan = issue(1, { plan: readyPlan });
  const withoutPlan = issue(2);
  const result = planSchedule({ issues: [withPlan, withoutPlan], scope: "project" });
  assert.deepEqual(result.ready.map((task) => task.issue.ref.number), [1, 2]);
  assert.deepEqual(result.tasks.find((task) => task.issue.ref.number === 1).plan, readyPlan);
  assert.equal(result.tasks.find((task) => task.issue.ref.number === 2).plan, undefined);
});

test("feature and epic scopes select features only", () => {
  const epic = issue(10, { kind: "epic", acceptance: [] });
  const feature = issue(11, { parent: ref(10) });
  const otherFeature = issue(12, { parent: ref(10) });
  const unrelated = issue(13);
  const issues = [epic, feature, otherFeature, unrelated];

  const featureResult = planSchedule({ issues, scope: "feature", scopeRef: ref(11) });
  assert.deepEqual(featureResult.tasks.map((entry) => entry.issue.ref.number), [11]);

  const epicResult = planSchedule({ issues, scope: "epic", scopeRef: ref(10) });
  assert.deepEqual(epicResult.tasks.map((entry) => entry.issue.ref.number), [11, 12]);

  const missing = planSchedule({ issues, scope: "feature" });
  assert.match(missing.errors.join("\n"), /requires scopeRef/);
});

test("terminal runs suppress automatic re-dispatch", () => {
  const feature = issue(30);
  const result = planSchedule({
    issues: [feature],
    scope: "project",
    runs: [{ id: "run-1", status: "completed", startedAt: "2026-11-02T00:00:00.000Z", taskIssue: ref(30), issue: ref(30) }],
  });
  assert.equal(result.dispatch.length, 0);
  assert.match(result.tasks[0].reason, /awaiting review\/closure/);
});

test("cycles are reported and not dispatchable", () => {
  const a = issue(20, { blockedBy: [ref(21)] });
  const b = issue(21, { blockedBy: [ref(20)] });
  const result = planSchedule({ issues: [a, b], scope: "project" });
  assert.match(result.errors.join("\n"), /dependency cycle/);
  assert.equal(result.ready.length, 0);
});

test("open blockers gate features with no wedge error", () => {
  const anchor = issue(40);
  const a = issue(45, { blockedBy: [ref(40)] });
  const b = issue(46, { blockedBy: [ref(45)] });
  const result = planSchedule({ issues: [anchor, a, b], scope: "project" });
  assert.equal(result.ready.length, 1);
  assert.deepEqual(result.ready.map((task) => task.issue.ref.number), [40]);
  assert.ok(!result.errors.some((error) => error.includes("wedged")));
  assert.match(result.tasks.find((task) => task.issue.ref.number === 45).reason, /blocked by #40/);
});

test("features chained among themselves dispatch in order", () => {
  const a = issue(45);
  const b = issue(46, { blockedBy: [ref(45)] });
  const result = planSchedule({ issues: [a, b], scope: "project" });
  assert.ok(!result.errors.some((error) => error.includes("wedged")));
  assert.deepEqual(result.ready.map((task) => task.issue.ref.number), [45]);
});

test("a terminal run that never started work does not suppress redispatch", () => {
  const feature = issue(30);
  const setupFailure = {
    id: "run-0",
    status: "blocked",
    startedAt: "2026-11-02T00:00:00.000Z",
    taskIssue: ref(30),
    issue: ref(30),
    modelCalls: 0,
    error: "branch_checked_out: branch mc/feature/30 is already checked out",
  };
  const result = planSchedule({ issues: [feature], scope: "project", runs: [setupFailure] });
  assert.deepEqual(result.ready.map((entry) => entry.issue.ref.number), [30]);
  assert.ok(!result.errors.some((error) => error.includes("awaiting review/closure")));
});
