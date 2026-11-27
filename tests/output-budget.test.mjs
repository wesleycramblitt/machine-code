/**
 * Response budget is context-derived, not a flat constant.
 *
 * A 1M-token model with a small request must be allowed to emit a large file;
 * a small-window model must still leave room for its input. An explicit
 * `max_output_tokens` can lower or raise the share but cannot exceed the
 * model's own maximum or the window headroom.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requestedOutputTokens } from "../dist/context/budget.js";

describe("requestedOutputTokens", () => {
  it("scales with the context window instead of a flat cap", () => {
    const large = requestedOutputTokens({
      contextWindowTokens: 1_048_576,
      inputTokens: 60_000,
      modelMaxTokens: 943_718,
    });
    const small = requestedOutputTokens({
      contextWindowTokens: 32_000,
      inputTokens: 20_000,
      modelMaxTokens: 8_000,
    });
    assert.ok(large > 60_000, `expected >60k for 1M window, got ${large}`);
    assert.ok(small <= 8_000, `expected <=8k for 32k window, got ${small}`);
  });

  it("never exceeds the model maximum", () => {
    assert.equal(
      requestedOutputTokens({
        contextWindowTokens: 1_048_576,
        inputTokens: 1_000,
        modelMaxTokens: 4_096,
      }),
      4_096,
    );
  });

  it("never exceeds the window headroom left by the request", () => {
    // 16k window, 14k input: only ~2k of physical room remains.
    const budget = requestedOutputTokens({
      contextWindowTokens: 16_000,
      inputTokens: 14_000,
      modelMaxTokens: 64_000,
    });
    assert.ok(budget <= 2_000, `expected <=2k, got ${budget}`);
    assert.ok(budget > 0);
  });

  it("honors an explicit ceiling in both directions", () => {
    assert.equal(
      requestedOutputTokens({
        contextWindowTokens: 1_048_576,
        inputTokens: 1_000,
        modelMaxTokens: 943_718,
        ceiling: 6_000,
      }),
      6_000,
    );
    assert.equal(
      requestedOutputTokens({
        contextWindowTokens: 1_048_576,
        inputTokens: 1_000,
        modelMaxTokens: 943_718,
        ceiling: 200_000,
      }),
      200_000,
    );
  });
});
