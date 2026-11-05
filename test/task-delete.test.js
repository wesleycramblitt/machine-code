/**
 * Destructive issue cleanup: reserved protection, subtree gating, and cascade
 * deletion order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("cascade deletes children before the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-"));
  try {
    const parent = issue(20, "feature");
    const child = issue(31, "task", { parent: parent.ref });
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
    const child = issue(31, "task", { parent: parent.ref });
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
    const target = issue(31, "task");
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
    const target = issue(31, "task");
    writeIssueCache(l, "o/r", [target]);
    addTombstones(l, [target.ref]);
    assert.deepEqual(readIssueCache(l).issues, []);
    removeTombstones(l, [target.ref]);
    assert.equal(readIssueCache(l).issues.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserved issues cannot be deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-del-reserved-"));
  try {
    const reserved = issue(21, "task", {
      reserved: { for: issue(20, "feature").ref, kind: "feature-pr" },
    });
    const provider = new FakeProvider([reserved]);
    await assert.rejects(
      deleteIssue({ layout: layout(root), machine, provider, issue: reserved, cascade: true }),
      /reserved issue/,
    );
    assert.deepEqual(provider.deleted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
