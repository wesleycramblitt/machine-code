/**
 * Screen render smoke: every extracted TUI screen executes headlessly and
 * returns a well-shaped frame. Guards the screens/ split — render moves
 * must stay byte-for-byte behavior-preserving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTheme } from "../dist/tui/format.js";
import { renderHeader, renderFooterRows, TABS } from "../dist/tui/screens/chrome.js";
import { renderRunsList } from "../dist/tui/screens/runs-list.js";
import { renderPacket } from "../dist/tui/screens/packet.js";
import { renderRunDetail } from "../dist/tui/screens/run-detail/run-detail.js";
import { renderComposer } from "../dist/tui/screens/composer/composer.js";
import { renderModelsList, renderModelDetail } from "../dist/tui/screens/models.js";
import { renderSpend } from "../dist/tui/screens/spend.js";
import { renderSettings } from "../dist/tui/screens/settings.js";
import { renderDeleteConfirm } from "../dist/tui/screens/delete.js";
import { renderAnswer } from "../dist/tui/screens/answer.js";
import { renderCorrect } from "../dist/tui/screens/correct.js";
import { buildRunIndex } from "../dist/tui/runs.js";

const theme = resolveTheme(undefined);
const vp = { cols: 120, narrow: false, bodyH: 30, theme, toast: "" };
const now = new Date().toISOString();
const run = (o = {}) => ({
  schemaVersion: 2,
  id: "run-abc123",
  repoRoot: "/repo",
  agent: "build",
  mode: "verified",
  request: "do things",
  status: "running",
  pid: 1,
  startedAt: now,
  lastActivityAt: now,
  turns: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
  cost: { actual: 0.01, estimated: 0 },
  modelCalls: 1,
  ...o,
});
const layout = {
  repoRoot: "/tmp",
  home: "/tmp",
  repoDir: "/tmp/.machine_code",
  localDir: "/tmp/.machine_code/local",
  runsDir: "/tmp/x",
  machineConfig: "",
  curation: "",
  catalogueFile: "",
  policyFile: "",
};

test("chrome builds header tabs and footer command rows", () => {
  const h = renderHeader({
    ...vp, page: "runs", screen: "list", runIndicators: ["a"], statusTokens: ["b"],
    modelCount: 0, modelFilter: "", newRunRepo: "/repo", runsList: true,
  });
  assert.ok(h.header.length > 0 && h.runDetailHeader === false);
  assert.equal(TABS.length, 4);
  const f = renderFooterRows({
    ...vp, screen: "list", hideFooter: false, runDetailHeader: false, runHints: "",
    extraActions: "", actions: "act", secondary: "sec", secondaryStyled: false,
    footerCtx: "", footerMapTokens: [],
  });
  assert.ok(f.commandRows.length > 0);
});

test("runs list renders hierarchy rows and footer affordances", () => {
  const index = buildRunIndex({
    runs: [run({ id: "r1", packetId: "p1" })],
    group: "all",
    packetRepo: "/repo",
    issues: [{ kind: "features", slug: "p1", title: "Do the thing", status: "todo", effective: "todo", priority: "medium", review: "none", prompt: "Do the thing", body: "", depends: [], tags: [], plan: "plans/tui.md", planTitle: "TUI", rel: "issues/features/ready/p1.md", path: "/tmp/issues/features/ready/p1.md" }],
    preferredRepo: "/repo",
  });
  const frame = renderRunsList({
    ...vp, runNarrow: false, index, selectedRow: index.selectable[0], focus: null,
    group: "all", reposScope: "cwd", pendingFor: () => null, scroll: 0,
  });
  assert.equal(frame.body.length, 30);
  assert.match(frame.actions, /New run/);
  const flat = frame.body.join("\n");
  assert.match(flat, /\[(Todo|In Progress|Blocked|Done|Needs Research|Researched)\]/, "status name is rendered, not color alone");
  assert.match(flat, /p1/);
});

test("packet renders contract plus attached runs", () => {
  const frame = renderPacket({
    ...vp, slug: "p1",
    issue: {
      slug: "p1", title: "Do the thing", kindLabel: "Feature",
      statusLabel: "Todo", rel: "issues/features/ready/p1.md",
      priority: "medium", review: "none", tags: [], depends: [],
      body: ["# Do the thing", "Deliverable text"],
    },
    runs: [], scroll: 0,
  });
  assert.ok(frame.body.some((line) => line.includes("p1")));
  assert.match(frame.body.join("\n"), /Todo/);
});

test("run detail renders overview and timeline sections", () => {
  const detail = { layout, summary: run({}), events: [], dir: "/tmp" };
  const base = {
    cols: 120, short: false, bodyH: 30, theme, detail, scopedRuns: [],
    runScroll: 0, processSel: 0, processFollow: false, eventSel: 0, eventScroll: 0,
    eventBodyScroll: 0, timelineFollow: true, timelineVerbose: false,
    thinkingScroll: 0, thinkingFollow: true, childSel: 0, expanded: new Set(),
    changes: { status: "", diffStat: "", recent: "" }, mapTokens: () => [],
  };
  const overview = renderRunDetail({ ...base, section: "overview" });
  assert.equal(overview.body.length, 30);
  assert.match(overview.runCwd, /\/repo/);
  assert.match(overview.runHints, /fork/);
  const timeline = renderRunDetail({ ...base, section: "timeline" });
  assert.equal(timeline.body.length, 30);
});

test("composer renders prompt box pinned to the body bottom", () => {
  const frame = renderComposer({
    ...vp,
    run: { agent: "research", preset: "unrestricted", verification: "verified", worktree: true, ask: true, approval: "human", ambiguity: "precise", tier: "free", floors: "role", prompt: "hello" },
    repoRoot: "/tmp", home: "/tmp", insert: false, cursor: 0, colon: false,
    contextTab: 0, contextItem: 0, contextFilter: "", contextFiltering: false,
    excluded: new Set(), included: new Set(), skillModes: new Map(), skillShown: new Map(),
    preview: { context: { chars: 0, promptChars: 0, sources: [], issueChain: [], artifacts: { files: [], knowledge: [], references: [], skills: [], tools: [], scripts: [] }, warnings: [] } },
    pickers: { model: null, packet: null },
    agentIsolates: (agent) => agent === "build",
    mapTokens: () => [],
    lockedSkills: () => [],
  });
  assert.ok(frame.bottomAlign !== null && frame.bottomAlign.block.length > 0);
  assert.match(frame.footerCtx, /ctx/);
});

test("composer issues tab lists issue files for any agent", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "mc-tui-issues-"));
  try {
    mkdirSync(join(root, "issues", "features", "todo"), { recursive: true });
    writeFileSync(
      join(root, "issues", "features", "todo", "demo.md"),
      '---\npriority = "high"\nprompt = "Do demo."\nreview = "none"\n---\n\n# Demo\n',
      "utf8",
    );
    const frame = renderComposer({
      ...vp,
      run: { agent: "research", preset: "unrestricted", verification: "verified", worktree: true, ask: true, approval: "human", ambiguity: "precise", tier: "free", floors: "role", prompt: "hello" },
      repoRoot: root, home: root, insert: false, cursor: 0, colon: false,
      contextTab: 1, contextItem: 0, contextFilter: "", contextFiltering: false,
      excluded: new Set(), included: new Set(["issue:issues/features/todo/demo.md"]), skillModes: new Map(), skillShown: new Map(),
      preview: { context: { chars: 0, promptChars: 0, sources: [{ kind: "issue", ref: "issues/features/todo/demo.md", origin: "explicit", depth: 0, chars: 10, exists: true }], issueChain: [], artifacts: { files: [], knowledge: [], references: [], skills: [], tools: [], scripts: [] }, warnings: [] } },
      pickers: { model: null, packet: null },
      agentIsolates: (agent) => agent === "engineer",
      mapTokens: () => [],
      lockedSkills: () => [],
    });
    const text = [...frame.bottomAlign.above, ...frame.bottomAlign.block].join("\n");
    assert.match(text, /demo/);
    assert.match(text, /issues/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("models list renders rows and detail falls back on missing row", () => {
  const frame = renderModelsList({
    ...vp, home: "/tmp", repoRoot: "/tmp", rows: [], group: "provider", collapsed: new Set(),
    selected: 0, scroll: 0, filterText: "", showAllProviders: true, freeOnly: false,
    codingOnly: false, sort: "capability", probing: new Set(),
  });
  assert.equal(frame.body.length, 30);
  assert.equal(renderModelDetail({ ...vp, home: "/tmp", row: undefined, rows: [], agent: "build", weights: undefined, probing: false, scroll: 0 }), null);
});

test("spend, settings, delete, answer, and correct render frames", () => {
  assert.equal(renderSpend({ ...vp, home: "/tmp", daysWindow: 30, groupBy: "provider", scroll: 0 }).body.length, 30);
  assert.equal(renderSettings({ ...vp, layout, rows: [], selectedIndex: 0, scroll: 0 }).body.length, 30);
  assert.equal(renderDeleteConfirm(undefined, 30), null);
  const del = renderDeleteConfirm(run({}), 30);
  assert.equal(del.body.length, 30);
  assert.match(del.secondary, /run-abc123/);
  const answer = renderAnswer({ cols: 120, bodyH: 30, question: "Q?", options: ["a", "b"], answerText: "", scroll: 0 });
  assert.equal(answer.body.length, 30);
  assert.ok(answer.page > 0);
  const correct = renderCorrect({ cols: 120, bodyH: 30, correctText: "", parentId: "p1", parentWorktree: true });
  assert.equal(correct.body.length, 30);
});
