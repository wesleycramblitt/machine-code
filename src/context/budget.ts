/**
 * machine_code — model-derived context budgets.
 *
 * The context window is a resource, not a fixed character cap. A model with a
 * 1M-token window should receive the full curated context; a 32k model should
 * receive it trimmed to its smaller budget with an explicit warning. Price is a
 * soft limit: record it, warn on unusual cost, but never silently drop
 * task-critical bytes.
 */
import type { ContextKind, ContextSection } from "./types.js";

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

/**
 * Per-section share of the usable input budget. System covers the prompt
 * prefix in render; assemble records 0 for it. Plan (packets + plans) is
 * task-critical, files carry the working set, and tools/skills/parents are
 * the first to yield when over budget.
 */
export const SECTION_FRACTIONS: Record<ContextSection, number> = {
  system: 0.1,
  plan: 0.25,
  files: 0.4,
  tools: 0.05,
  skills: 0.1,
  parents: 0.1,
};

/** Map a context kind onto its budget section. Unknown kinds are files. */
export function sectionForKind(kind: ContextKind | string): ContextSection {
  switch (kind) {
    case "plan":
    case "project":
    case "packet":
      return "plan";
    case "skill":
      return "skills";
    case "tool":
    case "script":
      return "tools";
    case "parent-run":
    case "epic":
    case "feature":
    case "task":
      return "parents";
    case "file":
    case "knowledge":
    case "reference":
    default:
      return "files";
  }
}

export interface SectionBudgets {
  /** Usable input budget in chars: limit - response reserve. */
  budget: number;
  responseReserveChars: number;
  caps: Record<ContextSection, number>;
}

/**
 * Explicit per-section budgets. `limitChars` is the model input budget
 * (already `limit - response_reserve` when callers pass
 * `contextBudget().inputChars`); pass a reserve here only when starting
 * from the raw window size.
 */
export function sectionBudgets(limitChars: number, responseReserveChars = 0): SectionBudgets {
  const reserve = Math.max(0, Math.floor(responseReserveChars));
  const budget = Math.max(1024, Math.floor(limitChars) - reserve);
  const caps = {} as Record<ContextSection, number>;
  for (const [section, fraction] of Object.entries(SECTION_FRACTIONS) as Array<[ContextSection, number]>) {
    caps[section] = Math.floor(budget * fraction);
  }
  return { budget, responseReserveChars: reserve, caps };
}

/**
 * Rendered wrapper overhead for one context block, mirroring
 * assembleContext, so the composer preview can estimate real costs without
 * assembling.
 */
export function blockOverhead(kind: string, ref: string, origin: string, depth?: number): number {
  const attrs = [
    `kind="${kind}"`,
    `source="${ref.replace(/"/g, "'")}"`,
    `origin="${origin}"`,
    ...(depth !== undefined ? [`depth="${depth}"`] : []),
  ];
  return `<context-block ${attrs.join(" ")}>\n`.length + "\n</context-block>".length + 1;
}
