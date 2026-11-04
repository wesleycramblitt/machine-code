/**
 * Manual Task lifecycle: status, review checks, approval, closure, and the
 * terminal-run summary guard used by approval events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { approveTask, runTaskChecks, taskStatus } from "../dist/tasks/lifecycle.js";
import { RunRecorder, readRun } from "../dist/state/runs.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mc-task-life-"));
  const layout = {
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
  mkdirSync(layout.runsDir, { recursive: true });
  return { root, layout };
}

function issue(number = 31, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number },
    title: "Implement thermal model",
    body: [
      "## Context",
      "",
      "Thermal work.",
      "",
      "## Deliverable",
      "",
      "Implement the model.",
      "",
      "## Acceptance criteria",
      "",
      "- The model returns temperatures.",
      "",
      "## Verification",
      "",
      "```",
      "npm test",
      "```",
      "",
      '<!-- mc:plan {"v":1,"status":"ready","role":"build","verification":"verified","worktree":"required","retries_before_replan":2,"plan_review":"agent","result_review":"human"} -->',
      "",
    ].join("\n"),
    state: "open",
    kind: "task",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["The model returns temperatures."],
    approval: "human",
    ...extra,
  };
}

function fakeProvider(target) {
  return {
    kind: "github",
    async available() { return true; },
    async get(ref) { return ref.number === target.ref.number ? target : null; },
    async list() { return [target]; },
    async children() { return []; },
    async hierarchy() { return []; },
    async blockers() { return []; },
    async create() { throw new Error("not used"); },
    async update() { throw new Error("not used"); },
    async close(ref) { if (ref.number === target.ref.number) target.state = "closed"; },
    async reopen() {},
    async linkParent() {},
  };
}

function createRun(layout, target, extra = {}) {
  const { worktree, branch, baseBranch, ...init } = extra;
  const recorder = new RunRecorder(layout, {
    agent: "build",
    mode: "verified",
    request: "Implement thermal model",
    repoRoot: layout.repoRoot,
    issue: target.ref,
    taskIssue: target.ref,
    attempt: 1,
    phase: "build",
    resultReview: "human",
    ...init,
  });
  if (worktree) {
    recorder.patchSummary({
      worktree,
      ...(branch ? { branch } : {}),
      ...(baseBranch ? { baseBranch } : {}),
    });
  }
  recorder.finalize("completed", undefined, "Implemented.");
  return recorder.current;
}

test("task status points at the next lifecycle action", async () => {
  const { root, layout } = setup();
  try {
    const target = issue();
    const status = await taskStatus(layout, target);
    assert.equal(status.stage, "ready");
    assert.equal(status.worktreeExists, false);
    assert.match(status.next.join("\n"), /task start 31/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review checks run in the worktree and are recorded on the run", async () => {
  const { root, layout } = setup();
  try {
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    const target = issue();
    const run = createRun(layout, target, { worktree, branch: "mc/task/31", baseBranch: "mc/feature/30" });
    const results = await runTaskChecks(layout, target, ["node -e \"process.exit(0)\"", "false"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].passed, true);
    assert.equal(results[1].passed, false);
    const detail = readRun(layout, run.id);
    const events = readFileSync(join(layout.runsDir, run.id, "events.jsonl"), "utf8");
    assert.match(events, /task_review_check/);
    assert.equal(detail.summary.summary, run.summary, "terminal summary survives approval-style reopen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task approve records acceptance, closes the issue, and keeps the terminal summary", async () => {
  const { root, layout } = setup();
  try {
    const target = issue();
    const provider = fakeProvider(target);
    const run = createRun(layout, target);
    const approved = await approveTask({
      layout,
      machine: {},
      provider,
      issue: target,
      runId: run.id,
      commit: false,
      merge: false,
      clean: false,
    });
    assert.equal(target.state, "closed");
    assert.equal(approved.worktreeRemoved, false);
    const detail = readRun(layout, run.id);
    assert.equal(detail.summary.summary, run.summary);
    const events = readFileSync(join(layout.runsDir, run.id, "events.jsonl"), "utf8");
    assert.match(events, /acceptance_verified/);
    assert.match(events, /issue_closed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
