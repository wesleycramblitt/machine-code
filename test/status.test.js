/**
 * Phase 7 tests: the pure TUI status model (grouping, rollups, health,
 * header counts, awaiting-human queue) and the issue cache.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildIssueTree,
  filterRuns,
  sortRuns,
  healthOf,
  issueGlyphKind,
  issueRowDetail,
  rollupIssue,
  headerCounts,
  awaitingHuman,
  issueKey,
} from "../dist/tui/status.js";
import { readIssueCache, writeIssueCache, cacheFresh, issueCachePath } from "../dist/issues/cache.js";

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

function issue(n, kind, title, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number: n },
    title,
    body: "",
    state: "open",
    kind,
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: [],
    ...extra,
  };
}

const ref = (n) => ({ provider: "github", repo: "o/r", number: n });

test("filter buckets and sorting", () => {
  const runs = [
    run({ id: "a", status: "running", issue: ref(31) }),
    run({ id: "b", status: "awaiting_input", issue: ref(32) }),
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
  assert.equal(sortRuns(runs, "number")[0].id, "a", "issues 31 before 32");
});

test("health classification covers the priority order", () => {
  const now = Date.now();
  const open = issue(31, "task", "Task");
  assert.equal(healthOf({ ...open, state: "closed" }, [], now), "done");
  assert.equal(healthOf(open, [run({ status: "failed" })], now), "attention");
  assert.equal(healthOf({ ...open, blockedBy: [ref(9)] }, [run({ status: "running" })], now), "blocked");
  assert.equal(healthOf(open, [run({ status: "awaiting_input" })], now), "awaiting-human");
  assert.equal(healthOf(open, [run({ status: "paused" })], now), "paused");
  assert.equal(healthOf(open, [run({ agent: "review", status: "running" })], now), "review");
  const old = new Date(now - 48 * 3600 * 1000).toISOString();
  assert.equal(healthOf(open, [run({ lastActivityAt: old })], now), "stalled");
  assert.equal(healthOf(open, [run({ status: "running" })], now), "on-track");
});

test("issue glyphs show issue state and plan state, not run health", () => {
  assert.equal(issueGlyphKind(issue(10, "epic", "Epic")), "open");
  assert.equal(issueGlyphKind(issue(10, "epic", "Epic", { state: "closed" })), "closed");
  assert.equal(issueGlyphKind(issue(10, "epic", "Epic", { blockedBy: [ref(9)] })), "open");
  assert.equal(issueGlyphKind(issue(20, "feature", "Feature")), "open");
  assert.equal(issueGlyphKind(issue(20, "feature", "Feature", { blockedBy: [ref(9)] })), "blocked");
  assert.equal(issueGlyphKind(issue(20, "feature", "Feature", { state: "closed" })), "closed");
  assert.equal(issueGlyphKind(issue(30, "task", "Task")), "open");
  assert.equal(
    issueGlyphKind(issue(30, "task", "Task", { plan: { status: "draft" } })),
    "draft",
  );
  assert.equal(
    issueGlyphKind(issue(30, "task", "Task", { plan: { status: "ready" } })),
    "ready",
  );
  assert.equal(
    issueGlyphKind(issue(30, "task", "Task", { plan: { status: "ready" }, blockedBy: [ref(9)] })),
    "blocked",
  );
});

test("issue rows progressively hide detail as width shrinks", () => {
  assert.equal(issueRowDetail(160), "full");
  assert.equal(issueRowDetail(120), "full");
  assert.equal(issueRowDetail(119), "medium");
  assert.equal(issueRowDetail(100), "medium");
  assert.equal(issueRowDetail(99), "compact");
  assert.equal(issueRowDetail(84), "compact");
  assert.equal(issueRowDetail(83), "identity");
  assert.equal(issueRowDetail(20), "identity");
});

test("rollups exclude reserved tasks and aggregate runs/cost", () => {
  const now = Date.now();
  const feature = issue(20, "feature", "Feature");
  const t1 = issue(31, "task", "Deliverable A", { parent: feature.ref, state: "closed" });
  const t2 = issue(32, "task", "Deliverable B", { parent: feature.ref });
  const t0 = issue(21, "task", "Task 0: Planning & Review", {
    parent: feature.ref,
    labels: ["mc:reserved"],
    reserved: { for: feature.ref, kind: "feature-pr" },
  });
  const runs = [
    run({ status: "running", cost: { actual: 0.2, estimated: 0 }, issue: t2.ref }),
    run({ status: "completed", cost: { actual: 0.1, estimated: 0 }, issue: t1.ref }),
    run({ status: "awaiting_input", cost: { actual: 0.05, estimated: 0 }, issue: t0.ref }),
  ];
  const rollup = rollupIssue(feature, [], [t1, t2, t0], runs, now);
  assert.equal(rollup.tasksTotal, 2, "reserved Task 0 is not a deliverable");
  assert.equal(rollup.tasksClosed, 1);
  assert.equal(rollup.pct, 50);
  assert.equal(rollup.runsTotal, 3);
  assert.equal(rollup.runsActive, 2);
  assert.ok(Math.abs(rollup.cost - 0.35) < 1e-9);
});

test("epic rollups aggregate nested feature tasks and runs", () => {
  const now = Date.now();
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const t1 = issue(31, "task", "Done", { parent: feature.ref, state: "closed" });
  const t2 = issue(32, "task", "Open", { parent: feature.ref });
  const runs = [
    run({ id: "a", status: "completed", issue: t1.ref, cost: { actual: 0.1, estimated: 0 } }),
    run({ id: "b", status: "running", issue: t2.ref, cost: { actual: 0.2, estimated: 0 } }),
  ];
  const tree = buildIssueTree([epic, feature, t1, t2], runs, now);
  const rollup = tree.epics[0].rollup;
  assert.equal(rollup.tasksClosed, 1);
  assert.equal(rollup.tasksTotal, 2);
  assert.equal(rollup.pct, 50);
  assert.equal(rollup.runsTotal, 2);
  assert.equal(rollup.runsActive, 1);
  assert.ok(Math.abs(rollup.cost - 0.3) < 1e-9);
});

test("buildIssueTree nests epics→features→tasks and separates categories", () => {
  const now = Date.now();
  const epic = issue(10, "epic", "Epic");
  const feature = issue(20, "feature", "Feature", { parent: epic.ref });
  const task = issue(31, "task", "Task", { parent: feature.ref });
  const task0 = issue(21, "task", "Task 0: Planning & Review", {
    parent: feature.ref,
    labels: ["mc:reserved"],
    reserved: { for: feature.ref, kind: "feature-pr" },
  });
  const runs = [
    run({ id: "t31", status: "running", issue: task.ref }),
    run({ id: "t0", status: "completed", issue: task0.ref }),
    run({ id: "plan", agent: "build" }),
    run({ id: "gen", agent: "general" }),
    run({ id: "orphan", issue: ref(999) }),
  ];
  const tree = buildIssueTree([epic, feature, task, task0], runs, now);
  assert.equal(tree.epics.length, 1);
  assert.equal(tree.epics[0].features.length, 1);
  assert.equal(tree.epics[0].features[0].tasks.length, 2);
  assert.ok(tree.epics[0].features[0].tasks[0].task.labels.includes("mc:reserved"), "reserved first");
  assert.equal(tree.epics[0].features[0].rollup.tasksTotal, 1);
  assert.equal(tree.epics[0].features[0].rollup.runsTotal, 2);
  assert.equal(tree.epics[0].rollup.tasksTotal, 1);
  assert.equal(tree.epics[0].rollup.runsTotal, 2);
  assert.deepEqual(tree.planning.map((r) => r.id), []);
  assert.deepEqual(tree.untracked.map((r) => r.id), ["plan", "gen"]);
  assert.deepEqual(tree.orphaned.map((r) => r.id), ["orphan"]);
});

test("header counts and the awaiting-human queue", () => {
  const now = Date.now();
  const runs = [
    run({ id: "a", status: "running" }),
    run({ id: "b", status: "awaiting_input", issue: ref(31) }),
    run({ id: "c", status: "paused" }),
    run({ id: "d", status: "blocked" }),
    run({ id: "e", status: "completed", prState: "open", prNumber: 91, issue: ref(32) }),
  ];
  const counts = headerCounts(runs, now);
  assert.equal(counts.active, 1);
  assert.equal(counts.awaiting, 1);
  assert.equal(counts.paused, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.openPrs, 1);
  assert.equal(counts.approvals, 2);

  const queue = awaitingHuman(runs, now);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].kind, "question");
  assert.equal(queue[1].kind, "pr");
});

test("issue cache round-trips and reports freshness", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cache-"));
  try {
    const layout = {
      home: join(root, "home"),
      machineConfig: "",
      curation: "",
      catalogueFile: "",
      repoRoot: root,
      repoDir: join(root, ".machine_code"),
      localDir: join(root, ".machine_code", "local"),
      policyFile: "",
      runsDir: join(root, ".machine_code", "local", "runs"),
    };
    assert.equal(readIssueCache(layout), null);
    const cache = writeIssueCache(layout, "o/r", [issue(1, "epic", "E")]);
    assert.ok(issueCachePath(layout).endsWith(join("cache", "issues.json")));
    assert.equal(cache.issues.length, 1);
    const loaded = readIssueCache(layout);
    assert.equal(loaded.repo, "o/r");
    assert.equal(cacheFresh(loaded, 60_000), true);
    assert.equal(cacheFresh(loaded, 0, Date.now() + 60_000), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issueKey helper", () => {
  assert.equal(issueKey(ref(31)), "o/r#31");
  assert.equal(issueKey(undefined), null);
});
