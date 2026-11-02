/**
 * Typed Build outcomes and Review verdicts with conservative fallbacks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { inferReviewVerdict, isRetryableFailure, parseBuildOutcome, parseReviewVerdict } from "../dist/orchestrator/outcome.js";

test("Build outcomes require a labelled line", () => {
  assert.equal(parseBuildOutcome("done\nOutcome: completed"), "completed");
  assert.equal(parseBuildOutcome("Outcome: needs planning"), "needs_planning");
  assert.equal(parseBuildOutcome("Outcome: blocked"), "blocked");
  assert.equal(parseBuildOutcome("Outcome: failed"), "failed");
  assert.equal(parseBuildOutcome("Outcome: maybe"), undefined);
  assert.equal(parseBuildOutcome("completed"), undefined);
});

test("Review verdicts accept labels and safe fallbacks", () => {
  assert.equal(parseReviewVerdict("Verdict: approved"), "approved");
  assert.equal(parseReviewVerdict("Verdict: changes requested"), "changes_requested");
  assert.equal(parseReviewVerdict("Verdict: needs_planning"), "needs_planning");
  assert.equal(parseReviewVerdict("Verdict: blocked"), "blocked");
  assert.equal(parseReviewVerdict("Verdict: failed"), "failed");
  assert.equal(parseReviewVerdict("looks fine"), undefined);
  assert.equal(inferReviewVerdict("reject: missing test"), "changes_requested");
  assert.equal(inferReviewVerdict("blocked on missing context"), "blocked");
  assert.equal(inferReviewVerdict("approved with notes"), "approved");
  assert.equal(inferReviewVerdict("the gate failed"), "failed");
});

test("only completion failures are retryable", () => {
  assert.equal(isRetryableFailure("acceptance gates failed: typescript:test"), true);
  assert.equal(isRetryableFailure("Review verdict: changes_requested"), true);
  assert.equal(isRetryableFailure("build outcome: blocked"), true);
  assert.equal(isRetryableFailure("build outcome: needs_planning"), false);
  assert.equal(isRetryableFailure("task crashed: ENOSPC"), false);
  assert.equal(isRetryableFailure(undefined), false);
});
