/**
 * Phase 1 tests: worktree isolation, issue branches, clean preflight,
 * dependency links, runner commits, removal, and pruning — all inside temp
 * git repositories. No network; no provider keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  mainWorktreeRoot,
  createWorktree,
  removeWorktree,
  commitWorktree,
  pruneWorktrees,
  reusableWorktree,
  reusableWorktreeOwner,
  WorktreeError,
} from "../dist/worktree.js";
import { RunRecorder } from "../dist/state/runs.js";
import { ProcessSupervisor } from "../dist/processes/supervisor.js";
import { readProcessRecords } from "../dist/processes/registry.js";

let COUNTER = 0;

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), `mc-wt-${++COUNTER}-`));
  const gitk = (args, opts = {}) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0 && !opts.allowFail) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result;
  };
  gitk(["init", "-b", "main"]);
  gitk(["config", "user.email", "test@example.com"]);
  gitk(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test repo\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), ".machine_code/local/\nnode_modules/\n", "utf8");
  gitk(["add", "-A"]);
  gitk(["commit", "-m", "init"]);
  return { dir, gitk };
}

function fakeLayout(root) {
  return {
    home: join(root, "machine-home"),
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

test("worktree git helpers are recorded by the supervisor", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const runDir = join(layout.runsDir, "r-supervised");
    const supervisor = new ProcessSupervisor({ runId: "r-supervised", runDir });
    await createWorktree({
      layout,
      runId: "r-supervised",
      kind: "feature",
      issueNumber: 41,
      processes: supervisor,
    });
    const records = readProcessRecords(runDir);
    assert.ok(records.length > 0);
    assert.ok(records.every((record) => record.origin === "tool" && record.name === "worktree:git"));
    assert.ok(records.some((record) => record.status === "exited"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree remove and prune helpers are recorded by the supervisor", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const runDir = join(layout.runsDir, "r-cleanup");
    const supervisor = new ProcessSupervisor({ runId: "r-cleanup", runDir });
    const spec = await createWorktree({
      layout,
      runId: "r-cleanup",
      kind: "run",
      processes: supervisor,
    });
    const beforeRemove = readProcessRecords(runDir).length;
    await removeWorktree({ layout, runId: "r-cleanup", force: true, processes: supervisor });
    const afterRemove = readProcessRecords(runDir).length;
    assert.ok(afterRemove > beforeRemove);

    mkdirSync(join(layout.localDir, "worktrees", "orphan"), { recursive: true });
    const beforePrune = readProcessRecords(runDir).length;
    const result = await pruneWorktrees(layout, supervisor);
    assert.equal(result.removed, 1);
    assert.ok(readProcessRecords(runDir).length > beforePrune);
    assert.ok(!existsSync(spec.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue worktree is created on an mc/<slug> branch from the base branch", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const spec = await createWorktree({
      layout,
      runId: "r1",
      kind: "issue",
      slug: "add-login-form",
    });
    assert.equal(spec.branch, "mc/add-login-form");
    assert.equal(spec.baseBranch, "main");
    assert.ok(spec.createdBranches.includes("mc/add-login-form"));
    assert.ok(existsSync(join(spec.path, "README.md")));

    // Isolation: an edit in the worktree leaves the main tree untouched.
    writeFileSync(join(spec.path, "README.md"), "# edited in worktree\n", "utf8");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# test repo\n");

    // The commit lands on the packet branch only.
    const { sha } = await commitWorktree({ path: spec.path, message: "test commit" });
    assert.ok(sha && /^[0-9a-f]{40}$/.test(sha));
    const baseTip = spawnSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const packetTip = spawnSync("git", ["rev-parse", "mc/add-login-form"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    assert.notEqual(packetTip, baseTip);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dirty main tree blocks creation; runtime state is not a blocker", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    // Non-artifact dirt must fail with the stable code.
    writeFileSync(join(dir, "scratch.txt"), "uncommitted\n", "utf8");
    await assert.rejects(
      createWorktree({ layout, runId: "r-dirty", kind: "run" }),
      (error) => error instanceof WorktreeError && error.code === "worktree_requires_clean_tree",
    );
    rmSync(join(dir, "scratch.txt"));

    // Runtime state under .machine_code is ignored, not a dirty-tree blocker.
    mkdirSync(join(dir, ".machine_code", "local"), { recursive: true });
    writeFileSync(join(dir, ".machine_code", "local", "note.txt"), "runtime\n", "utf8");
    const spec = await createWorktree({ layout, runId: "r-clean", kind: "run" });
    assert.deepEqual(spec.skippedLinks, []);
    assert.deepEqual(spec.materialized, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue branches are reused across runs; same branch cannot be checked out twice", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const first = await createWorktree({ layout, runId: "r-a", kind: "issue", slug: "demo" });
    assert.ok(first.createdBranches.includes("mc/demo"));

    // A second concurrent run on the same packet branch is refused.
    await assert.rejects(
      createWorktree({ layout, runId: "r-b", kind: "issue", slug: "demo" }),
      (error) => error instanceof WorktreeError && error.code === "branch_checked_out",
    );

    // After removing the first worktree (branch kept), the branch is reused.
    await removeWorktree({ layout, runId: "r-a" });
    const second = await createWorktree({ layout, runId: "r-c", kind: "issue", slug: "demo" });
    assert.equal(second.branch, "mc/demo");
    assert.ok(!second.createdBranches.includes("mc/demo"), "existing branch must be reused, not recreated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal parent worktree can be reused by a fork on the same branch", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const spec = await createWorktree({ layout, runId: "r-parent", kind: "issue", slug: "demo" });
    assert.equal(spec.branch, "mc/demo");
    const parent = { worktree: spec.path, branch: spec.branch, status: "failed" };
    assert.equal(reusableWorktree(parent, "mc/demo"), spec.path);
    assert.equal(reusableWorktree({ ...parent, status: "running" }, "mc/demo"), undefined);
    assert.equal(reusableWorktree(parent, "mc/other"), undefined);
    assert.equal(reusableWorktree({ ...parent, worktree: join(dir, "missing") }, "mc/demo"), undefined);
    assert.equal(
      reusableWorktreeOwner([{ ...parent, status: "running" }, parent], "mc/demo")?.path,
      spec.path,
      "skip an active run and use the nearest terminal owner",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("different tasks run concurrently on separate branches; run kind uses mc/run/", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const a = await createWorktree({ layout, runId: "run-a", kind: "task", issueNumber: 31 });
    const b = await createWorktree({ layout, runId: "run-b", kind: "task", issueNumber: 32 });
    assert.notEqual(a.branch, b.branch);
    assert.ok(existsSync(a.path));
    assert.ok(existsSync(b.path));

    const untracked = await createWorktree({ layout, runId: "run-c", kind: "run" });
    assert.equal(untracked.branch, "mc/run/run-c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency links: profiles system removed — no links are loaded", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    const spec = await createWorktree({ layout, runId: "r-links", kind: "run" });
    assert.deepEqual(spec.linkedDirs, []);
    assert.deepEqual(spec.skippedLinks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitWorktree returns null when there is nothing to commit", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const spec = await createWorktree({ layout, runId: "r-empty", kind: "run" });
    const first = await commitWorktree({ path: spec.path, message: "nothing" });
    assert.equal(first.sha, null);
    writeFileSync(join(spec.path, "new.txt"), "data", "utf8");
    const second = await commitWorktree({ path: spec.path, message: "adds new.txt" });
    assert.ok(second.sha && /^[0-9a-f]{40}$/.test(second.sha));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree refuses while an active run owns or shares it, then cleans up", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    // The recorder owns the run id; the worktree must be keyed to it.
    const owner = new RunRecorder(layout, {
      agent: "build",
      mode: "verified",
      request: "mutating",
      repoRoot: dir,
    });
    const spec = await createWorktree({ layout, runId: owner.id, kind: "run" });
    owner.patchSummary({ worktree: spec.path, branch: spec.branch });
    assert.equal(spec.path, join(layout.localDir, "worktrees", owner.id));

    await assert.rejects(
      removeWorktree({ layout, runId: owner.id }),
      (error) => error instanceof WorktreeError && error.code === "worktree_active",
    );

    owner.finalize("completed");
    await removeWorktree({ layout, runId: owner.id, deleteBranch: true });
    assert.ok(!existsSync(spec.path));
    const branches = spawnSync("git", ["branch", "--list", spec.branch], { cwd: dir, encoding: "utf8" }).stdout;
    assert.equal(branches.trim(), "", "branch should be deleted with --delete-branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mainWorktreeRoot resolves the main tree from inside a linked worktree", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const spec = await createWorktree({ layout, runId: "r-inside", kind: "run" });
    assert.equal(await mainWorktreeRoot(spec.path), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneWorktrees removes only orphaned worktree directories", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const recorder = new RunRecorder(layout, {
      agent: "build",
      mode: "verified",
      request: "live",
      repoRoot: dir,
    });
    const live = await createWorktree({ layout, runId: recorder.id, kind: "run" });
    recorder.patchSummary({ worktree: live.path, branch: live.branch });
    recorder.finalize("completed");

    const dead = join(layout.localDir, "worktrees", "r-gone");
    mkdirSync(dead, { recursive: true });

    const { removed } = await pruneWorktrees(layout);
    assert.equal(removed, 1);
    assert.ok(existsSync(live.path), "worktree with a run record must survive");
    assert.ok(!existsSync(dead));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue branches derive from the slug", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const spec = await createWorktree({ layout, runId: "r-slug", kind: "issue", slug: "add-login-form" });
    assert.equal(spec.branch, "mc/add-login-form");
    await removeWorktree({ layout, runId: "r-slug" });

    // Recreating the same packet reuses the kept branch.
    const again = await createWorktree({ layout, runId: "r-again", kind: "issue", slug: "add-login-form" });
    assert.equal(again.branch, "mc/add-login-form");
    assert.ok(!again.createdBranches.includes("mc/add-login-form"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
