import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeCompletedFeature } from "../dist/orchestrator/closure.js";
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

function feature(number = 31, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number },
    kind: "feature",
    state: "open",
    title: `Feature ${number}`,
    body: "",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["typescript:test"],
    approval: "agent",
    ...extra,
  };
}

class FakeProvider {
  constructor(issues) {
    this.kind = "github";
    this.map = new Map(issues.map((i) => [i.ref.number, i]));
    this.closed = [];
  }
  async get(ref) {
    return this.map.get(ref.number) ?? null;
  }
  async children(ref) {
    return [...this.map.values()].filter((candidate) => candidate.parent?.number === ref.number);
  }
  async close(ref) {
    const issue = this.map.get(ref.number);
    if (issue) this.map.set(ref.number, { ...issue, state: "closed" });
    this.closed.push(ref.number);
  }
}

function buildRun(l, issue) {
  const recorder = new RunRecorder(l, {
    agent: "build",
    mode: "verified",
    request: "finish feature",
    repoRoot: l.repoRoot,
    issue: issue.ref,
  });
  return recorder;
}

test("agent result approval records evidence and closes the feature", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-closure-"));
  try {
    const l = layout(root);
    const target = feature();
    const recorder = buildRun(l, target);
    const provider = new FakeProvider([target]);
    const result = await closeCompletedFeature({
      provider,
      layout: l,
      issue: target,
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

test("closure walks feature -> epic one level and stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-closure-epic-"));
  try {
    const l = layout(root);
    const grandparent = { ...feature(5, { kind: "epic", approval: "agent", acceptance: [] }), parent: undefined };
    const epic = { ...feature(10, { kind: "epic", approval: "agent" }), parent: grandparent.ref };
    const target = { ...feature(31), parent: epic.ref };
    const sibling = { ...feature(32, { state: "closed" }), parent: epic.ref };
    const provider = new FakeProvider([grandparent, epic, target, sibling]);
    const recorder = buildRun(l, target);
    // The epic's own completion gate needs acceptance evidence for the epic.
    RunRecorder.reopen(l, recorder.current).event("acceptance_verified", {
      issue: epic.ref.number,
      by: "agent",
      criteria: epic.acceptance,
      evidence: "agent result approval",
    });
    const result = await closeCompletedFeature({
      provider,
      layout: l,
      issue: target,
      runId: recorder.id,
      by: "agent",
    });
    assert.equal(result.status, "closed");
    assert.deepEqual(provider.closed, [31, 10]);
    assert.deepEqual(result.closedParents, [10]);
    assert.equal(provider.map.get(5).state, "open", "walk stops at the epic; grandparent stays open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

