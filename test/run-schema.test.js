/**
 * Phase 0 tests: run record schema, v1→v2 migration, atomic writes, and the
 * RunRecorder lifecycle (setStatus / finalize / lastActivityAt).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateRunSummary, normalizeStatus, writeJsonAtomic, SCHEMA_VERSION } from "../dist/state/run-schema.js";
import { RunRecorder, readRun, listRuns, reconcileRun, listAllRuns, registerProject } from "../dist/state/runs.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `mc-${prefix}-`));
}

test("normalizeStatus maps legacy done and rejects unknown values", () => {
  assert.equal(normalizeStatus("done"), "completed");
  assert.equal(normalizeStatus("running"), "running");
  assert.equal(normalizeStatus("awaiting_input"), "awaiting_input");
  assert.equal(normalizeStatus("paused"), "paused");
  assert.equal(normalizeStatus("cancelled"), "cancelled");
  assert.equal(normalizeStatus("garbage"), "failed");
  assert.equal(normalizeStatus(undefined), "failed");
});

test("migrateRunSummary upgrades a v1 record in memory without touching disk", () => {
  const v1 = {
    id: "20261031-045443-jcvl",
    repoRoot: "/repo",
    agent: "sudo",
    mode: "",
    request: "What is 2+2?",
    status: "done",
    pid: 123,
    startedAt: "2026-10-31T04:54:43.117Z",
    endedAt: "2026-10-31T04:54:43.692Z",
    turns: 1,
    usage: { input: 799, output: 44, cacheRead: 0, cacheWrite: 0, totalTokens: 843 },
    cost: { actual: 0.0000183, estimated: 0 },
    modelCalls: 1,
    finalText: "4",
  };
  const migrated = migrateRunSummary(v1);
  assert.ok(migrated);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.status, "completed");
  assert.equal(migrated.lastActivityAt, v1.endedAt);
  assert.equal(migrated.finalText, "4");
  assert.equal(migrated.usage.totalTokens, 843);
});

test("migrateRunSummary fills missing lastActivityAt and rejects unusable records", () => {
  const minimal = migrateRunSummary({ id: "x", status: "running", startedAt: "2026-10-31T00:00:00.000Z" });
  assert.ok(minimal);
  assert.equal(minimal.lastActivityAt, "2026-10-31T00:00:00.000Z");
  assert.equal(minimal.status, "running");
  assert.equal(migrateRunSummary({ status: "running" }), null);
  assert.equal(migrateRunSummary(null), null);
  assert.equal(migrateRunSummary("nope"), null);
});

test("writeJsonAtomic round-trips and leaves no temp files behind", () => {
  const dir = tempDir("atomic");
  const file = join(dir, "nested", "run.json");
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2, b: "x" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2, b: "x" });
  const leftovers = readdirSync(join(dir, "nested")).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  rmSync(dir, { recursive: true, force: true });
});

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

test("RunRecorder writes v2 summary atomically and tracks lifecycle state", () => {
  const root = tempDir("recorder");
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, {
    agent: "general",
    mode: "",
    request: "test request",
    repoRoot: root,
  });
  try {
    const raw = JSON.parse(readFileSync(join(recorder.dir, "run.json"), "utf8"));
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
    assert.equal(raw.status, "running");
    assert.ok(raw.lastActivityAt);
    const events = readFileSync(join(recorder.dir, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0]).type, "run_start");

    recorder.setStatus("awaiting_input", "question");
    const awaiting = JSON.parse(readFileSync(join(recorder.dir, "run.json"), "utf8"));
    assert.equal(awaiting.status, "awaiting_input");
    const events2 = readFileSync(join(recorder.dir, "events.jsonl"), "utf8").trim().split("\n");
    const stateEvent = JSON.parse(events2[events2.length - 1]);
    assert.equal(stateEvent.type, "run_state");
    assert.equal(stateEvent.from, "running");
    assert.equal(stateEvent.to, "awaiting_input");
    assert.equal(stateEvent.reason, "question");

    // Same-state setStatus is a no-op (no duplicate event).
    recorder.setStatus("awaiting_input");
    assert.equal(readFileSync(join(recorder.dir, "events.jsonl"), "utf8").trim().split("\n").length, events2.length);

    recorder.recordCall(
      { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      0.001,
      0.002,
    );
    const afterCall = JSON.parse(readFileSync(join(recorder.dir, "run.json"), "utf8"));
    assert.equal(afterCall.modelCalls, 1);
    assert.equal(afterCall.turns, 1);
    assert.equal(afterCall.usage.totalTokens, 15);

    recorder.finalize("completed", undefined, "all done");
    const done = JSON.parse(readFileSync(join(recorder.dir, "run.json"), "utf8"));
    assert.equal(done.status, "completed");
    assert.ok(done.endedAt);
    assert.equal(done.finalText, "all done");
    // finalize is idempotent
    recorder.finalize("failed", "late error");
    const stillDone = JSON.parse(readFileSync(join(recorder.dir, "run.json"), "utf8"));
    assert.equal(stillDone.status, "completed");
    assert.equal(stillDone.error, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalize refuses non-terminal statuses and defers to setStatus", () => {
  const root = tempDir("finalize");
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, {
    agent: "general",
    mode: "",
    request: "r",
    repoRoot: root,
  });
  try {
    recorder.finalize("paused");
    assert.equal(recorder.current.status, "paused");
    assert.equal(recorder.current.endedAt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readRun/listRuns migrate legacy v1 run.json files on read", () => {
  const root = tempDir("legacy");
  const layout = fakeLayout(root);
  const runDir = join(layout.runsDir, "20261030-120000-aaaa");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      id: "20261030-120000-aaaa",
      repoRoot: root,
      agent: "general",
      mode: "",
      request: "old run",
      status: "done",
      pid: 999999,
      startedAt: "2026-10-30T12:00:00.000Z",
      endedAt: "2026-10-30T12:01:00.000Z",
      turns: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      cost: { actual: 0, estimated: 0 },
      modelCalls: 1,
    }) + "\n",
    "utf8",
  );
  writeFileSync(join(runDir, "events.jsonl"), "", "utf8");
  try {
    const run = readRun(layout, "20261030-120000-aaaa");
    assert.ok(run);
    assert.equal(run.summary.status, "completed");
    assert.equal(run.summary.lastActivityAt, "2026-10-30T12:01:00.000Z");
    const listed = listRuns(layout);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileRun marks dead-owner running/created runs interrupted, keeps paused", () => {
  const base = {
    id: "r1",
    repoRoot: "/repo",
    agent: "general",
    mode: "",
    request: "r",
    pid: 999999999, // not alive
    startedAt: new Date().toISOString(),
    turns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { actual: 0, estimated: 0 },
    modelCalls: 0,
  };
  const running = reconcileRun(migrateRunSummary({ ...base, status: "running" }));
  assert.equal(running.status, "interrupted");
  const created = reconcileRun(migrateRunSummary({ ...base, status: "created" }));
  assert.equal(created.status, "interrupted");
  const paused = reconcileRun(migrateRunSummary({ ...base, status: "paused" }));
  assert.equal(paused.status, "paused");
});

test("prune skips active runs and removes old terminal ones", async () => {
  const { pruneRuns } = await import("../dist/state/runs.js");
  const root = tempDir("prune");
  const layout = fakeLayout(root);
  registerProject(layout.home, root);
  const active = new RunRecorder(layout, {
    agent: "general",
    mode: "",
    request: "keep me",
    repoRoot: root,
  });
  const old = new RunRecorder(layout, {
    agent: "general",
    mode: "",
    request: "remove me",
    repoRoot: root,
  });
  try {
    old.finalize("completed");
    // Backdate the old run past any cutoff.
    const oldSummary = JSON.parse(readFileSync(join(old.dir, "run.json"), "utf8"));
    oldSummary.startedAt = "2020-01-01T00:00:00.000Z";
    oldSummary.lastActivityAt = oldSummary.startedAt;
    writeFileSync(join(old.dir, "run.json"), JSON.stringify(oldSummary, null, 2) + "\n", "utf8");

    // days=0 skips the still-running run but removes the old terminal one.
    const first = pruneRuns(layout.home, 0);
    assert.equal(first.skipped, 1);
    assert.equal(first.removed, 1);
    assert.ok(existsSync(active.dir));
    assert.ok(!existsSync(old.dir));

    // Now finalize the active run and prune everything.
    active.finalize("completed");
    const second = pruneRuns(layout.home, 0);
    assert.equal(second.removed, 1);
    assert.ok(!existsSync(active.dir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listAllRuns discovers runs registered under a fake machine home", () => {
  const root = tempDir("home");
  const layout = fakeLayout(root);
  registerProject(layout.home, root);
  const recorder = new RunRecorder(layout, {
    agent: "build",
    mode: "verified",
    request: "discover me",
    repoRoot: root,
  });
  try {
    recorder.finalize("completed");
    const runs = listAllRuns(layout.home);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].request, "discover me");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].schemaVersion, SCHEMA_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RunRecorder tracks current and peak context", () => {
  const root = tempDir("context");
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, {
    agent: "general",
    mode: "",
    request: "context test",
    repoRoot: root,
  });
  try {
    recorder.recordContext(4_000, 1_000);
    recorder.recordContext(8_000, 2_000);
    recorder.recordContext(6_000, 1_500);
    const raw = JSON.parse(readFileSync(join(recorder.dir, "run.json"), "utf8"));
    assert.equal(raw.usage.contextChars, 6_000);
    assert.equal(raw.usage.contextTokens, 1_500);
    assert.equal(raw.usage.peakContextChars, 8_000);
    assert.equal(raw.usage.peakContextTokens, 2_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateRunSummary fills context usage fields for old runs", () => {
  const migrated = migrateRunSummary({
    id: "old",
    status: "completed",
    startedAt: "2026-10-31T00:00:00.000Z",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  });
  assert.ok(migrated);
  assert.equal(migrated.usage.contextChars, 0);
  assert.equal(migrated.usage.contextTokens, 0);
  assert.equal(migrated.usage.peakContextChars, 0);
  assert.equal(migrated.usage.peakContextTokens, 0);
});
