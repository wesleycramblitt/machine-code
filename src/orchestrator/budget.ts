/**
 * machine_code — invocation budgets for one orchestration pass.
 *
 * Budgets are wall-clock or actual spend limits. They stop new dispatch; an
 * in-flight run is allowed to finish before the pass exits.
 */
export interface BudgetInput {
  /** Absolute deadline in ms since epoch. */
  deadline?: number;
  maxSpendUsd?: number;
  spentUsd: number;
  now?: number;
}

export function budgetStop(input: BudgetInput): string | undefined {
  const now = input.now ?? Date.now();
  if (input.deadline !== undefined && now >= input.deadline) return "max-minutes reached";
  if (input.maxSpendUsd !== undefined && input.spentUsd >= input.maxSpendUsd) return "max-spend-usd reached";
  return undefined;
}
