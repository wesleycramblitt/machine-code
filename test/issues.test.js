/**
 * Issues: directory status, YAML front-matter, list/move, migrations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findIssue, listIssues, moveIssue, parseIssueFile, statusesForKind, writeIssue } from "../dist/plan/issues.js";

function fakeLayout(root) {
  return {
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
}

test("writeIssue creates front-matter plus body under kind/status", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-issue-create-"));
  try {
    const layout = fakeLayout(root);
    const issue = writeIssue(layout, {
      kind: "features",
      slug: "fast-lookup",
      prompt: "Make lookups fast.",
      priority: "high",
      tags: ["tui"],
      review: "human",
    });
    assert.equal(issue.rel, "issues/features/todo/fast-lookup.md");
    assert.equal(issue.status, "todo");
    const text = readFileSync(issue.path, "utf8");
    assert.match(text, /priority = "high"/);
    assert.match(text, /prompt = "Make lookups fast\."/);
    assert.match(text, /review = "human"/);
    const found = findIssue(layout, "fast-lookup");
    assert.equal(found?.kind, "features");
    assert.equal(found?.priority, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moveIssue relocates between status directories", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-issue-move-"));
  try {
    const layout = fakeLayout(root);
    const created = writeIssue(layout, { kind: "ideas", slug: "pigeon", prompt: "Consider pigeons." });
    assert.equal(created.status, "needs-research");
    const moved = moveIssue(layout, "pigeon", "researched");
    assert.equal(moved?.status, "researched");
    assert.ok(!existsSync(created.path));
    assert.ok(existsSync(moved.path));
    assert.equal(findIssue(layout, "pigeon")?.status, "researched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listIssues skips non-status dirs; statusesForKind lists legal dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-issue-list-"));
  try {
    const layout = fakeLayout(root);
    writeIssue(layout, { kind: "bugs", slug: "blink", prompt: "Fix blinking." });
    writeIssue(layout, { kind: "ideas", slug: "thing", prompt: "Idea." });
    assert.deepEqual(statusesForKind("ideas"), ["needs-research", "researched"]);
    assert.deepEqual(statusesForKind("features"), ["todo", "blocked", "done"]);
    const all = listIssues(layout);
    assert.deepEqual(all.map((issue) => issue.slug).sort(), ["blink", "thing"]);
    const { front, body } = parseIssueFile("---\npriority = \"low\"\n---\n\n# Title\n\nBody.\n");
    assert.equal(front.priority, "low");
    assert.match(body, /# Title/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
