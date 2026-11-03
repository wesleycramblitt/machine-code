import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeCompletedTask } from "../dist/orchestrator/closure.js";
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

function task() {
  return {
    ref: { provider: "github", repo: "o/r", number: 31 },
    kind: "task",
    state: "open",
    title: "Task",
    body: "",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["typescript:test"],
    approval: "agent",
  };
}

class FakeProvider {
  constructor(issue) {
    this.kind = "github";
    this.issue = issue;
    this.closed = [];
  }
  async get(ref) {
    return ref.number === this.issue.ref.number ? this.issue : null;
  }
  async children() {
    return [];
  }
  async close(ref) {
    this.issue = { ...this.issue, state: "closed" };
    this.closed.push(ref.number);
  }
}

test("agent result approval records evidence and closes the task", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-closure-"));
  try {
    const l = layout(root);
    const recorder = new RunRecorder(l, {
      agent: "build",
      mode: "verified",
      request: "finish task",
      repoRoot: root,
      issue: task().ref,
    });
    const provider = new FakeProvider(task());
    const result = await closeCompletedTask({
      provider,
      layout: l,
      issue: task(),
      runId: recorder.id,
      by: "agent",
    });
    assert.equal(result.status, "closed");
    assert.deepEqual(provider.closed, [31]);
    assert.deepEqual(result.closedParents, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
