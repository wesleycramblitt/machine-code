/**
 * machine_code — re-served tool evidence.
 *
 * The prompt keeps the transcript head plus the last two steps; everything
 * older vanishes, so models re-ask for bodies they already fetched (observed:
 * 23 byte-identical repeats in one 38-turn run). This module re-presents the
 * run's distinct inspect answers every turn — most recent first, verbatim
 * envelopes, bodies re-retrieved from disk on the fly — plus a fresh
 * core:diff. Nothing is stored except the call ledger (tool + prepared
 * params + turn); staleness is unrepresentable because no bytes are kept.
 * Over budget, oldest drops first with a named accounting line.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface RetainedCall {
  /** Original toolCallId, for in-window exclusion. */
  id: string;
  /** Prepared params, ready to re-execute. */
  params: Record<string, unknown>;
  /** Turn the model asked it; null when rebuilt from a resumed transcript. */
  turn: number | null;
}

/** Most distinct calls worth re-serving in one prompt. */
export const MAX_RETAINED_CALLS = 50;
/** Per-envelope cap; the share bounds the total. */
const ENVELOPE_CAP_CHARS = 16_384;
const DIFF_CAP_CHARS = 8_192;

function textOf(result: { content: Array<{ type?: unknown; text?: unknown }> }): string {
  return result.content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function withProvenance(envelope: string, turn: number | null): string {
  const tag = turn === null ? "[re-served; body current from disk]" : `[asked turn ${turn}; body current from disk]`;
  const lines = envelope.split("\n");
  if (lines.length > 0 && lines[0]!.startsWith("<") && envelope.includes("</")) {
    return [lines[0], tag, ...lines.slice(1)].join("\n");
  }
  return `${tag}\n${envelope}`;
}

function capEnvelope(text: string): string {
  if (text.length <= ENVELOPE_CAP_CHARS) return text;
  return `${text.slice(0, ENVELOPE_CAP_CHARS)}…[trimmed for evidence budget; re-inspect to expand]`;
}

export interface EvidenceInput {
  /** Distinct retained calls, most recent first. */
  retained: RetainedCall[];
  /** Unwrapped inspect tool for silent re-execution. */
  inspect: AgentTool | undefined;
  /** Fresh worktree diff provider. */
  diff: () => Promise<string>;
  /** ToolCallIds whose results are already in the kept transcript window. */
  keptIds: Set<string>;
  /** Total chars allowed for the section body. */
  maxChars: number;
}

export async function buildEvidence(input: EvidenceInput): Promise<string> {
  const blocks: string[] = [];
  let omitted = 0;
  const take = (text: string): boolean => {
    const capped = capEnvelope(text);
    const current = blocks.join("\n\n").length;
    if (current + capped.length + 2 > input.maxChars && blocks.length > 0) {
      omitted += 1;
      return false;
    }
    blocks.push(capped);
    return true;
  };

  if (input.inspect) {
    let n = 0;
    for (const call of input.retained) {
      if (input.keptIds.has(call.id)) continue;
      let result: { content: Array<{ type?: unknown; text?: unknown }>; isError?: boolean };
      try {
        result = (await input.inspect.execute(
          `evidence-${n += 1}`,
          call.params as never,
          new AbortController().signal,
        )) as unknown as typeof result;
      } catch {
        continue;
      }
      if (!result || result.isError) continue;
      const text = textOf(result).trim();
      if (!text) continue;
      take(withProvenance(text, call.turn));
    }
  }

  const diff = (await input.diff().catch(() => "")).trim();
  if (diff) {
    const capped = diff.length > DIFF_CAP_CHARS ? `${diff.slice(0, DIFF_CAP_CHARS)}…[trimmed for evidence budget]` : diff;
    const labeled = `command core:diff (fresh this turn):\n${capped}`;
    const current = blocks.join("\n\n").length;
    if (current + labeled.length + 2 > input.maxChars && blocks.length > 0) {
      omitted += 1;
    } else {
      blocks.push(labeled);
    }
  }

  if (blocks.length === 0) return "";
  const total = input.retained.length + (diff ? 1 : 0);
  const shown = blocks.length;
  const accounting =
    omitted > 0
      ? `[${total} retained, ${shown} shown above; ${omitted} omitted for budget. Re-inspect to expand.]`
      : `[${total} retained, all shown above.]`;
  return [
    "<evidence>",
    "[Earlier answers, re-served fresh this turn. Anything in the last two steps is not repeated here.]",
    ...blocks,
    accounting,
    "</evidence>",
  ].join("\n\n");
}
