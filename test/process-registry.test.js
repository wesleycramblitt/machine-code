/**
 * Per-run process registry: append-only records, bounded read behavior, and
 * stable ids. Spawn wiring is tested in the supervisor phase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendProcessRecord,
  liveProcessRecords,
  nextProcessId,
  processLogPaths,
  readProcessRecords,
} from "../dist/processes/registry.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "mc-process-"));
}

function record(id, status = "running") {
  return {
    id,
    runId: "run-1",
    origin: "command",
    name: "typescript:test",
    argv: ["npm", "test"],
    status,
    startedAt: "2026-11-02T00:00:00.000Z",
    stdoutLog: `/tmp/${id}.stdout.log`,
    stderrLog: `/tmp/${id}.stderr.log`,
  };
}

test("process ids increment and stay stable", () => {
  assert.equal(nextProcessId([]), "p-0001");
  assert.equal(nextProcessId([record("p-0001"), record("p-0007"), record("p-0003")]), "p-0008");
  assert.equal(nextProcessId([record("other")]), "p-0001");
});

test("records append and read back, ignoring a torn final line", () => {
  const dir = tempDir();
  try {
    appendProcessRecord(dir, record("p-0001"));
    appendProcessRecord(dir, record("p-0002", "exited"));
    appendFileSync(join(dir, "processes.jsonl"), '{"id":"torn"', "utf8");
    const records = readProcessRecords(dir);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((entry) => entry.id), ["p-0001", "p-0002"]);
    assert.deepEqual(liveProcessRecords(records).map((entry) => entry.id), ["p-0001"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log paths live under the run process directory", () => {
  const paths = processLogPaths("/runs/run-1", "p-0003");
  assert.equal(paths.stdout, "/runs/run-1/processes/p-0003.stdout.log");
  assert.equal(paths.stderr, "/runs/run-1/processes/p-0003.stderr.log");
});

test("readProcessRecords returns empty for an unknown run", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readProcessRecords(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
