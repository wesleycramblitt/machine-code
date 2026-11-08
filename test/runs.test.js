/**
 * Runs hierarchy: the All / By plan work tree, per-repo status, and
 * machine-wide overall status.
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
    usage: { input: 0, inputTokens: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { actual: 0, estimated: 0 },
    modelCalls: 1,
    ...overrides,
  };
}

function packetFile(slug, overrides = {}) {
  return { slug, status: "todo", deps: [], blocked: "", deliverable: `Do ${slug}`, files: [], acceptance: [], verify: [], ...overrides };
}

function item(overrides = {}) {
  return {
    plan: "plans/tui.md",
    planTitle: "TUI",
    kind: "feature",
    slug: "item",
    title: "An item",
    done: false,
    line: 0,
    ...overrides,
  };
}

test("All groups items by type across plan files, then packet, then runs", () => {
  const runs = [
    run({ id: "r1", packetId: "fix-login", status: "completed" }),
    run({ id: "r2", packetId: "fix-login", status: "running" }),
    run({ id: "free", agent: "research", mode: "", status: "completed" }),
  ];
  const index = buildRunIndex({
    runs,
    group: "all",
    packetRepo: repoA,
    packets: [packetFile("fix-login", { status: "in-progress" }), packetFile("rate-limiter"), packetFile("orphan-task")],
    planItems: [
      item({ kind: "bug", slug: "fix-login", title: "Fix login", packet: "fix-login" }),
      item({ kind: "feature", slug: "rate-limiter", title: "Add limiter", packet: "rate-limiter" }),
      item({ plan: "plans/models.md", planTitle: "Models", kind: "idea", slug: "try-ollama", title: "Try Ollama" }),
    ],
    preferredRepo: repoA,
  });

  assert.equal(index.group, "all");
  const sectionLabels = index.rows.filter((row) => row.kind === "section").map((row) => row.label);
  assert.deepEqual(sectionLabels, ["Features", "Bugs", "Ideas", "Unplanned packets", "Untracked"]);
  // Items come from different plan files in the same type section.
  const lines = index.rows.filter((row) => row.kind === "planline");
  assert.deepEqual(lines.map((row) => row.slug), ["rate-limiter", "fix-login", "try-ollama"]);
  const packetSlugs = index.rows.filter((row) => row.kind === "packet").map((row) => row.slug);
  assert.deepEqual(packetSlugs, ["rate-limiter", "fix-login", "orphan-task"]);
  const runIds = index.rows.filter((row) => row.kind === "run").map((row) => row.run.id).sort();
  assert.deepEqual(runIds, ["free", "r1", "r2"]);
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free"]);
  assert.equal(index.byRunId.get("r1")?.run.status, "completed");
});

test("By plan groups by plan file, then item type", () => {
  const index = buildRunIndex({
    runs: [],
    group: "plan",
    packetRepo: repoA,
    packets: [packetFile("demo")],
    planItems: [
      item({ plan: "plans/tui.md", planTitle: "TUI", kind: "feature", slug: "demo", title: "Demo", packet: "demo" }),
      item({ plan: "plans/tui.md", planTitle: "TUI", kind: "bug", slug: "blink", title: "Blinking cursor" }),
      item({ plan: "plans/models.md", planTitle: "Models", kind: "feature", slug: "prices", title: "Price table" }),
    ],
    preferredRepo: repoA,
  });
  const sections = index.rows.filter((row) => row.kind === "section");
  assert.deepEqual(
    sections.map((row) => row.label),
    ["Models", "Features", "TUI", "Features", "Bugs"],
  );
  const planSections = sections.filter((row) => row.plan);
  assert.deepEqual(planSections.map((row) => row.plan), ["plans/models.md", "plans/tui.md"]);
  const demo = index.rows.find((row) => row.kind === "planline" && row.slug === "demo");
  assert.ok(demo && demo.kind === "planline");
  assert.equal(demo.itemKind, "feature");
});

test("item status is the checkbox or the linked packet status, done is not a category", () => {
  const index = buildRunIndex({
    runs: [],
    group: "all",
    packetRepo: repoA,
    packets: [packetFile("running", { status: "in-progress" }), packetFile("blocked", { status: "blocked" })],
    planItems: [
      item({ kind: "feature", slug: "running", title: "Running", packet: "running" }),
      item({ kind: "bug", slug: "blocked", title: "Blocked", packet: "blocked" }),
      item({ kind: "feature", slug: "shipped", title: "Shipped", done: true }),
      item({ kind: "idea", slug: "maybe", title: "Maybe" }),
    ],
    preferredRepo: repoA,
  });
  const status = (slug) => index.rows.find((row) => row.kind === "planline" && row.slug === slug).status;
  assert.equal(status("running"), "in-progress");
  assert.equal(status("blocked"), "blocked");
  assert.equal(status("shipped"), "done");
  assert.equal(status("maybe"), "todo");
  // Done items stay under their type, not a Done section.
  const labels = index.rows.filter((row) => row.kind === "section").map((row) => row.label);
  assert.ok(!labels.includes("Done"));
  assert.ok(labels.includes("Features"));
  assert.ok(labels.includes("Ideas"));
});

test("packet rows carry their direct runs and fold", () => {
  const runs = [run({ id: "a", packetId: "demo" }), run({ id: "b", packetId: "demo" })];
  const options = {
    runs,
    group: "all",
    packetRepo: repoA,
    packets: [packetFile("demo")],
    planItems: [item({ kind: "feature", slug: "demo", title: "Do demo", packet: "demo" })],
  };
  const base = buildRunIndex(options);
  const packetRow = base.rows.find((row) => row.kind === "packet");
  assert.ok(packetRow && packetRow.kind === "packet");
  assert.equal(packetRow.directRuns, 2);
  assert.deepEqual(
    base.rows.filter((row) => row.kind === "run" && row.parent === packetRow.id).map((row) => row.run.id).sort(),
    ["a", "b"],
  );

  const collapsed = buildRunIndex({ ...options, collapsed: new Set([packetRow.id]) });
  assert.ok(!collapsed.rows.some((row) => row.kind === "run"));
});

test("per-repo status mode has no work tree", () => {
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
  const runs = [run({ id: "blocked", status: "blocked" }), run({ id: "done", status: "completed" })];
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
    group: "all",
    packetRepo: repoA,
    packets: [packetFile("one"), packetFile("two")],
    planItems: [
      item({ kind: "feature", slug: "one", title: "One", packet: "one" }),
      item({ kind: "feature", slug: "two", title: "Two", packet: "two" }),
    ],
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

  // Items under the same type section are peers; their packets are not.
  assert.deepEqual(bright(packetRow("one")), ["a", "a2", "packet:one"]);
  assert.deepEqual(bright(runRow("a")), ["a", "a2", "packet:one"]);
  assert.equal(focusRowIds(index.rows, index.rows[0]), null);
});

test("unlinked packets appear under Unplanned packets", () => {
  const index = buildRunIndex({
    runs: [run({ id: "r1", packetId: "demo" })],
    group: "all",
    packetRepo: repoA,
    packets: [packetFile("demo"), packetFile("loose")],
    planItems: [item({ kind: "feature", slug: "demo", title: "Do demo", packet: "demo" })],
    preferredRepo: repoA,
  });
  const loose = index.rows.find((row) => row.kind === "packet" && row.slug === "loose");
  assert.ok(loose && loose.kind === "packet");
  assert.match(loose.parent, /unplanned/);
});
