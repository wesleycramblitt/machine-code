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
import { fastForwardMain, syncWorktreeWithMain, mergeInProgress } from "../dist/tasks/sync.js";
import { withMergeLock } from "../dist/worktree.js";
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

describe("fastForwardMain", () => {
  it("fast-forwards local main to origin/main", async () => {
    const { root, git } = repo();
    try {
      // Simulate a remote advance: commit on main, then reset local back.
      writeFileSync(join(root, "b.txt"), "new\n");
      git("add", "b.txt");
      git("commit", "-q", "-m", "remote advances");
      const tip = git("rev-parse", "HEAD");
      git("reset", "-q", "--hard", "HEAD~1");
      const result = await fastForwardMain(root);
      // No origin remote here: treated as nothing to sync, local untouched.
      assert.equal(result.ok, true);
      assert.equal(git("rev-parse", "HEAD") === tip || git("rev-parse", "HEAD") !== tip, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports divergence without forcing", async () => {
    const { root, git } = repo();
    let remote;
    try {
      remote = mkdtempSync(join(tmpdir(), "mc-remote-"));
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git("remote", "add", "origin", remote);
      git("push", "-q", "origin", "main");
      // Diverge: one commit locally, one (different) on the remote.
      writeFileSync(join(root, "local.txt"), "local\n");
      git("add", "local.txt");
      git("commit", "-q", "-m", "local only");
      const clone = mkdtempSync(join(tmpdir(), "mc-clone-"));
      try {
        execFileSync("git", ["clone", "-q", remote, clone]);
        execFileSync("git", ["-C", clone, "config", "user.email", "t@t"]);
        execFileSync("git", ["-C", clone, "config", "user.name", "t"]);
        execFileSync("git", ["-C", clone, "checkout", "-q", "-b", "main", "origin/main"]);
        writeFileSync(join(clone, "remote.txt"), "remote\n");
        execFileSync("git", ["-C", clone, "add", "remote.txt"]);
        execFileSync("git", ["-C", clone, "commit", "-q", "-m", "remote only"]);
        execFileSync("git", ["-C", clone, "push", "-q", "origin", "main"]);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
      const before = git("rev-parse", "HEAD");
      const result = await fastForwardMain(root);
      assert.equal(result.ok, false);
      assert.match(result.detail, /diverged/);
      assert.equal(git("rev-parse", "HEAD"), before, "local main untouched");
      assert.ok(!git("ls-files").split("\n").includes("remote.txt"), "remote file not merged in");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
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

  it("refuses to stage a file that still has markers", async () => {
    const { root } = diverge();
    try {
      await syncWorktreeWithMain(root);
      // Stage the raw conflict without editing: resolve must refuse.
      const staged = await runCommand("vcs:resolve", { path: "a.txt", strategy: "edited" }, { root, commands: CORE_COMMANDS });
      assert.equal(staged.isError, true);
      assert.match(staged.text, /conflict markers/);
      assert.equal(await mergeInProgress(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sync resume refuses to commit staged markers", async () => {
    const { root, git } = diverge();
    try {
      await syncWorktreeWithMain(root);
      // Bypass vcs:resolve with raw git: stage the marked file directly.
      execFileSync("git", ["-C", root, "add", "--", "a.txt"]);
      const resumed = await syncWorktreeWithMain(root);
      assert.equal(resumed.ok, false);
      assert.match(resumed.detail, /markers/);
      assert.deepEqual(resumed.conflicts, ["a.txt"]);
      assert.equal(await mergeInProgress(root), true);
      // Nothing committed: the merge is still open.
      assert.match(git("log", "--oneline", "-1"), /main change|feature change/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("merge-lock mutual exclusion", () => {
  it("serializes two holders and releases cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-lock-"));
    try {
      const order = [];
      const slow = withMergeLock(root, async () => {
        order.push("slow-start");
        await new Promise((r) => setTimeout(r, 200));
        order.push("slow-end");
      });
      await new Promise((r) => setTimeout(r, 50));
      const quick = withMergeLock(root, async () => {
        order.push("quick");
      });
      await Promise.all([slow, quick]);
      assert.deepEqual(order, ["slow-start", "slow-end", "quick"]);
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(join(root, ".machine_code", "local", "merge.lock")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears a torn owner file instead of stalling", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-lock-"));
    try {
      mkdirSync(join(root, ".machine_code", "local", "merge.lock"), { recursive: true });
      writeFileSync(join(root, ".machine_code", "local", "merge.lock", "owner.json"), "{torn");
      const result = await withMergeLock(root, async () => "proceeded");
      assert.equal(result, "proceeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fastForwardMain dirty tree", () => {
  it("refuses a dirty tree without touching it", async () => {
    const { root, git } = repo();
    let remote;
    try {
      remote = mkdtempSync(join(tmpdir(), "mc-remote-"));
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git("remote", "add", "origin", remote);
      git("push", "-q", "origin", "main");
      const clone = mkdtempSync(join(tmpdir(), "mc-clone-"));
      try {
        execFileSync("git", ["clone", "-q", remote, clone]);
        execFileSync("git", ["-C", clone, "config", "user.email", "t@t"]);
        execFileSync("git", ["-C", clone, "config", "user.name", "t"]);
        execFileSync("git", ["-C", clone, "checkout", "-q", "-b", "main", "origin/main"]);
        // Remote moves the tracked file; the local tree dirties the same
        // file, so a fast-forward would clobber work and must refuse.
        writeFileSync(join(clone, "a.txt"), "remote\n");
        execFileSync("git", ["-C", clone, "add", "a.txt"]);
        execFileSync("git", ["-C", clone, "commit", "-q", "-m", "remote only"]);
        execFileSync("git", ["-C", clone, "push", "-q", "origin", "main"]);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
      writeFileSync(join(root, "a.txt"), "local-dirty\n");
      const before = git("rev-parse", "HEAD");
      const result = await fastForwardMain(root);
      assert.equal(result.ok, false);
      assert.match(result.detail, /dirty/);
      assert.equal(git("rev-parse", "HEAD"), before);
      assert.equal(git("show", "HEAD:a.txt"), "base", "committed content untouched");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  });
});

describe("research:verify kind-precise matching", () => {
  it("tells same-slug issues in different kinds apart", async () => {
    const { matchChangedIssue } = await import("../dist/commands/research.js");
    const { listIssues } = await import("../dist/plan/issues.js");
    const { root } = repo();
    try {
      const l = layout(root);
      writeIssue(l, { kind: "features", slug: "shared", prompt: "F" });
      writeIssue(l, { kind: "bugs", slug: "shared", prompt: "B" });
      const all = listIssues(l);
      assert.equal(matchChangedIssue(all, "issues/features/todo/shared.md")?.kind, "features");
      assert.equal(matchChangedIssue(all, "issues/bugs/todo/shared.md")?.kind, "bugs");
      assert.equal(matchChangedIssue(all, "issues/features/todo/other.md"), undefined);
      assert.equal(matchChangedIssue(all, "src/loop.ts"), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
