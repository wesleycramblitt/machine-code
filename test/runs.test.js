/**
 * Runs hierarchy: the All / By type work tree over directory statuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRunIndex, focusRowIds } from "../dist/tui/runs.js";

const repoA = "/work/alpha";
const repoB = "/work/beta";

function run(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: overrides.id ?? `run-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: repoA,
    agent: "engineer",
    mode: "verified",
    request: "r",
    status: "running",
    pid: 1,
    startedAt: now,
    lastActivityAt: now,
    turns: 1,
    usage: { input: 0, inputTokens: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { actual: 0, estimated: 0 },
    modelCalls: 1,
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    kind: "features",
    status: "todo",
    slug: "item",
    title: "An item",
    priority: "medium",
    prompt: "Do it",
    body: "# An item\n",
    depends: [],
    tags: [],
    review: "none",
    rel: "issues/features/ready/item.md",
    path: "/tmp/issues/features/ready/item.md",
    ...overrides,
  };
}

const row = (index, slug) => index.rows.find((entry) => entry.kind === "issue" && entry.slug === slug);

test("All groups issues by kind; runs attach to the issue", () => {
  const runs = [
    run({ id: "build-1", itemId: "fix-login", status: "running" }),
    run({ id: "research-1", itemId: "try-thing", agent: "research", status: "completed" }),
    run({ id: "free", agent: "research", mode: "", status: "completed" }),
  ];
  const index = buildRunIndex({
    runs,
    group: "all",
    packetRepo: repoA,
    issues: [
      issue({ kind: "bugs", status: "in-progress", slug: "fix-login", title: "Fix login" }),
      issue({ kind: "ideas", status: "needs-research", slug: "try-thing", title: "Try the thing" }),
    ],
    preferredRepo: repoA,
  });
  assert.deepEqual(
    index.rows.filter((entry) => entry.kind === "section").map((entry) => entry.label),
    ["Ideas", "Bugs", "Untracked runs"],
  );
  const fix = row(index, "fix-login");
  assert.ok(fix && fix.kind === "issue");
  assert.equal(fix.status, "in-progress");
  assert.deepEqual(
    index.rows.filter((entry) => entry.kind === "run" && entry.parent === fix.id).map((entry) => entry.run.id),
    ["build-1"],
  );
  const idea = row(index, "try-thing");
  assert.ok(idea && idea.kind === "issue");
  assert.deepEqual(
    index.rows.filter((entry) => entry.kind === "run" && entry.parent === idea.id).map((entry) => entry.run.id),
    ["research-1"],
  );
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free"]);
});

test("a ready issue with a live run reads in-progress without moving", () => {
  const index = buildRunIndex({
    runs: [run({ id: "r1", itemId: "live", status: "running" })],
    group: "all",
    packetRepo: repoA,
    issues: [issue({ status: "todo", slug: "live", title: "Live" })],
  });
  const live = row(index, "live");
  assert.ok(live && live.kind === "issue");
  assert.equal(live.status, "todo");
  assert.equal(live.effective, "in-progress");
});

test("By type groups kind, then status directory", () => {
  const index = buildRunIndex({
    runs: [],
    group: "type",
    packetRepo: repoA,
    issues: [
      issue({ kind: "features", status: "todo", slug: "demo", title: "Demo" }),
      issue({ kind: "features", status: "blocked", slug: "plan-me", title: "Plan" }),
      issue({ kind: "ideas", status: "needs-research", slug: "idea-1", title: "Idea" }),
    ],
  });
  assert.deepEqual(
    index.rows.filter((entry) => entry.kind === "section").map((entry) => entry.label),
    ["Ideas", "Needs Research", "Features", "Todo", "Blocked"],
  );
  const demo = row(index, "demo");
  assert.ok(demo && demo.kind === "issue");
  assert.equal(demo.priority, "medium");
});

test("collapsing an issue hides its runs", () => {
  const runs = [run({ id: "a", itemId: "demo" }), run({ id: "b", itemId: "demo" })];
  const options = {
    runs,
    group: "all",
    packetRepo: repoA,
    issues: [issue({ slug: "demo", title: "Demo" })],
  };
  const base = buildRunIndex(options);
  const entry = row(base, "demo");
  assert.ok(entry && entry.kind === "issue");
  assert.equal(entry.collapsible, true);
  assert.deepEqual(
    base.rows.filter((r) => r.kind === "run" && r.parent === entry.id).map((r) => r.run.id).sort(),
    ["a", "b"],
  );
  const collapsed = buildRunIndex({ ...options, collapsed: new Set([entry.id]) });
  assert.ok(!collapsed.rows.some((r) => r.kind === "run"));
});

test("category sections carry a type tone", () => {
  const index = buildRunIndex({
    runs: [],
    group: "all",
    packetRepo: repoA,
    issues: [
      issue({ kind: "features", slug: "f", title: "F" }),
      issue({ kind: "bugs", slug: "b", title: "B" }),
      issue({ kind: "ideas", slug: "i", title: "I" }),
    ],
  });
  const tones = Object.fromEntries(index.rows.filter((r) => r.kind === "section").map((r) => [r.label, r.tone]));
  assert.equal(tones.Features, "feature");
  assert.equal(tones.Bugs, "bug");
  assert.equal(tones.Ideas, "idea");
});

test("focus keeps the selected issue and its runs bright", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const runs = [
    run({ id: "a", itemId: "one", startedAt: now, lastActivityAt: now }),
    run({ id: "a2", itemId: "one", startedAt: now, lastActivityAt: now }),
  ];
  const index = buildRunIndex({
    runs,
    group: "all",
    packetRepo: repoA,
    issues: [
      issue({ kind: "features", slug: "one", title: "One" }),
      issue({ kind: "features", slug: "two", title: "Two" }),
    ],
  });
  const one = row(index, "one");
  const runA = index.rows.find((entry) => entry.kind === "run" && entry.run.id === "a");
  const bright = (selected) => {
    const focus = focusRowIds(index.rows, selected);
    assert.ok(focus);
    return index.rows
      .filter((entry) => (entry.kind === "issue" || entry.kind === "run") && focus.has(entry.id))
      .map((entry) => (entry.kind === "issue" ? `issue:${entry.slug}` : entry.run.id))
      .sort();
  };
  assert.deepEqual(bright(one), ["a", "a2", "issue:one", "issue:two"]);
  assert.deepEqual(bright(runA), ["a", "a2", "issue:one"]);
  assert.equal(focusRowIds(index.rows, index.rows[0]), null);
});

test("status mode and overall status still group raw runs", () => {
  const runs = [
    run({ id: "done", repoRoot: repoA, status: "completed" }),
    run({ id: "blocked", repoRoot: repoB, status: "blocked" }),
    run({ id: "running", repoRoot: repoB, status: "running" }),
  ];
  const status = buildRunIndex({ runs, group: "status" });
  assert.ok(status.rows.some((r) => r.kind === "repo"));
  assert.ok(!status.rows.some((r) => r.kind === "issue"));
  const overall = buildRunIndex({ runs, group: "overall" });
  assert.ok(!overall.rows.some((r) => r.kind === "repo"));
  assert.deepEqual(
    overall.rows.filter((r) => r.kind === "run").map((r) => r.run.id),
    ["running", "blocked", "done"],
  );
});

test("By category groups issues by their first tag", () => {
  const index = buildRunIndex({
    runs: [],
    group: "category",
    packetRepo: repoA,
    issues: [
      issue({ kind: "features", slug: "a", title: "A", tags: ["tui"] }),
      issue({ kind: "bugs", slug: "b", title: "B", tags: ["tui", "models"] }),
      issue({ kind: "features", slug: "c", title: "C", tags: [] }),
    ],
  });
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "section").map((row) => row.label),
    ["tui", "Untagged"],
  );
  const sections = index.rows.filter((row) => row.kind === "section");
  assert.equal(sections[0]?.tone, "category");
});
