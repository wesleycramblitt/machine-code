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

function render(root, { agent, item, issueMode, included = [] }) {
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
    hintsEnabled: false,
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
  it("primary/engineer lists only the actionable todo", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "engineer", issueMode: "primary" });
      assert.deepEqual(slugs(frame), ["a-todo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reference/engineer lists todo + done, never ideas, never the main", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "engineer", issueMode: "reference" });
      assert.deepEqual(slugs(frame), ["a-todo", "b-done"]);
      const main = render(root, { agent: "engineer", item: "a-todo", issueMode: "reference", included: ["issue:issues/features/todo/a-todo.md"] });
      assert.deepEqual(slugs(main), ["b-done"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reference keeps get the purple mark, primary keeps green", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, {
        agent: "engineer",
        issueMode: "reference",
        included: ["issue:issues/features/done/b-done.md"],
      });
      const lines = [...(frame.bottomAlign?.above ?? []), ...(frame.bottomAlign?.block ?? [])].join("\n");
      const bLine = lines.split("\n").find((l) => l.includes("b-done"));
      assert.ok(bLine, "done row renders");
      assert.ok(bLine.includes(PURPLE_MARK) && bLine.includes("✓"), "reference keep is purple-checked");
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

  it("mode hint names the current mode", () => {
    const root = scratchRepo();
    try {
      const frame = render(root, { agent: "engineer", issueMode: "reference" });
      const text = [...(frame.bottomAlign?.above ?? []), frame.secondary].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(text, /r mode: reference/);
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
