import { test } from "node:test";
import assert from "node:assert/strict";

import { hasPlanDecision, needsBuildPlan, readBucket } from "../dist/loop.js";

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

test("the read-repeat bucket ignores limit changes at the same start line", () => {
  assert.equal(readBucket({ path: "src/tui.ts", offset: 3500 }), "src/tui.ts@35");
  assert.equal(readBucket({ path: "src/tui.ts", offset: 3500, limit: 200 }), "src/tui.ts@35");
  assert.notEqual(readBucket({ path: "src/tui.ts", offset: 3500 }), readBucket({ path: "src/tui.ts", offset: 3600 }));
});
