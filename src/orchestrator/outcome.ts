/**
 * machine_code — typed Build/Review results.
 *
 * Agents end with a labelled line. Parsing is deterministic; prose remains
 * available for the run transcript and human inspection.
 */
export type BuildOutcome = "completed" | "needs_planning" | "blocked" | "failed";
export type ReviewVerdict = "approved" | "changes_requested" | "needs_planning" | "blocked" | "failed";

export interface TypedResult<T extends string> {
  value: T;
  source: "label" | "fallback";
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

export function parseBuildOutcome(text: string): BuildOutcome | undefined {
  const match = text.match(/(?:^|\n)\s*Outcome\s*:\s*([A-Za-z_ -]+)/i);
  if (!match) return undefined;
  const value = normalize(match[1]!);
  if (value === "completed" || value === "needs_planning" || value === "blocked" || value === "failed") {
    return value;
  }
  return undefined;
}

export function parseReviewVerdict(text: string): ReviewVerdict | undefined {
  const match = text.match(/(?:^|\n)\s*Verdict\s*:\s*([A-Za-z_ -]+)/i);
  if (!match) return undefined;
  const value = normalize(match[1]!);
  if (value === "approved" || value === "changes_requested" || value === "needs_planning" || value === "blocked" || value === "failed") {
    return value;
  }
  return undefined;
}

/** Conservative fallback for older prompts that did not emit a label. */
export function inferReviewVerdict(text: string): ReviewVerdict {
  if (/\breject/i.test(text) || /changes?\s+requested/i.test(text)) return "changes_requested";
  if (/\bneeds?\s+planning\b/i.test(text)) return "needs_planning";
  if (/\bblocked\b/i.test(text)) return "blocked";
  if (/\bfailed\b/i.test(text)) return "failed";
  return "approved";
}
