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
