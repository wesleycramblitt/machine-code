/**
 * Runs hierarchy: repository grouping, GH issue trees, per-repo status, and
 * machine-wide overall status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRunIndex, focusRowIds, orderIssueTree } from "../dist/tui/runs.js";

const repoA = "/work/alpha";
const repoB = "/work/beta";
const ref = (number, repo = "o/r") => ({ provider: "github", repo, number });
function issue(number, kind, title, extra = {}) {
  return { ref: ref(number), title, body: "", state: "open", kind, labels: [], children: [], blockedBy: [], blocking: [], acceptance: [], ...extra };
}
function run(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: overrides.id ?? `run-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: repoA,
    agent: "build",
    mode: "verified",
    request: "r",
    status: "running",
    pid: 1,
    startedAt: now,
    lastActivityAt: now,
    turns: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { actual: 0, estimated: 0 },
    modelCalls: 1,
    ...overrides,
  };
}

function packetFile(slug, overrides = {}) {
  return { slug, status: "todo", deps: [], blocked: "", deliverable: `Do ${slug}`, files: [], acceptance: [], verify: [], ...overrides };
}

test("packets group by repository, category, packet, then runs", () => {
  const runs = [
    run({ id: "r1", packetId: "fix-login", status: "completed" }),
    run({ id: "r2", packetId: "fix-login", status: "running" }),
    run({ id: "free", agent: "research", mode: "", status: "completed" }),
  ];
  const index = buildRunIndex({
    runs,
    group: "packets",
    packetRepo: repoA,
    packets: [packetFile("fix-login", { status: "in-progress" }), packetFile("rate-limiter"), packetFile("orphan-task")],
    planCategories: {
      categories: [
        { heading: "Bugs", slugs: ["fix-login"] },
        { heading: "Features", slugs: ["rate-limiter"] },
      ],
      orphanSlugs: ["orphan-task"],
    },
    preferredRepo: repoA,
  });

  assert.equal(index.group, "packets");
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "section").map((row) => row.label),
    ["Bugs", "Features", "No plan", "Untracked"],
  );

  const packets = index.rows.filter((row) => row.kind === "packet");
  assert.deepEqual(packets.map((row) => row.slug), ["fix-login", "rate-limiter", "orphan-task"]);

  const fixLogin = packets.find((row) => row.slug === "fix-login");
  assert.equal(fixLogin.directRuns, 2);
  const underFixLogin = index.rows.filter((row) => row.kind === "run" && row.parent === fixLogin.id);
  assert.deepEqual(underFixLogin.map((row) => row.run.id).sort(), ["r1", "r2"]);

  const untrackedRuns = index.rows.filter((row) => row.kind === "run" && row.parent?.includes("untracked"));
  assert.equal(untrackedRuns.length, 1);
  assert.equal(untrackedRuns[0].run.id, "free");
});

test("gh issue groups by repository, then full issue hierarchy and untracked", () => {
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const task = issue(31, "task", "Task", { parent: feature.ref });
  const task0 = issue(21, "task", "Task 0", { parent: feature.ref, reserved: { for: feature.ref, kind: "feature-pr" }, labels: ["mc:reserved"] });
  const otherEpic = issue(5, "epic", "Other Epic", { ref: ref(5, "o/other") });
  const runs = [
    run({ id: "a", issue: task.ref, status: "awaiting_input" }),
    run({ id: "free", agent: "research", mode: "", status: "completed", startedAt: "2026-01-01T00:00:01.000Z", lastActivityAt: "2026-01-01T00:00:01.000Z" }),
    run({ id: "plan", agent: "build", mode: "", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
    run({ id: "b", repoRoot: repoB, issue: otherEpic.ref, status: "blocked" }),
  ];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([
      [repoA, [epic, feature, task, task0]],
      [repoB, [otherEpic]],
    ]),
    preferredRepo: repoA,
  });

  assert.equal(index.group, "gh-issue");
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "repo").map((row) => row.repoRoot),
    [repoA, repoB],
  );
  const repoRow = index.rows[0];
  assert.equal(repoRow.kind, "repo");
  assert.equal(repoRow.count, 3);

  const issueNumbers = index.rows.filter((row) => row.kind === "issue").map((row) => row.issue.ref.number);
  assert.deepEqual(issueNumbers, [10, 20, 21, 31, 5]);
  const runIds = index.rows.filter((row) => row.kind === "run").map((row) => row.run.id);
  assert.deepEqual(new Set(runIds), new Set(["a", "free", "plan", "b"]));
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free", "plan"]);
  assert.deepEqual(index.planning.map((entry) => entry.id), []);
  assert.equal(index.byRunId.get("a")?.run.status, "awaiting_input");
  assert.ok(index.attention >= 2);
});

test("per-repo status mode has no issue grouping", () => {
  const epic = issue(10, "epic", "Epic");
  const runs = [
    run({ id: "run", status: "running" }),
    run({ id: "blocked", status: "blocked" }),
    run({ id: "done", status: "completed" }),
  ];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic]]]),
    group: "status",
  });

  assert.ok(index.rows.some((row) => row.kind === "repo"));
  assert.ok(!index.rows.some((row) => row.kind === "issue"));
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "section").map((row) => row.label),
    ["Running", "Blocked", "Completed"],
  );
  assert.equal(index.rows.filter((row) => row.kind === "run").length, 3);
});

test("overall status mode drops repository headings and sorts by status", () => {
  const runs = [
    run({ id: "done", repoRoot: repoA, status: "completed" }),
    run({ id: "blocked", repoRoot: repoB, status: "blocked" }),
    run({ id: "running", repoRoot: repoB, status: "running" }),
  ];
  const index = buildRunIndex({ runs, group: "overall" });

  assert.ok(!index.rows.some((row) => row.kind === "repo"));
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "section").map((row) => row.label),
    ["Running", "Blocked", "Completed"],
  );
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "run").map((row) => row.run.id),
    ["running", "blocked", "done"],
  );
});

test("gh-issue shows cached issues for a repo with no runs at all", () => {
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const byRepo = new Map([[repoA, [epic, feature]]]);
  const index = buildRunIndex({ runs: [], issuesByRepo: byRepo });
  assert.deepEqual(index.rows.filter((row) => row.kind === "repo").map((row) => row.repoRoot), [repoA]);
  assert.equal(index.rows.find((row) => row.kind === "repo")?.count, 0);
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "issue").map((row) => row.issue.ref.number),
    [10, 20],
  );
  assert.ok(!index.rows.some((row) => row.kind === "section" && row.label === "Untracked"));
  assert.ok(!index.rows.some((row) => row.kind === "run"));

  const searched = buildRunIndex({ runs: [], issuesByRepo: byRepo, text: "zzz-nomatch" });
  assert.deepEqual(searched.rows, []);

  const matched = buildRunIndex({ runs: [], issuesByRepo: byRepo, text: "epic" });
  assert.ok(matched.rows.some((row) => row.kind === "issue" && row.issue.ref.number === 10));

  const status = buildRunIndex({ runs: [], issuesByRepo: byRepo, group: "status" });
  assert.deepEqual(status.rows, []);

  const attention = buildRunIndex({ runs: [], issuesByRepo: byRepo, attentionOnly: true });
  assert.deepEqual(attention.rows, []);
});

test("repository, section, and issue headings fold their contents", () => {
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const task = issue(31, "task", "Task", { parent: feature.ref });
  const runs = [
    run({ id: "a", issue: task.ref }),
    run({ id: "free", agent: "research", mode: "", status: "completed" }),
  ];
  const base = buildRunIndex({ runs, issuesByRepo: new Map([[repoA, [epic, feature, task]]]) });
  const repoId = base.rows[0].id;
  const untracked = base.rows.find((row) => row.kind === "section" && row.label === "Untracked");
  assert.ok(untracked);
  const taskRow = base.rows.find((row) => row.kind === "issue" && row.issue.ref.number === 31);
  assert.ok(taskRow);

  const collapsedRepo = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic, feature, task]]]),
    collapsed: new Set([repoId]),
  });
  assert.equal(collapsedRepo.rows.length, 1);
  assert.equal(collapsedRepo.rows[0].kind, "repo");

  const collapsedSection = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic, feature, task]]]),
    collapsed: new Set([untracked.id]),
  });
  assert.ok(!collapsedSection.rows.some((row) => row.kind === "run" && row.run.id === "free"));

  const collapsedIssue = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic, feature, task]]]),
    collapsed: new Set([taskRow.id]),
  });
  assert.ok(!collapsedIssue.rows.some((row) => row.kind === "run" && row.run.id === "a"));
});

test("a scope-filtered issues map hides other repos issue trees", () => {
  // Contract the Runs page relies on under f=cwd: the caller scopes both
  // runs and issuesByRepo to the cwd repo (see scopedIssueCaches in tui.ts).
  // An unscoped map still shows every repo with cached issues — that is the
  // c2d0192 behavior the scope must mask, not remove.
  const epicA = issue(10, "epic", "Epic A");
  const epicB = issue(11, "epic", "Epic B");
  const scoped = buildRunIndex({
    runs: [],
    issuesByRepo: new Map([[repoA, [epicA]]]),
  });
  assert.deepEqual(
    scoped.rows.filter((row) => row.kind === "repo").map((row) => row.repoRoot),
    [repoA],
  );
  assert.ok(!scoped.rows.some((row) => row.kind === "issue" && row.issue.ref.number === 11));

  const unscoped = buildRunIndex({
    runs: [],
    issuesByRepo: new Map([
      [repoA, [epicA]],
      [repoB, [epicB]],
    ]),
  });
  assert.deepEqual(
    unscoped.rows.filter((row) => row.kind === "repo").map((row) => row.repoRoot),
    [repoA, repoB],
  );
});

test("attention-only keeps blocked/running work and drops completed rows", () => {
  const runs = [
    run({ id: "blocked", status: "blocked" }),
    run({ id: "done", status: "completed" }),
  ];
  const index = buildRunIndex({ runs, group: "overall", attentionOnly: true });
  assert.deepEqual(index.rows.filter((row) => row.kind === "run").map((row) => row.run.id), ["blocked"]);
});

test("runs with an unknown issue fall under orphaned, not untracked", () => {
  const missing = ref(99);
  const runs = [
    run({ id: "orphan", issue: missing }),
    run({ id: "free", agent: "research", mode: "", status: "completed" }),
  ];
  const index = buildRunIndex({ runs, issuesByRepo: new Map([[repoA, []]]) });
  assert.deepEqual(index.orphaned.map((entry) => entry.id), ["orphan"]);
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free"]);
  assert.ok(index.rows.some((row) => row.kind === "section" && row.label === "Orphaned issue"));
});

test("gh issue grouping shows the plan even when no run is linked", () => {
  const epic = issue(8, "epic", "Epic");
  const feature = issue(34, "feature", "Lifecycle", { parent: epic.ref });
  const task36 = issue(36, "task", "GitHub lifecycle", { parent: feature.ref });
  const task37 = issue(37, "task", "Recovery", { parent: feature.ref });
  const task0 = issue(35, "task", "Task 0: Planning & Review", {
    parent: feature.ref,
    reserved: { for: feature.ref, kind: "feature-pr" },
    labels: ["mc:reserved"],
  });
  const runs = [run({ id: "free", agent: "research", mode: "", status: "completed" })];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [task37, task36, task0, feature, epic]]]),
  });

  assert.deepEqual(
    index.rows.filter((row) => row.kind === "issue").map((row) => row.issue.ref.number),
    [8, 34, 35, 36, 37],
  );
  const section = index.rows.find((row) => row.kind === "section" && row.label === "Git issues");
  assert.ok(section);
  assert.equal(section.count, 5);
  assert.deepEqual(
    index.rows
      .filter((row) => row.kind === "issue")
      .map((row) => [row.issue.ref.number, row.depth]),
    [[8, 2], [34, 3], [35, 4], [36, 4], [37, 4]],
  );
});

test("picker orders issues parent-first with real depth", () => {
  const epic = issue(8, "epic", "Epic");
  const feature = issue(34, "feature", "Lifecycle", { parent: epic.ref });
  const task36 = issue(36, "task", "GitHub lifecycle", { parent: feature.ref });
  const task37 = issue(37, "task", "Recovery", { parent: feature.ref });
  const task0 = issue(35, "task", "Task 0: Planning & Review", {
    parent: feature.ref,
    reserved: { for: feature.ref, kind: "feature-pr" },
    labels: ["mc:reserved"],
  });
  const issues = [task37, task36, task0, feature, epic];

  assert.deepEqual(
    orderIssueTree(issues).map((row) => [row.issue.ref.number, row.depth]),
    [[8, 0], [34, 1], [35, 2], [36, 2], [37, 2]],
  );
  assert.deepEqual(
    orderIssueTree(issues, "recovery").map((row) => [row.issue.ref.number, row.depth]),
    [[8, 0], [34, 1], [37, 2]],
  );
});

test("runs page epic rollups include nested features and runs", () => {
  const epic = issue(8, "epic", "Epic");
  const feature1 = issue(34, "feature", "Done", { parent: epic.ref, state: "closed" });
  const feature2 = issue(35, "feature", "Open", { parent: epic.ref });
  const runs = [
    run({ id: "a", status: "completed", issue: feature1.ref }),
    run({ id: "b", status: "running", issue: feature2.ref }),
    run({ id: "c", status: "running", issue: epic.ref }),
  ];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic, feature1, feature2]]]),
  });
  const epicRow = index.rows.find((row) => row.kind === "issue" && row.issue.ref.number === 8);
  const featureRow = index.rows.find((row) => row.kind === "issue" && row.issue.ref.number === 34);
  assert.ok(epicRow && epicRow.kind === "issue");
  assert.ok(featureRow && featureRow.kind === "issue");
  assert.equal(epicRow.rollup.tasksClosed, 1);
  assert.equal(epicRow.rollup.tasksTotal, 2);
  assert.equal(epicRow.rollup.pct, 50);
  assert.equal(epicRow.rollup.runsTotal, 3);
  assert.equal(epicRow.rollup.runsActive, 2);
  assert.equal(featureRow.rollup.tasksTotal, 0, "features have no sub-issues to count");
  assert.equal(featureRow.rollup.pct, undefined);
  assert.equal(featureRow.rollup.runsTotal, 1);
});

test("planning runs appear under the reserved Task 0 anchor", () => {
  const epic = issue(8, "epic", "Epic");
  const feature0 = issue(9, "feature", "Feature 0: Planning & Review", {
    parent: epic.ref,
    reserved: { for: epic.ref, kind: "epic-pr" },
    labels: ["mc:reserved"],
  });
  const task0 = issue(10, "task", "Task 0: Planning & Review", {
    parent: feature0.ref,
    reserved: { for: feature0.ref, kind: "feature-pr" },
    labels: ["mc:reserved"],
  });
  const runs = [run({ id: "plan", agent: "planner", issue: task0.ref })];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic, feature0, task0]]]),
  });

  assert.deepEqual(
    index.rows.filter((row) => row.kind === "issue").map((row) => row.issue.ref.number),
    [8, 9, 10],
  );
  const taskRow = index.rows.find((row) => row.kind === "issue" && row.issue.ref.number === 10);
  assert.ok(taskRow && taskRow.kind === "issue");
  assert.equal(taskRow.directRuns, 1);
  const runRow = index.rows.find((row) => row.kind === "run" && row.run.id === "plan");
  assert.ok(runRow && runRow.kind === "run");
  assert.equal(runRow.parent, taskRow.id);
  const epicRow = index.rows.find((row) => row.kind === "issue" && row.issue.ref.number === 8);
  assert.ok(epicRow && epicRow.kind === "issue");
  assert.equal(epicRow.rollup.runsTotal, 1);
});

test("focus keeps the selected branch, its peers, and descendants bright", () => {
  const epicA = issue(10, "epic", "Epic A");
  const epicB = issue(11, "epic", "Epic B");
  const featureA = issue(20, "feature", "Feature A", { parent: epicA.ref });
  const featureA2 = issue(21, "feature", "Feature A2", { parent: epicA.ref });
  const featureB = issue(22, "feature", "Feature B", { parent: epicB.ref });
  const now = "2026-01-01T00:00:00.000Z";
  const runs = [
    run({ id: "a", issue: featureA.ref, startedAt: now, lastActivityAt: now }),
    run({ id: "a2", issue: featureA.ref, startedAt: now, lastActivityAt: now }),
    run({ id: "b2", issue: featureB.ref, startedAt: now, lastActivityAt: now }),
  ];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epicA, epicB, featureA, featureA2, featureB]]]),
  });
  const issueRow = (number) => {
    const row = index.rows.find((candidate) => candidate.kind === "issue" && candidate.issue.ref.number === number);
    assert.ok(row, `missing issue row #${number}`);
    return row;
  };
  const runRow = (id) => {
    const row = index.rows.find((candidate) => candidate.kind === "run" && candidate.run.id === id);
    assert.ok(row, `missing run row ${id}`);
    return row;
  };
  const bright = (selected) => {
    const focus = focusRowIds(index.rows, selected);
    assert.ok(focus);
    return index.rows
      .filter((row) => (row.kind === "issue" || row.kind === "run") && focus.has(row.id))
      .map((row) => (row.kind === "issue" ? `#${row.issue.ref.number}` : row.run.id))
      .sort();
  };

  assert.deepEqual(bright(issueRow(10)), ["#10", "#11", "#20", "#21"]);
  assert.deepEqual(bright(issueRow(20)), ["#10", "#20", "#21", "a", "a2"]);
  assert.deepEqual(bright(issueRow(22)), ["#11", "#22", "b2"]);
  assert.deepEqual(bright(runRow("a")), ["#10", "#20", "a", "a2"]);
  assert.equal(focusRowIds(index.rows, index.rows[0]), null);
});

test("a Task lists every run associated with it", () => {
  const epic = issue(8, "epic", "Epic");
  const feature = issue(11, "feature", "Feature", { parent: epic.ref });
  const task = issue(19, "task", "Task", { parent: feature.ref });
  const runs = [
    run({ id: "first", issue: task.ref }),
    run({ id: "second", status: "blocked", issue: task.ref }),
  ];
  const index = buildRunIndex({
    runs,
    issuesByRepo: new Map([[repoA, [epic, feature, task]]]),
  });
  const taskRow = index.rows.find((row) => row.kind === "issue" && row.issue.ref.number === 19);
  assert.ok(taskRow && taskRow.kind === "issue");
  assert.equal(taskRow.directRuns, 2);
  assert.deepEqual(
    index.rows
      .filter((row) => row.kind === "run" && row.parent === taskRow.id)
      .map((row) => row.run.id)
      .sort(),
    ["first", "second"],
  );
});

test("planning anchors are always visible, even idle", () => {
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const task0 = issue(21, "task", "Task 0", {
    parent: feature.ref,
    reserved: { for: feature.ref, kind: "feature-pr" },
    labels: ["mc:reserved"],
  });
  const task = issue(31, "task", "Task", { parent: feature.ref });
  const index = buildRunIndex({
    runs: [run({ id: "x", agent: "research", mode: "", status: "completed" })],
    issuesByRepo: new Map([[repoA, [epic, feature, task, task0]]]),
  });
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "issue").map((row) => row.issue.ref.number),
    [10, 20, 21, 31],
  );
});
