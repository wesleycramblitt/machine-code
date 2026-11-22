/**
 * Closing-summary prompt contract tests.
 *
 * After gates pass, the harness asks the run's model for a decisions+work
 * summary grounded in run state. The prompt must demand all three sections
 * (Decisions, Work, Verification), forbid invention, cap length, forbid
 * tool calls, and carry the original request.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildClosingSummaryPrompt } from "../dist/loop.js";

describe("buildClosingSummaryPrompt", () => {
  it("requires decisions, work, and verification grounded in state", () => {
    const prompt = buildClosingSummaryPrompt("Trim the config", "STATE: edited a.ts");
    assert.match(prompt, /STATE: edited a\.ts/);
    assert.match(prompt, /## Decisions/);
    assert.match(prompt, /rejected/);
    assert.match(prompt, /## Work/);
    assert.match(prompt, /## Verification/);
    assert.match(prompt, /Do not invent/);
    assert.match(prompt, /under 30 lines/);
    assert.match(prompt, /Do not call tools/);
    assert.match(prompt, /Request: Trim the config/);
  });
});
