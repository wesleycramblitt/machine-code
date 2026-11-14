/**
 * Composer issue-mode tests: one primary vs N references.
 *
 * Renders the real new-run composer against a scratch repo and asserts the
 * issues tab behaves: primary mode lists only primary-eligible rows and
 * reference mode lists everything but the main with a purple keep mark.
 * Key handling (r toggle, space-link in primary) is exercised with a stub
 * state/services pair. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layout } from "../dist/paths.js";
import { renderComposer } from "../dist/tui/screens/composer/composer.js";
import { handleComposerKeys } from "../dist/tui/screens/composer/keys.js";
import { resolveTheme } from "../dist/tui/format.js";

const PURPLE_MARK = "\x1b[38;2;";
const GREEN_MARK = "\x1b[38;2;78;201;107m✓";

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-composer-"));
  mkdirSync(join(root, "issues/features/todo"), { recursive: true });
  mkdirSync(join(root, "issues/features/done"), { recursive: true });
  mkdirSync(join(root, "issues/ideas"), { recursive: true });
  writeFileSync(join(root, "issues/features/todo/a-todo.md"), "files: src/a.ts\n\n# Todo A\n\nDo A.\n");
  writeFileSync(
    join(root, "issues/features/done/b-done.md"),
    "id: abc123\nbranch: mc/b-done-abc123\ncommit: deadbeef1234\n\n# Done B\n\nDid B.\n",
  );
  writeFileSync(join(root, "issues/ideas/c-idea.md"), "# Idea C\n\nExplore C.\n");
  return root;
}

function baseRun(agent, item) {
  return {
    agent,
    approval: "human",
    ambiguity: "precise",
    tier: "paid",
    minFit: null,
    floors: "role",
    ...(item ? { item } : {}),
    prompt: "",
  };
}

function render(root, { agent, item, issueMode, included = [], sorted = false }) {
  return renderComposer({
    cols: 100,
    narrow: false,
    bodyH: 40,
    theme: resolveTheme(),
    toast: "",
    run: baseRun(agent, item),
    repoRoot: root,
    home: tmpdir(),
    insert: false,
    cursor: 0,
    colon: false,
    confirm: false,
    contextTab: 0,
    contextItem: 0,
    contextItemKey: null,
    contextFilter: "",
    contextFiltering: false,
    excluded: new Set(),
    included: new Set(included),
    sortSelected: sorted,
    issueMode,
    skillModes: new Map(),
    skillShown: new Map(),
    preview: {
      context: {
        chars: 0,
        promptChars: 0,
        sources: [],
        sections: { issues: 0, docs: 0, skills: 0, scripts: 0, tools: 0, references: 0, files: 0, parents: 0, system: 0 },
        issueChain: [],
        artifacts: { files: [], docs: [], references: [], skills: [], tools: [], scripts: [] },
        warnings: [],
      },
    },
    pickers: { model: null, issue: null },
    agentIsolates: () => true,
    mapTokens: () => [],
  });
}

const slugs = (frame) => frame.contextItemKeys.map((k) => k.split("/").pop().replace(/\.md$/, ""));

describe("composer issue modes", () => {
  it("primary/engineer lists everything, eligible and reference alike", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "engineer", issueMode: "primary" });
      assert.deepEqual(slugs(frame), ["a-todo", "b-done"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reference/engineer lists the same rows, main included and visible", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "engineer", issueMode: "reference" });
      assert.deepEqual(slugs(frame), ["a-todo", "b-done"]);
      const main = render(root, { agent: "engineer", item: "a-todo", issueMode: "reference", included: ["issue:issues/features/todo/a-todo.md"] });
      assert.deepEqual(slugs(main), ["a-todo", "b-done"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reference keeps are purple in both modes, main keep stays green", () => {
    const root = scratchRepo();
    try {
      for (const issueMode of ["reference", "primary"]) {
        const frame = render(root, {
          agent: "engineer",
          issueMode,
          included: ["issue:issues/features/done/b-done.md"],
        });
        const lines = [...(frame.bottomAlign?.above ?? []), ...(frame.bottomAlign?.block ?? [])].join("\n");
        const bLine = lines.split("\n").find((l) => l.includes("b-done"));
        assert.ok(bLine, `done row renders (${issueMode})`);
        assert.ok(bLine.includes(PURPLE_MARK) && bLine.includes("✓"), `reference keep is purple-checked (${issueMode})`);
      }
      const primary = render(root, {
        agent: "engineer",
        item: "a-todo",
        issueMode: "primary",
        included: ["issue:issues/features/todo/a-todo.md"],
      });
      const pLines = [...(primary.bottomAlign?.above ?? []), ...(primary.bottomAlign?.block ?? [])].join("\n");
      const aLine = pLines.split("\n").find((l) => l.includes("a-todo"));
      assert.ok(aLine.includes(GREEN_MARK), "main keep stays green");
      assert.ok(aLine.includes("main issue"), "main row is labeled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("research primary lists only needs-research ideas", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "research", issueMode: "primary" });
      assert.deepEqual(slugs(frame), ["c-idea"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selecting never re-sorts or re-labels rows", () => {
    const root = scratchRepo();
    try {
      const before = render(root, { agent: "engineer", issueMode: "reference" });
      const after = render(root, {
        agent: "engineer",
        issueMode: "reference",
        included: ["issue:issues/features/todo/a-todo.md", "issue:issues/features/done/b-done.md"],
      });
      assert.deepEqual(slugs(after), slugs(before), "order stable across selection");
      const lines = [...(after.bottomAlign?.above ?? []), ...(after.bottomAlign?.block ?? [])].join("\n");
      assert.ok(!lines.split("\n").some((l) => l.includes("issues/features/")), "no full-path rows");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("s sorts selected-first on demand", () => {
    const root = scratchRepo();
    try {
      const plain = render(root, {
        agent: "engineer",
        issueMode: "reference",
        included: ["issue:issues/features/done/b-done.md"],
      });
      assert.deepEqual(slugs(plain), ["a-todo", "b-done"]);
      const sorted = render(root, {
        agent: "engineer",
        issueMode: "reference",
        included: ["issue:issues/features/done/b-done.md"],
        sorted: true,
      });
      assert.deepEqual(slugs(sorted), ["b-done", "a-todo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("s sorts main first, then other included, then rest", () => {
    const root = scratchRepo();
    try {
      const sorted = render(root, {
        agent: "engineer",
        item: "b-done",
        issueMode: "reference",
        included: [
          "issue:issues/features/done/b-done.md",
          "issue:issues/features/todo/a-todo.md",
        ],
        sorted: true,
      });
      // b-done is the main: first even though a-todo builds first.
      // (b-done is done, so it cannot be the run's main in practice;
      // this only exercises the ordering rule.)
      assert.deepEqual(slugs(sorted), ["b-done", "a-todo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("s toggles from any tab", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, { newRunContextSectionKey: "section:files" });
      handleComposerKeys(s, { draw: () => {}, repoRoot: root }, "s");
      assert.equal(s.newRunSortSelected, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mode toggle is a bottom key command", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "engineer", issueMode: "reference" });
      const text = [...(frame.bottomAlign?.above ?? []), ...(frame.bottomAlign?.block ?? [])].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(text, /r.*Mode.*reference/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function stubState(root, overrides = {}) {
  return {
    modelPick: null,
    itemPick: null,
    newRunInsert: false,
    newRunColon: false,
    newRunConfirm: false,
    newRunContextFiltering: false,
    newRunContextFilter: "",
    newRunContextTab: 0,
    newRunContextItem: 0,
    newRunContextItemKey: null,
    newRunContextItemKeys: [],
    newRunContextItemAvailable: [],
    newRunContextSectionKey: "section:issues",
    newRunIssueMode: "primary",
    newRunContextIncluded: new Set(),
    newRunContextExcluded: new Set(),
    newrun: baseRun("engineer"),
    newRunRepo: root,
    ...overrides,
  };
}

describe("composer issue keys", () => {
  it("r toggles primary/reference and resets the cursor", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, {
        newRunContextItemKeys: ["issue:issues/features/todo/a-todo.md"],
        newRunContextItemAvailable: [true],
        newRunContextItem: 0,
      });
      const calls = { draw: 0 };
      const handled = handleComposerKeys(s, { draw: () => { calls.draw += 1; }, repoRoot: root }, "r");
      assert.equal(handled, true);
      assert.equal(s.newRunIssueMode, "reference");
      assert.equal(s.newRunContextItem, 0);
      assert.equal(s.newRunContextItemKey, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("s toggles selected-first sort and resets the cursor", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, {
        newRunContextItemKeys: ["issue:issues/features/todo/a-todo.md"],
        newRunContextItem: 0,
      });
      assert.equal(s.newRunSortSelected, undefined);
      handleComposerKeys(s, { draw: () => {}, repoRoot: root }, "s");
      assert.equal(s.newRunSortSelected, true);
      assert.equal(s.newRunContextItem, 0);
      assert.equal(s.newRunContextItemKey, null);
      handleComposerKeys(s, { draw: () => {}, repoRoot: root }, "s");
      assert.equal(s.newRunSortSelected, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("space in primary mode links the row as the single main", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, {
        newRunContextItemKeys: ["issue:issues/features/todo/a-todo.md"],
        newRunContextItemAvailable: [true],
      });
      let linked = null;
      const ctx = {
        draw: () => {},
        repoRoot: root,
        chooseIssue: (issue) => { linked = issue.slug; },
      };
      const handled = handleComposerKeys(s, ctx, " ");
      assert.equal(handled, true);
      assert.equal(linked, "a-todo");
      assert.equal(s.newRunContextIncluded.size, 0, "primary link does not toggle includes itself");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("space in primary mode refuses ineligible rows", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, {
        newRunContextItemKeys: ["issue:issues/features/done/b-done.md"],
        newRunContextItemAvailable: [true],
      });
      let linked = null;
      const notes = [];
      const ctx = {
        draw: () => {},
        repoRoot: root,
        notify: (m) => notes.push(m),
        chooseIssue: (issue) => { linked = issue.slug; },
      };
      const handled = handleComposerKeys(s, ctx, " ");
      assert.equal(handled, true);
      assert.equal(linked, null);
      assert.ok(notes.some((m) => m.includes("cannot be the main issue")), `notified, got: ${notes.join("; ")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("space in reference mode refuses the main row", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, {
        newRunIssueMode: "reference",
        newrun: { ...baseRun("engineer"), item: "a-todo" },
        newRunContextItemKeys: ["issue:issues/features/todo/a-todo.md"],
        newRunContextItemAvailable: [true],
      });
      let linked = null;
      const notes = [];
      const ctx = {
        draw: () => {},
        repoRoot: root,
        notify: (m) => notes.push(m),
        chooseIssue: (issue) => { linked = issue.slug; },
      };
      // stubState spreads overrides after defaults, but newrun needs the merge above
      s.newrun.item = "a-todo";
      const handled = handleComposerKeys(s, ctx, " ");
      assert.equal(handled, true);
      assert.equal(linked, null);
      assert.ok(!s.newRunContextIncluded.has("issue:issues/features/todo/a-todo.md"));
      assert.ok(notes.some((m) => m.includes("main issue")), `notified, got: ${notes.join("; ")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("space in reference mode toggles the include (no link)", () => {
    const root = scratchRepo();
    try {
      const s = stubState(root, {
        newRunIssueMode: "reference",
        newRunContextItemKeys: ["issue:issues/features/done/b-done.md"],
        newRunContextItemAvailable: [true],
      });
      let linked = null;
      const ctx = {
        draw: () => {},
        repoRoot: root,
        chooseIssue: (issue) => { linked = issue.slug; },
      };
      handleComposerKeys(s, ctx, " ");
      assert.equal(linked, null);
      assert.ok(s.newRunContextIncluded.has("issue:issues/features/done/b-done.md"));
      handleComposerKeys(s, ctx, " ");
      assert.ok(!s.newRunContextIncluded.has("issue:issues/features/done/b-done.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
