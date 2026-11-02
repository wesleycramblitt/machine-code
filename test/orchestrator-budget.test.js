import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetStop } from "../dist/orchestrator/budget.js";

test("budget stops on time or spend", () => {
  assert.equal(budgetStop({ deadline: 2_000, spentUsd: 0, now: 1_000 }), undefined);
  assert.equal(budgetStop({ deadline: 2_000, spentUsd: 0, now: 2_000 }), "max-minutes reached");
  assert.equal(budgetStop({ maxSpendUsd: 0.5, spentUsd: 0.49, now: 0 }), undefined);
  assert.equal(budgetStop({ maxSpendUsd: 0.5, spentUsd: 0.5, now: 0 }), "max-spend-usd reached");
  assert.equal(budgetStop({ spentUsd: 10, now: 0 }), undefined);
});
