/**
 * Destructive issue cleanup: subtree gating, cascade deletion order, and
 * branch cleanup for both the Feature branch and legacy Task branches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deleteIssue } from "../dist/tasks/delete.js";
import { addTombstones, readIssueCache, removeTombstones, writeIssueCache } from "../dist/issues/cache.js";
import { RunRecorder } from "../dist/state/runs.js";

function layout(root) {
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

function issue(number, kind, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number },
    title: `${kind} ${number}`,
    body: "",
    state: "open",
    kind,
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: [],
    ...extra,
  };
}

class FakeProvider {
  constructor(issues) {
    this.kind = "github";
    this.map = new Map(issues.map((i) => [i.ref.number, i]));
    this.deleted = [];
  }
  async get(ref) { return this.map.get(ref.number) ?? null; }
  async children(ref) {
    return [...this.map.values()].filter((candidate) => candidate.parent?.number === ref.number);
  }
  async delete(ref) {
    this.deleted.push(ref.number);
    this.map.delete(ref.number);
  }
}

const machine = {};

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

test("cascade deletes children before the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-"));
  try {
    const parent = issue(20, "feature");
    const child = issue(31, "feature", { parent: parent.ref });
    parent.children.push(child.ref);
    const provider = new FakeProvider([parent, child]);
    const result = await deleteIssue({
      layout: layout(root),
      machine,
      provider,
      issue: parent,
      cascade: true,
    });
    assert.deepEqual(result.deleted, [31, 20]);
    assert.deepEqual(provider.deleted, [31, 20]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a parent with children needs an explicit cascade", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-gate-"));
  try {
    const parent = issue(20, "feature");
    const child = issue(31, "feature", { parent: parent.ref });
    parent.children.push(child.ref);
    const provider = new FakeProvider([parent, child]);
    await assert.rejects(
      deleteIssue({ layout: layout(root), machine, provider, issue: parent }),
      /pass --cascade/,
    );
    assert.deepEqual(provider.deleted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue deletion removes terminal run records unless keepRuns is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-runs-"));
  try {
    const l = layout(root);
    const target = issue(31, "feature");
    const provider = new FakeProvider([target]);
    const recorder = new RunRecorder(l, { agent: "build", mode: "", request: "run", repoRoot: root, issue: target.ref });
    recorder.finalize("completed");
    const runId = recorder.current.id;
    const result = await deleteIssue({ layout: l, machine, provider, issue: target, keepRuns: false });
    assert.deepEqual(result.deletedRuns, [runId]);
    assert.equal(existsSync(join(l.runsDir, runId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tombstones hide a deleted issue even when a stale cache writes it back", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-cache-"));
  try {
    const l = layout(root);
    const target = issue(31, "feature");
    writeIssueCache(l, "o/r", [target]);
    addTombstones(l, [target.ref]);
    assert.deepEqual(readIssueCache(l).issues, []);
    removeTombstones(l, [target.ref]);
    assert.equal(readIssueCache(l).issues.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy reserved anchors are gone: reserved-shaped issues delete normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-reserved-"));
  try {
    const legacy = issue(21, "feature", {
      reserved: { for: issue(20, "epic").ref, kind: "feature-pr" },
    });
    const provider = new FakeProvider([legacy]);
    const result = await deleteIssue({ layout: layout(root), machine, provider, issue: legacy, cascade: true });
    assert.deepEqual(result.deleted, [21]);
    assert.deepEqual(provider.deleted, [21]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature deletion cleans the feature branch and legacy task branches", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-branch-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "t@t.local"]);
    git(root, ["config", "user.name", "T"]);
    writeFileSync(join(root, "README.md"), "# t\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);
    git(root, ["branch", "mc/feature/31"]);
    git(root, ["branch", "mc/task/31"]);
    const l = layout(root);
    const target = issue(31, "feature");
    const provider = new FakeProvider([target]);
    const recorder = new RunRecorder(l, { agent: "build", mode: "", request: "run", repoRoot: root, issue: target.ref });
    recorder.patchSummary({ branch: "mc/task/31" });
    recorder.finalize("completed");
    const result = await deleteIssue({ layout: l, machine, provider, issue: target });
    assert.deepEqual(provider.deleted, [31]);
    assert.ok(result.deletedBranches.includes("mc/feature/31"));
    assert.ok(result.deletedBranches.includes("mc/task/31"));
    assert.equal(git(root, ["branch", "--list", "mc/feature/31"]).trim(), "");
    assert.equal(git(root, ["branch", "--list", "mc/task/31"]).trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
