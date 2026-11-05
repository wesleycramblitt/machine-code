/**
 * machine_code — model-derived context budgets.
 *
 * The context window is a resource, not a fixed character cap. A model with a
 * 1M-token window should receive the full curated context; a 32k model should
 * receive it trimmed to its smaller budget with an explicit warning. Price is a
 * soft limit: record it, warn on unusual cost, but never silently drop
 * task-critical bytes.
 */

/** Conservative characters per token for prompt estimation. */
export const CHARS_PER_TOKEN = 4;

/** Keep room for the response and provider overhead. */
const MIN_OUTPUT_RESERVE = 8_000;
const PROVIDER_RESERVE = 4_000;

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  inputTokens: number;
  inputChars: number;
}

/**
 * Input budget for one request. `expectedOutputTokens` is the role's expected
 * response, not the model's maximum. A model that supports 384k output does
 * not need 384k reserved when the run asks for 2k.
 */
export function contextBudget(
  contextWindowTokens: number,
  expectedOutputTokens: number,
): ContextBudget {
  const window = Math.max(8_000, Math.floor(contextWindowTokens));
  const reserve = Math.max(MIN_OUTPUT_RESERVE, Math.floor(expectedOutputTokens)) + PROVIDER_RESERVE;
  const inputTokens = Math.max(4_000, window - reserve);
  return {
    contextWindowTokens: window,
    outputReserveTokens: reserve,
    inputTokens,
    inputChars: inputTokens * CHARS_PER_TOKEN,
  };
}

/** Estimated input cost in USD for a token count and a per-million price. */
export function inputCost(tokens: number, pricePerMillion: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(pricePerMillion) || tokens <= 0 || pricePerMillion <= 0) {
    return 0;
  }
  return (tokens / 1_000_000) * pricePerMillion;
}

/** Move a character count to a token estimate. */
export function charsToTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}
