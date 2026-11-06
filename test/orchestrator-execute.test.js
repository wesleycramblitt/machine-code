/**
 * Packet synthesis for orchestrated tasks. Execution itself is covered by the
 * run/orchestrator suites; this fixture pins the issue-to-packet contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { packetForTask } from "../dist/orchestrator/execute.js";

const plan = {
  v: 1,
  status: "ready",
  role: "build",
  verification: "verified",
  worktree: "required",
  retriesBeforeReplan: 2,
  planReview: "agent",
  resultReview: "agent",
};

test("task packets carry goal, context, and typed acceptance", () => {
  const packet = packetForTask(
    {
      ref: { provider: "github", repo: "o/r", number: 31 },
      title: "Implement thermal model",
      body: '<!-- mc:context {"files":["src/thermal.ts","src/parser.ts"]} -->\n\n## Acceptance criteria\n- typescript:test\n- typescript:typecheck {"strict":true}\n- core:status mode=short',
      state: "open",
      kind: "task",
      labels: [],
      children: [],
      blockedBy: [],
      blocking: [],
      acceptance: ["typescript:test", 'typescript:typecheck {"strict":true}', "core:status mode=short"],
    },
    plan,
    3,
  );
  assert.equal(packet.id, "issue-31-3");
  assert.equal(packet.mode, "verified");
  assert.equal(packet.goal, "Implement thermal model");
  assert.deepEqual(packet.context, ["src/thermal.ts", "src/parser.ts"]);
  assert.deepEqual(packet.acceptance, [
    { command: "typescript:test" },
    { command: "typescript:typecheck", args: { strict: true } },
    { command: "core:status", args: { mode: "short" } },
  ]);
});

test("prose acceptance criteria use the Verification section as gates", () => {
  const packet = packetForTask(
    {
      ref: { provider: "github", repo: "o/r", number: 31 },
      title: "Implement thermal model",
      body: [
        "## Acceptance criteria",
        "- The model returns temperatures.",
        "",
        "## Verification",
        "```",
        "npm run typecheck",
        "npm test",
        "```",
      ].join("\n"),
      state: "open",
      kind: "task",
      labels: [],
      children: [],
      blockedBy: [],
      blocking: [],
      acceptance: ["The model returns temperatures."],
    },
    plan,
    1,
  );
  assert.deepEqual(packet.acceptance, [{ command: "typescript:typecheck" }, { command: "typescript:test" }]);
});

test("findRetryWorktree reuses the newest existing task worktree", async () => {
  const { findRetryWorktree } = await import("../dist/orchestrator/execute.js");
  const taskRef = { provider: "github", repo: "o/r", number: 31 };
  const summaries = {
    old: {
      id: "old", status: "failed", taskIssue: taskRef, startedAt: "2026-01-01T00:00:00.000Z",
      worktree: "/wt/old", branch: "mc/task/31",
    },
    fresh: {
      id: "fresh", status: "failed", taskIssue: taskRef, startedAt: "2026-01-02T00:00:00.000Z",
      worktree: "/wt/fresh", branch: "mc/task/31", baseBranch: "mc/feature/3", baseRef: "abc",
    },
    other: {
      id: "other", status: "failed", taskIssue: { provider: "github", repo: "o/r", number: 99 },
      startedAt: "2026-01-03T00:00:00.000Z", worktree: "/wt/other",
    },
  };
  const store = {
    readRun: (id) => (summaries[id] ? { summary: summaries[id] } : null),
    listRuns: () => Object.values(summaries),
    exists: (path) => path !== "/wt/old",
  };
  const found = findRetryWorktree({}, taskRef, Object.values(summaries), [], store);
  assert.deepEqual(found, {
    path: "/wt/fresh",
    ownerRunId: "fresh",
    branch: "mc/task/31",
    baseBranch: "mc/feature/3",
    baseRef: "abc",
  });
});

test("findRetryWorktree skips trees an active run is still using", async () => {
  const { findRetryWorktree } = await import("../dist/orchestrator/execute.js");
  const taskRef = { provider: "github", repo: "o/r", number: 31 };
  const summaries = {
    failed: {
      id: "failed", status: "failed", taskIssue: taskRef, startedAt: "2026-01-02T00:00:00.000Z",
      worktree: "/wt/shared",
    },
    live: { id: "live", status: "running", worktree: "/wt/shared" },
  };
  const store = {
    readRun: (id) => (summaries[id] ? { summary: summaries[id] } : null),
    listRuns: () => Object.values(summaries),
    exists: () => true,
  };
  assert.equal(findRetryWorktree({}, taskRef, Object.values(summaries), [], store), undefined);
});

test("findRetryWorktree returns undefined when no worktree survives", async () => {
  const { findRetryWorktree } = await import("../dist/orchestrator/execute.js");
  const taskRef = { provider: "github", repo: "o/r", number: 31 };
  const summaries = {
    gone: {
      id: "gone", status: "failed", taskIssue: taskRef, startedAt: "2026-01-01T00:00:00.000Z",
      worktree: "/wt/gone",
    },
    nontree: { id: "nontree", status: "failed", taskIssue: taskRef, startedAt: "2026-01-02T00:00:00.000Z" },
  };
  const store = {
    readRun: (id) => (summaries[id] ? { summary: summaries[id] } : null),
    listRuns: () => Object.values(summaries),
    exists: () => false,
  };
  assert.equal(findRetryWorktree({}, taskRef, Object.values(summaries), [], store), undefined);
  assert.equal(findRetryWorktree({}, taskRef, [], [], store), undefined);
});

test("selectRetrySeed uses the newest terminal error from a run that did work", async () => {
  const { selectRetrySeed } = await import("../dist/orchestrator/execute.js");
  const taskRef = { provider: "github", repo: "o/r", number: 31 };
  const runs = [
    {
      id: "old", status: "failed", taskIssue: taskRef, startedAt: "2026-01-01T00:00:00.000Z",
      modelCalls: 3, error: "old failure",
    },
    {
      id: "infra", status: "blocked", taskIssue: taskRef, startedAt: "2026-01-02T00:00:00.000Z",
      modelCalls: 0, error: "branch_checked_out: busy",
    },
    {
      id: "newest", status: "failed", taskIssue: taskRef, startedAt: "2026-01-03T00:00:00.000Z",
      modelCalls: 5, error: "newest failure",
    },
    {
      id: "other", status: "failed",
      taskIssue: { provider: "github", repo: "o/r", number: 99 },
      startedAt: "2026-01-04T00:00:00.000Z", modelCalls: 5, error: "other task",
    },
    {
      id: "active", status: "running", taskIssue: taskRef, startedAt: "2026-01-05T00:00:00.000Z",
      modelCalls: 2, error: "still going",
    },
  ];
  assert.equal(selectRetrySeed(runs, taskRef), "newest failure");
  assert.equal(selectRetrySeed([], taskRef), undefined);
  assert.equal(
    selectRetrySeed(
      [{ id: "x", status: "failed", taskIssue: taskRef, startedAt: "2026-01-01T00:00:00.000Z", modelCalls: 0 }],
      taskRef,
    ),
    undefined,
  );
});
