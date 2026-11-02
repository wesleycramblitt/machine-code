/**
 * Orphan reconciliation marks dead running processes exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendProcessRecord, readProcessRecords } from "../dist/processes/registry.js";
import { reconcileProcessRecords } from "../dist/processes/reconcile.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "mc-reconcile-"));
}

function record(overrides = {}) {
  return {
    id: "p-0001",
    runId: "run-1",
    origin: "command",
    name: "test",
    argv: ["test"],
    status: "running",
    startedAt: new Date().toISOString(),
    stdoutLog: "/tmp/out",
    stderrLog: "/tmp/err",
    ...overrides,
  };
}

test("dead processes are marked failed and stay failed", () => {
  const dir = tempDir();
  try {
    appendProcessRecord(dir, record({ pid: 999_999, pgid: 999_999 }));
    const first = reconcileProcessRecords(dir);
    assert.equal(first[0].status, "failed");
    assert.match(first[0].error, /without an exit record/);
    const count = readProcessRecords(dir).length;
    const second = reconcileProcessRecords(dir);
    assert.equal(second[0].status, "failed");
    assert.equal(readProcessRecords(dir).length, count, "no duplicate update");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running processes with no pid wait for the grace period", () => {
  const dir = tempDir();
  try {
    appendProcessRecord(dir, record({ startedAt: new Date().toISOString() }));
    assert.equal(reconcileProcessRecords(dir)[0].status, "running");
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    appendProcessRecord(dir, record({ startedAt: old }));
    assert.equal(reconcileProcessRecords(dir)[0].status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
