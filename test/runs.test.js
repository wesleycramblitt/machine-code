/**
 * Runs hierarchy: the All / By plan work tree, lifecycle statuses, and
 * machine-wide status views. A packet is an item's contract, not a row.
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

function contract(slug, overrides = {}) {
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
    archived: false,
    line: 0,
    ...overrides,
  };
}

const line = (index, slug) => index.rows.find((row) => row.kind === "planline" && row.slug === slug);

test("All groups items by type; runs attach to the item, not a packet row", () => {
  const runs = [
    run({ id: "build-1", packetId: "fix-login", itemId: "fix-login", status: "running" }),
    run({ id: "research-1", itemId: "rate-limiter", agent: "research", status: "completed", packetId: undefined }),
    run({ id: "free", agent: "research", mode: "", status: "completed" }),
  ];
  const index = buildRunIndex({
    runs,
    group: "all",
    packetRepo: repoA,
    packets: [contract("fix-login", { status: "in-progress" })],
    planItems: [
      item({ kind: "bug", slug: "fix-login", title: "Fix login" }),
      item({ kind: "idea", slug: "rate-limiter", title: "Add limiter" }),
    ],
    preferredRepo: repoA,
  });

  const labels = index.rows.filter((row) => row.kind === "section").map((row) => row.label);
  assert.deepEqual(labels, ["Bugs", "Ideas", "Untracked runs"]);
  assert.ok(!index.rows.some((row) => row.kind === "packet"), "no packet rows for matched items");

  const fix = line(index, "fix-login");
  assert.ok(fix && fix.kind === "planline");
  assert.equal(fix.status, "in-progress");
  assert.equal(fix.contract, "fix-login");
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "run" && row.parent === fix.id).map((row) => row.run.id),
    ["build-1"],
  );

  const rate = line(index, "rate-limiter");
  assert.ok(rate && rate.kind === "planline");
  assert.equal(rate.status, "researched", "a completed research run promotes the item");
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "run" && row.parent === rate.id).map((row) => row.run.id),
    ["research-1"],
  );
  assert.deepEqual(index.untracked.map((entry) => entry.id), ["free"]);
});

test("lifecycle statuses derive from contract, runs, and markers", () => {
  const runs = [
    run({ id: "r-idea", itemId: "idea-researched", agent: "research", status: "completed", packetId: undefined }),
    run({ id: "r-build", itemId: "building", packetId: "building", status: "running" }),
  ];
  const index = buildRunIndex({
    runs,
    group: "all",
    packetRepo: repoA,
    packets: [
      contract("ready"),
      contract("building", { status: "in-progress" }),
      contract("done-item", { status: "done" }),
      contract("blocked-item", { status: "blocked", blocked: "vendor key" }),
    ],
    planItems: [
      item({ kind: "idea", slug: "idea-new", title: "Idea" }),
      item({ kind: "idea", slug: "idea-researched", title: "Researched idea" }),
      item({ kind: "feature", slug: "unplanned", title: "No contract" }),
      item({ kind: "feature", slug: "ready", title: "Ready" }),
      item({ kind: "feature", slug: "building", title: "Building" }),
      item({ kind: "bug", slug: "done-item", title: "Shipped" }),
      item({ kind: "bug", slug: "blocked-item", title: "Blocked" }),
      item({ kind: "feature", slug: "old", title: "Old", archived: true }),
    ],
    preferredRepo: repoA,
  });
  const status = (slug) => line(index, slug)?.status;
  assert.equal(status("idea-new"), "needs-research");
  assert.equal(status("idea-researched"), "researched");
  assert.equal(status("unplanned"), "needs-planning");
  assert.equal(status("ready"), "ready");
  assert.equal(status("building"), "in-progress");
  assert.equal(status("done-item"), "done");
  assert.equal(status("old"), "archived");
  assert.equal(line(index, "blocked-item")?.blocked, "vendor key");
  // The blocked item still has a lifecycle status, separate from the flag.
  assert.equal(status("blocked-item"), "ready");
});

test("By plan groups by plan file, then item type", () => {
  const index = buildRunIndex({
    runs: [],
    group: "plan",
    packetRepo: repoA,
    packets: [contract("demo")],
    planItems: [
      item({ plan: "plans/tui.md", planTitle: "TUI", kind: "feature", slug: "demo", title: "Demo" }),
      item({ plan: "plans/tui.md", planTitle: "TUI", kind: "bug", slug: "blink", title: "Blinking cursor" }),
      item({ plan: "plans/models.md", planTitle: "Models", kind: "feature", slug: "prices", title: "Price table" }),
    ],
    preferredRepo: repoA,
  });
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "section").map((row) => row.label),
    ["Models", "Features", "TUI", "Features", "Bugs"],
  );
  const demo = line(index, "demo");
  assert.ok(demo && demo.kind === "planline");
  assert.equal(demo.itemKind, "feature");
  assert.equal(demo.contract, "demo");
});

test("collapsing an item hides its runs, and runs fold by parent", () => {
  const runs = [run({ id: "a", itemId: "demo", packetId: "demo" }), run({ id: "b", itemId: "demo", packetId: "demo" })];
  const options = {
    runs,
    group: "all",
    packetRepo: repoA,
    packets: [contract("demo")],
    planItems: [item({ slug: "demo", title: "Demo" })],
  };
  const base = buildRunIndex(options);
  const row = line(base, "demo");
  assert.ok(row && row.kind === "planline");
  assert.equal(row.collapsible, true);
  assert.deepEqual(
    base.rows.filter((entry) => entry.kind === "run" && entry.parent === row.id).map((entry) => entry.run.id).sort(),
    ["a", "b"],
  );
  const collapsed = buildRunIndex({ ...options, collapsed: new Set([row.id]) });
  assert.ok(!collapsed.rows.some((entry) => entry.kind === "run"));
});

test("contracts with no plan item surface as orphaned contracts", () => {
  const index = buildRunIndex({
    runs: [run({ id: "orphan-run", packetId: "loose" })],
    group: "all",
    packetRepo: repoA,
    packets: [contract("loose")],
    planItems: [item({ slug: "demo", title: "Demo", packet: "demo" })],
  });
  const labels = index.rows.filter((row) => row.kind === "section").map((row) => row.label);
  assert.ok(labels.includes("Orphaned contracts"));
  const orphan = index.rows.find((row) => row.kind === "packet" && row.slug === "loose");
  assert.ok(orphan && orphan.kind === "packet");
  assert.match(orphan.parent, /orphans/);
});

test("category sections carry a type tone", () => {
  const index = buildRunIndex({
    runs: [],
    group: "all",
    packetRepo: repoA,
    packets: [],
    planItems: [
      item({ kind: "feature", slug: "f", title: "F" }),
      item({ kind: "bug", slug: "b", title: "B" }),
      item({ kind: "idea", slug: "i", title: "I" }),
    ],
  });
  const tones = Object.fromEntries(
    index.rows.filter((row) => row.kind === "section").map((row) => [row.label, row.tone]),
  );
  assert.equal(tones.Features, "feature");
  assert.equal(tones.Bugs, "bug");
  assert.equal(tones.Ideas, "idea");
});

test("per-repo status mode has no work tree", () => {
  const runs = [
    run({ id: "run", status: "running" }),
    run({ id: "blocked", status: "blocked" }),
    run({ id: "done", status: "completed" }),
  ];
  const index = buildRunIndex({ runs, group: "status" });
  assert.ok(index.rows.some((row) => row.kind === "repo"));
  assert.ok(!index.rows.some((row) => row.kind === "planline"));
  assert.deepEqual(
    index.rows.filter((row) => row.kind === "section").map((row) => row.label),
    ["Running", "Blocked", "Completed"],
  );
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

test("focus keeps the selected item and its runs bright", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const runs = [
    run({ id: "a", itemId: "one", packetId: "one", startedAt: now, lastActivityAt: now }),
    run({ id: "a2", itemId: "one", packetId: "one", startedAt: now, lastActivityAt: now }),
  ];
  const index = buildRunIndex({
    runs,
    group: "all",
    packetRepo: repoA,
    packets: [contract("one")],
    planItems: [item({ slug: "one", title: "One" }), item({ slug: "two", title: "Two" })],
  });
  const one = line(index, "one");
  const runA = index.rows.find((row) => row.kind === "run" && row.run.id === "a");
  const bright = (selected) => {
    const focus = focusRowIds(index.rows, selected);
    assert.ok(focus);
    return index.rows
      .filter((row) => (row.kind === "planline" || row.kind === "run") && focus.has(row.id))
      .map((row) => (row.kind === "planline" ? `item:${row.slug}` : row.run.id))
      .sort();
  };
  assert.deepEqual(bright(one), ["a", "a2", "item:one", "item:two"]);
  assert.deepEqual(bright(runA), ["a", "a2", "item:one"]);
  assert.equal(focusRowIds(index.rows, index.rows[0]), null);
});
