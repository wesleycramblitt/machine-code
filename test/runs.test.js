/**
 * Runs hierarchy: packets grouping, per-repo status, and machine-wide
 * overall status.
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
    planItems: [
      { heading: "Bugs", slug: "fix-login", title: "Fix login", done: false, packet: "fix-login" },
      { heading: "Features", slug: "rate-limiter", title: "Add limiter", done: false, packet: "rate-limiter" },
    ],
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
    index.rows.filter((row) => row.kind === "repo").map((row) => row.repoRoot),
    [repoA],
  );
  const sectionLabels = index.rows.filter((row) => row.kind === "section").map((row) => row.label);
  assert.ok(sectionLabels.includes("Bugs"));
  assert.ok(sectionLabels.includes("Features"));
  assert.ok(sectionLabels.includes("Unplanned packets"));
  assert.ok(sectionLabels.includes("Untracked"));
  const packetSlugs = index.rows.filter((row) => row.kind === "packet").map((row) => row.slug);
  assert.deepEqual(packetSlugs, ["fix-login", "rate-limiter", "orphan-task"]);
  const runIds = index.rows.filter((row) => row.kind === "run").map((row) => row.run.id).sort();
  assert.deepEqual(runIds, ["free", "r1", "r2"]);
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free"]);
  assert.equal(index.byRunId.get("r1")?.run.status, "completed");
  assert.ok(index.attention >= 1);
});

test("packet rows carry their direct runs and fold", () => {
  const runs = [
    run({ id: "a", packetId: "demo" }),
    run({ id: "b", packetId: "demo" }),
  ];
  const base = buildRunIndex({
    runs,
    group: "packets",
    packetRepo: repoA,
    packets: [packetFile("demo")],
    planItems: [{ heading: "Work", slug: "demo", title: "Do demo", done: false, packet: "demo" }],
    planCategories: { categories: [{ heading: "Work", slugs: ["demo"] }], orphanSlugs: [] },
  });
  const packetRow = base.rows.find((row) => row.kind === "packet");
  assert.ok(packetRow && packetRow.kind === "packet");
  assert.equal(packetRow.directRuns, 2);
  assert.deepEqual(
    base.rows.filter((row) => row.kind === "run" && row.parent === packetRow.id).map((row) => row.run.id).sort(),
    ["a", "b"],
  );

  const collapsed = buildRunIndex({
    runs,
    group: "packets",
    packetRepo: repoA,
    packets: [packetFile("demo")],
    planItems: [{ heading: "Work", slug: "demo", title: "Do demo", done: false, packet: "demo" }],
    planCategories: { categories: [{ heading: "Work", slugs: ["demo"] }], orphanSlugs: [] },
    collapsed: new Set([packetRow.id]),
  });
  assert.ok(!collapsed.rows.some((row) => row.kind === "run"));
});

test("per-repo status mode has no packet grouping", () => {
  const runs = [
    run({ id: "run", status: "running" }),
    run({ id: "blocked", status: "blocked" }),
    run({ id: "done", status: "completed" }),
  ];
  const index = buildRunIndex({ runs, group: "status" });

  assert.ok(index.rows.some((row) => row.kind === "repo"));
  assert.ok(!index.rows.some((row) => row.kind === "packet"));
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

test("attention-only keeps blocked/running work and drops completed rows", () => {
  const runs = [
    run({ id: "blocked", status: "blocked" }),
    run({ id: "done", status: "completed" }),
  ];
  const index = buildRunIndex({ runs, group: "overall", attentionOnly: true });
  assert.deepEqual(index.rows.filter((row) => row.kind === "run").map((row) => row.run.id), ["blocked"]);
});

test("focus keeps the selected branch, its peers, and descendants bright", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const runs = [
    run({ id: "a", packetId: "one", startedAt: now, lastActivityAt: now }),
    run({ id: "a2", packetId: "one", startedAt: now, lastActivityAt: now }),
    run({ id: "b2", packetId: "two", startedAt: now, lastActivityAt: now }),
  ];
  const index = buildRunIndex({
    runs,
    group: "packets",
    packetRepo: repoA,
    packets: [packetFile("one"), packetFile("two")],
    planItems: [
      { heading: "W", slug: "one", title: "One", done: false, packet: "one" },
      { heading: "W", slug: "two", title: "Two", done: false, packet: "two" },
    ],
    planCategories: { categories: [{ heading: "W", slugs: ["one", "two"] }], orphanSlugs: [] },
  });
  const packetRow = (slug) => {
    const row = index.rows.find((candidate) => candidate.kind === "packet" && candidate.slug === slug);
    assert.ok(row, `missing packet row ${slug}`);
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
      .filter((row) => (row.kind === "packet" || row.kind === "run") && focus.has(row.id))
      .map((row) => (row.kind === "packet" ? `packet:${row.slug}` : row.run.id))
      .sort();
  };

  // Packets now nest under their plan line, so a sibling plan line is the
  // peer — not the sibling packet under it.
  assert.deepEqual(bright(packetRow("one")), ["a", "a2", "packet:one"]);
  assert.deepEqual(bright(runRow("a")), ["a", "a2", "packet:one"]);
  assert.equal(focusRowIds(index.rows, index.rows[0]), null);
});

test("packets nest under their plan line; unplanned packets and plans get sections", () => {
  const index = buildRunIndex({
    runs: [run({ id: "r1", packetId: "demo" })],
    group: "packets",
    packetRepo: repoA,
    packets: [packetFile("demo"), packetFile("loose")],
    plans: [{ path: "plans/tui.md", title: "TUI work" }],
    planItems: [{ heading: "Features", slug: "demo", title: "Do demo", done: false, packet: "demo" }],
    preferredRepo: repoA,
  });
  const line = index.rows.find((row) => row.kind === "planline");
  assert.ok(line && line.kind === "planline");
  assert.equal(line.title, "Do demo");
  const demo = index.rows.find((row) => row.kind === "packet" && row.slug === "demo");
  assert.ok(demo && demo.kind === "packet");
  assert.equal(demo.parent, line.id, "packet nests under its plan line");
  const labels = index.rows.filter((row) => row.kind === "section").map((row) => row.label);
  assert.ok(labels.includes("Features"));
  assert.ok(labels.includes("Unplanned packets"));
  assert.ok(labels.includes("Plans"));
  const loose = index.rows.find((row) => row.kind === "packet" && row.slug === "loose");
  assert.ok(loose && loose.kind === "packet");
  assert.match(loose.parent, /unplanned/);
  const plan = index.rows.find((row) => row.kind === "plan");
  assert.ok(plan && plan.kind === "plan");
  assert.equal(plan.path, "plans/tui.md");
});
