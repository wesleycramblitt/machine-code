/**
 * Run deletion: active runs are protected; terminal run records are removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deleteRun } from "../dist/state/run-delete.js";
import { RunRecorder, isPidAlive, readRun } from "../dist/state/runs.js";

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
    const recorder = new RunRecorder(l, { agent: "research", mode: "", request: "test", repoRoot: root });
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

test("active deletion can be refused explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-run-del-active-"));
  try {
    const l = layout(root);
    const recorder = new RunRecorder(l, { agent: "research", mode: "", request: "test", repoRoot: root });
    await assert.rejects(
      deleteRun({ layout: l, run: recorder.current, terminate: false }),
      /cancel or finish/,
    );
    assert.ok(readRun(l, recorder.current.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active run with no live owner is deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-run-del-dead-owner-"));
  try {
    const l = layout(root);
    const recorder = new RunRecorder(l, { agent: "research", mode: "", request: "test", repoRoot: root });
    recorder.setStatus("awaiting_input", "ask");
    const run = { ...recorder.current, pid: 999_999 };
    const result = await deleteRun({ layout: l, run });
    assert.equal(result.cancelled, false);
    assert.equal(existsSync(join(l.runsDir, run.id)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a live awaiting run cancels the owner and waits for exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-run-del-live-owner-"));
  let child;
  try {
    const l = layout(root);
    const recorder = new RunRecorder(l, { agent: "research", mode: "", request: "test", repoRoot: root });
    recorder.setStatus("awaiting_input", "ask");
    const runDir = join(l.runsDir, recorder.current.id);
    const script = `
      const fs = require("node:fs");
      const dir = process.argv[1];
      const timer = setInterval(() => {
        try {
          const req = JSON.parse(fs.readFileSync(dir + "/control", "utf8"));
          fs.writeFileSync(dir + "/control.ack", JSON.stringify({ seq: req.seq, acked: true }));
          clearInterval(timer);
          process.exit(0);
        } catch {}
      }, 50);
    `;
    child = spawn(process.execPath, ["-e", script, runDir], { stdio: "ignore" });
    const pid = child.pid;
    assert.ok(pid);
    const run = { ...recorder.current, pid };
    const result = await deleteRun({ layout: l, run });
    assert.equal(result.cancelled, true);
    assert.equal(isPidAlive(pid), false);
    assert.equal(existsSync(runDir), false);
  } finally {
    child?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
