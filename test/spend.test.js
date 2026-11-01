/**
 * Spend ledger totals, token/free accounting, queries, and daily series.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendSpendRecord, readSpendSummary, spendDays } from "../dist/spend.js";

function record(overrides = {}) {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    t: overrides.t ?? new Date().toISOString(),
    repoRoot: overrides.repoRoot ?? "/repo",
    runId: "run",
    agent: overrides.agent ?? "build",
    provider: overrides.provider ?? "openrouter",
    model: overrides.model ?? "model-a",
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, ...(overrides.usage ?? {}) },
    cost: { actual: overrides.actual ?? 0.01, estimated: overrides.estimated ?? 0.02 },
    stopReason: "stop",
  };
}

test("summary tracks actual, estimated, tokens, and free tokens by dimension", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-spend-"));
  try {
    appendSpendRecord(home, record({ provider: "openrouter", model: "a", actual: 0.02, usage: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 125 } }));
    appendSpendRecord(home, record({ provider: "nvidia", model: "free", actual: 0, estimated: 0, usage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, agent: "review" }));
    const summary = readSpendSummary(home, { days: 30 });
    assert.equal(summary.totalActual, 0.02);
    assert.equal(summary.totalTokens, 225);
    assert.equal(summary.freeTokens, 100);
    assert.equal(summary.byProvider.openrouter.tokens, 125);
    assert.equal(summary.byProvider.nvidia.freeTokens, 100);
    assert.equal(summary.byAgent.review.tokens, 100);
    const filtered = readSpendSummary(home, { provider: "nvidia" });
    assert.equal(filtered.totalActual, 0);
    assert.equal(filtered.totalTokens, 100);
    assert.equal(spendDays(summary, 7).length, 7);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
