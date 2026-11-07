import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasPlanDecision,
  hasTerminalLine,
  needsBuildPlan,
  readBucket,
  shouldNudgeStall,
} from "../dist/loop.js";

const decision = (text) => [{ kind: "decision", status: "active", text }];

test("only Build has the mandatory change-plan gate", () => {
  assert.equal(needsBuildPlan("build"), true);
  assert.equal(needsBuildPlan("sudo"), false);
  assert.equal(needsBuildPlan("planner"), false);
  assert.equal(needsBuildPlan("general"), false);
});

test("a decision that merely mentions a plan is not a change plan", () => {
  assert.equal(
    hasPlanDecision(decision("Already have a plan: record next action only; do not create Epic.")),
    false,
  );
  assert.equal(hasPlanDecision(decision("The evidence is insufficient to determine the failure.")), false);
});

test("a decision naming files and change verbs is a change plan", () => {
  assert.equal(
    hasPlanDecision(
      decision(
        "Plan: 1) Read src/loop.ts and src/tui.ts. 2) Fix the checkpoint. 3) Add tests under test/.",
      ),
    ),
    true,
  );
});

test("a writable role that stops mid-investigation gets a continuation nudge", () => {
  const midThought = "I have the render path. Now I need to check the selected helper.";
  assert.equal(
    shouldNudgeStall({ wantsChange: true, hasToolCall: false, hasChange: false, text: midThought }),
    true,
  );
  // A tool call is progress.
  assert.equal(
    shouldNudgeStall({ wantsChange: true, hasToolCall: true, hasChange: false, text: midThought }),
    false,
  );
  // A change already exists.
  assert.equal(
    shouldNudgeStall({ wantsChange: true, hasToolCall: false, hasChange: true, text: midThought }),
    false,
  );
  // A read-only role or a pure question is not a stalled change.
  assert.equal(
    shouldNudgeStall({ wantsChange: false, hasToolCall: false, hasChange: false, text: midThought }),
    false,
  );
  // A clear terminal answer is a real finish, even without an edit.
  const answer = "Result: the bug is in the cache key.\nEvidence: src/cache.ts:41.";
  assert.equal(
    shouldNudgeStall({ wantsChange: true, hasToolCall: false, hasChange: false, text: answer }),
    false,
  );
});

test("terminal lines are recognized where the role contract puts them", () => {
  assert.equal(hasTerminalLine("Result: done"), true);
  assert.equal(hasTerminalLine("blah\nOutcome: blocked"), true);
  assert.equal(hasTerminalLine("Let me check one more thing."), false);
});

test("the read-repeat bucket ignores limit changes at the same start line", () => {
  assert.equal(readBucket({ path: "src/tui.ts", offset: 3500 }), "src/tui.ts@35");
  assert.equal(readBucket({ path: "src/tui.ts", offset: 3500, limit: 200 }), "src/tui.ts@35");
  assert.notEqual(readBucket({ path: "src/tui.ts", offset: 3500 }), readBucket({ path: "src/tui.ts", offset: 3600 }));
});
