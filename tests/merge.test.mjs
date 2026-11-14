/**
 * Branch-sync, dependency, and file-footprint tests.
 *
 * These pin the three merge-hardening behaviors:
 *  - an empty `depends:` line is no dependency (it used to become "untitled")
 *  - unknown dependency slugs never block a run forever
 *  - the pre-build sync leaves conflicts for the agent to resolve, and
 *    commits the merge on the next pass
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layout } from "../dist/paths.js";
import { readIssue, writeIssue, findIssue } from "../dist/plan/issues.js";
import { unmetDepends, unknownDepends } from "../dist/tasks/issue.js";
import { overlapFootprints } from "../dist/plan/overlap.js";
import { syncWorktreeWithMain, mergeInProgress } from "../dist/tasks/sync.js";
import { CORE_COMMANDS, runCommand } from "../dist/commands/registry.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "mc-merge-test-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(root, "a.txt"), "base\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  return { root, git };
}

describe("issue depends parsing", () => {
  it("treats an empty depends line as no dependency", () => {
    const { root } = repo();
    try {
      const l = layout(root);
      mkdirSync(join(root, "issues/features/todo"), { recursive: true });
      writeFileSync(
        join(root, "issues/features/todo/empty-dep.md"),
        "depends:\n\n# Empty dependency\n\nBody.\n",
      );
      writeFileSync(
        join(root, "issues/features/todo/undefined-dep.md"),
        "depends: undefined\n\n# Undefined dependency\n\nBody.\n",
      );
      const issue = readIssue(l, "features", "todo", "empty-dep");
      assert.ok(issue);
      assert.deepEqual(issue.depends, []);
      assert.deepEqual(issue.files, []);
      const literal = readIssue(l, "features", "todo", "undefined-dep");
      assert.ok(literal);
      assert.deepEqual(literal.depends, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores unknown dependency slugs but still blocks on known ones", () => {
    const { root } = repo();
    try {
      const l = layout(root);
      writeIssue(l, { kind: "features", slug: "base-thing", prompt: "base" });
      writeIssue(l, { kind: "features", slug: "stale-dep", prompt: "stale", depends: ["gone-issue"] });
      writeIssue(l, { kind: "features", slug: "real-dep", prompt: "real", depends: ["base-thing"] });
      assert.deepEqual(unmetDepends(l, findIssue(l, "stale-dep")), []);
      assert.deepEqual(unknownDepends(l, findIssue(l, "stale-dep")), ["gone-issue"]);
      assert.deepEqual(unmetDepends(l, findIssue(l, "real-dep")), ["base-thing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("file footprints", () => {
  it("matches exact paths, directories, and globs", () => {
    assert.deepEqual(overlapFootprints(["src/loop.ts"], ["src/loop.ts"]), ["src/loop.ts"]);
    assert.deepEqual(overlapFootprints(["src/tools/"], ["src/tools/edit.ts"]), ["src/tools/ ~ src/tools/edit.ts"]);
    assert.deepEqual(overlapFootprints(["src/**/*.ts"], ["src/tools/edit.ts"]), ["src/**/*.ts ~ src/tools/edit.ts"]);
    assert.deepEqual(overlapFootprints(["src/loop.ts"], ["src/select.ts"]), []);
  });
});

describe("syncWorktreeWithMain", () => {
  it("leaves a content conflict in progress, then commits the resolved merge", async () => {
    const { root, git } = repo();
    try {
      git("checkout", "-q", "-b", "feature");
      writeFileSync(join(root, "a.txt"), "feature\n");
      git("commit", "-q", "-am", "feature change");
      git("checkout", "-q", "main");
      writeFileSync(join(root, "a.txt"), "main\n");
      git("commit", "-q", "-am", "main change");
      git("checkout", "-q", "feature");

      const first = await syncWorktreeWithMain(root);
      assert.equal(first.ok, false);
      assert.deepEqual(first.conflicts, ["a.txt"]);
      assert.equal(await mergeInProgress(root), true);
      assert.match(git("status", "--short"), /^UU a\.txt/m);

      // The agent resolves the markers and stages the file.
      writeFileSync(join(root, "a.txt"), "resolved\n");
      git("add", "a.txt");
      const second = await syncWorktreeWithMain(root);
      assert.equal(second.ok, true);
      assert.equal(await mergeInProgress(root), false);
      assert.equal(git("show", "HEAD:a.txt"), "resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("abortOnConflict restores the pre-merge branch", async () => {
    const { root, git } = repo();
    try {
      git("checkout", "-q", "-b", "feature");
      writeFileSync(join(root, "a.txt"), "feature\n");
      git("commit", "-q", "-am", "feature change");
      git("checkout", "-q", "main");
      writeFileSync(join(root, "a.txt"), "main\n");
      git("commit", "-q", "-am", "main change");
      git("checkout", "-q", "feature");

      const result = await syncWorktreeWithMain(root, { abortOnConflict: true });
      assert.equal(result.ok, false);
      assert.deepEqual(result.conflicts, ["a.txt"]);
      assert.equal(await mergeInProgress(root), false);
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(git("show", "HEAD:a.txt"), "feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fast-forwards a branch with no work and reports it up to date", async () => {
    const { root, git } = repo();
    try {
      git("checkout", "-q", "-b", "feature");
      git("checkout", "-q", "main");
      writeFileSync(join(root, "b.txt"), "new\n");
      git("add", "b.txt");
      git("commit", "-q", "-m", "main advances");
      git("checkout", "-q", "feature");

      const result = await syncWorktreeWithMain(root);
      assert.equal(result.ok, true);
      assert.equal(git("show", "HEAD:b.txt"), "new");
      assert.equal(git("rev-list", "--count", "main..HEAD"), "0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("vcs conflict commands", () => {
  function diverge() {
    const { root, git } = repo();
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "a.txt"), "feature\n");
    git("commit", "-q", "-am", "feature change");
    git("checkout", "-q", "main");
    writeFileSync(join(root, "a.txt"), "main\n");
    git("commit", "-q", "-am", "main change");
    git("checkout", "-q", "feature");
    return { root, git };
  }

  it("lists, resolves, and completes a conflicted merge", async () => {
    const { root, git } = diverge();
    try {
      const sync = await syncWorktreeWithMain(root);
      assert.equal(sync.ok, false);

      const listed = await runCommand("vcs:conflicts", {}, { root, commands: CORE_COMMANDS });
      assert.equal(listed.isError, false);
      assert.match(listed.text, /a\.txt/);

      writeFileSync(join(root, "a.txt"), "resolved\n");
      const resolved = await runCommand("vcs:resolve", { path: "a.txt", strategy: "edited" }, { root, commands: CORE_COMMANDS });
      assert.equal(resolved.isError, false);

      const done = await syncWorktreeWithMain(root);
      assert.equal(done.ok, true);
      assert.equal(git("show", "HEAD:a.txt"), "resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts a conflicted merge on request", async () => {
    const { root, git } = diverge();
    try {
      await syncWorktreeWithMain(root);
      assert.equal(await mergeInProgress(root), true);
      const aborted = await runCommand("vcs:merge-abort", {}, { root, commands: CORE_COMMANDS });
      assert.equal(aborted.isError, false);
      assert.equal(await mergeInProgress(root), false);
      assert.equal(git("show", "HEAD:a.txt"), "feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
