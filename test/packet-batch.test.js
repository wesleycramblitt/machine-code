/**
 * Packet batch scheduler: dependency-aware, max-parallel wave planning.
 * Pure — no model, no network; only packet files on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { planBatchWaves } from "../dist/tasks/packet.js";
import { writePacketFile } from "../dist/plan/packets.js";

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

function temp() {
  const root = mkdtempSync(join(tmpdir(), "mc-batch-"));
  mkdirSync(join(root, "plans"), { recursive: true });
  return { root, l: layout(root) };
}

function add(l, slug, opts = {}) {
  const { deps = [], verify = ["typescript:test"], status = "todo", deliverable = `Do ${slug}` } = opts;
  writePacketFile(l, { slug, status, deps, blocked: "", deliverable, files: [], acceptance: [], verify });
}

test("empty plan yields no waves", () => {
  const { root, l } = temp();
  try {
    assert.deepEqual(planBatchWaves(l, 2), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent packets fan out up to max-parallel", () => {
  const { root, l } = temp();
  try {
    add(l, "a");
    add(l, "b");
    add(l, "c");
    assert.deepEqual(planBatchWaves(l, 2), [["a", "b"], ["c"]]);
    assert.deepEqual(planBatchWaves(l, 1), [["a"], ["b"], ["c"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependent packets wait for their parents", () => {
  const { root, l } = temp();
  try {
    add(l, "b"); // parent
    add(l, "a", { deps: ["b"] }); // child
    assert.deepEqual(planBatchWaves(l, 2), [["b"], ["a"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocked packets are not dispatched, and block their dependents", () => {
  const { root, l } = temp();
  try {
    add(l, "b", { status: "blocked", blocked: "waiting" });
    add(l, "a", { deps: ["b"] });
    assert.deepEqual(planBatchWaves(l, 2), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-buildable packets (no verify) are skipped", () => {
  const { root, l } = temp();
  try {
    add(l, "a", { verify: [] });
    add(l, "b"); // buildable
    assert.deepEqual(planBatchWaves(l, 2), [["b"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing dependency does not block (already gone = resolved)", () => {
  const { root, l } = temp();
  try {
    add(l, "a", { deps: ["ghost"] });
    assert.deepEqual(planBatchWaves(l, 2), [["a"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
