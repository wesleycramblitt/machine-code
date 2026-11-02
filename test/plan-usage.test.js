/**
 * Artifact usage records feed deterministic promotion hints, not guesses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPromotionCandidate,
  parseArtifactUsage,
  successfulTaskUsers,
} from "../dist/plan/usage.js";

function usage(overrides = {}) {
  return {
    artifact: "bench",
    kind: "script",
    scope: "task",
    issue: { provider: "github", repo: "o/r", number: 11 },
    runId: "run-1",
    role: "build",
    at: "2026-11-02T00:00:00.000Z",
    success: true,
    action: "run",
    ...overrides,
  };
}

test("artifact usage validates required fields", () => {
  const parsed = parseArtifactUsage(usage());
  assert.ok(parsed);
  assert.equal(parsed.artifact, "bench");
  assert.equal(parsed.kind, "script");
  assert.deepEqual(parsed.issue, { provider: "github", repo: "o/r", number: 11 });

  assert.equal(parseArtifactUsage({ ...usage(), artifact: "" }), null);
  assert.equal(parseArtifactUsage({ ...usage(), kind: "binary" }), null);
  assert.equal(parseArtifactUsage({ ...usage(), action: "delete" }), null);
  assert.equal(parseArtifactUsage({ ...usage(), success: "yes" }), null);
});

test("two distinct successful Task users justify promotion", () => {
  const one = [usage({ issue: { provider: "github", repo: "o/r", number: 11 } })];
  const two = [
    ...one,
    usage({ issue: { provider: "github", repo: "o/r", number: 12 } }),
    usage({ issue: { provider: "github", repo: "o/r", number: 12 } }),
  ];
  assert.equal(isPromotionCandidate(one, "bench"), false);
  assert.deepEqual(successfulTaskUsers(two, "bench"), [11, 12]);
  assert.equal(isPromotionCandidate(two, "bench"), true);
  assert.equal(isPromotionCandidate([usage({ success: false }), usage({ issue: { provider: "github", repo: "o/r", number: 12 } })], "bench"), false);
});
