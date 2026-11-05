/**
 * Run deletion: active runs are protected; terminal run records are removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deleteRun } from "../dist/state/run-delete.js";
import { RunRecorder, readRun } from "../dist/state/runs.js";

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

test("a terminal run is removed from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-run-del-"));
  try {
    const l = layout(root);
    const recorder = new RunRecorder(l, { agent: "general", mode: "", request: "test", repoRoot: root });
    recorder.finalize("completed", undefined, "done");
    const run = recorder.current;
    assert.ok(readRun(l, run.id));
    const result = await deleteRun({ layout: l, run });
    assert.equal(result.runId, run.id);
    assert.equal(existsSync(join(l.runsDir, run.id)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active run cannot be deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-run-del-active-"));
  try {
    const l = layout(root);
    const recorder = new RunRecorder(l, { agent: "general", mode: "", request: "test", repoRoot: root });
    await assert.rejects(deleteRun({ layout: l, run: recorder.current }), /cancel or finish/);
    assert.ok(readRun(l, recorder.current.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
