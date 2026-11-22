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
 *
 * Re-served answers are native toolCall/toolResult message pairs carrying the
 * exact original params — the same structure as live results, which is what
 * makes the model treat them as current data rather than quoted text.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

export interface RetainedCall {
  /** Original toolCallId, for in-window exclusion. */
  id: string;
  /** Prepared params, ready to re-execute. */
  params: Record<string, unknown>;
  /** Turn the model asked it; null when rebuilt from a resumed transcript. */
  turn: number | null;
}

/** Most distinct calls worth re-serving in one prompt. */
export const MAX_RETAINED_CALLS = 30;
/** Per-envelope cap; the share bounds the total. */
const ENVELOPE_CAP_CHARS = 16_384;
const DIFF_CAP_CHARS = 8_192;

function textOf(result: { content: Array<{ type?: unknown; text?: unknown }> }): string {
  return result.content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function withProvenance(envelope: string): string {
  // No turn numbers, no relative age: anything that lets the model judge
  // freshness by age invites the stale-data distrust pattern. Everything
  // here was re-retrieved this turn, so the tag says exactly that.
  const tag = "[re-served; body current from disk]";
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

export interface BuiltEvidence {
  /** Framing + accounting user text; the pairs below it carry the bodies. */
  text: string | null;
  /**
   * Native toolCall/toolResult pairs, oldest first, batched by original
   * turn exactly like live multi-call turns. Synthetic ids
   * (`evidence-<turn>-<n>`); params are the exact original prepared args.
   */
  messages: AgentMessage[];
}

interface TakenCall {
  call: RetainedCall;
  text: string;
}

function toMessages(taken: TakenCall[]): AgentMessage[] {
  // Chronological replay: oldest first, batched by the turn that made
  // them — the same shape as the live turns that produced them.
  const chronological = [...taken].reverse();
  const groups = new Map<string, TakenCall[]>();
  for (const entry of chronological) {
    const key = entry.call.turn === null ? "r" : String(entry.call.turn);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const messages: AgentMessage[] = [];
  let n = 0;
  for (const [turnKey, entries] of groups) {
    const ids = entries.map(() => `evidence-${turnKey}-${n++}`);
    messages.push({
      role: "assistant",
      content: entries.map((entry, i) => ({
        type: "toolCall",
        id: ids[i],
        name: "inspect",
        arguments: entry.call.params,
      })),
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as unknown as AgentMessage);
    for (let i = 0; i < entries.length; i++) {
      messages.push({
        role: "toolResult",
        toolCallId: ids[i],
        toolName: "inspect",
        content: [{ type: "text", text: entries[i]!.text }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage);
    }
  }
  return messages;
}

export async function buildEvidence(input: EvidenceInput): Promise<BuiltEvidence> {
  const taken: TakenCall[] = [];
  let omitted = 0;
  const take = (call: RetainedCall, text: string): boolean => {
    const capped = capEnvelope(text);
    const current = taken.reduce((sum, entry) => sum + entry.text.length + 2, 0);
    if (current + capped.length + 2 > input.maxChars && taken.length > 0) {
      omitted += 1;
      return false;
    }
    taken.push({ call, text: capped });
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
      take(call, withProvenance(text));
    }
  }

  const diff = (await input.diff().catch(() => "")).trim();
  let diffText: string | null = null;
  if (diff) {
    const capped = diff.length > DIFF_CAP_CHARS ? diff.slice(0, DIFF_CAP_CHARS) + "…[trimmed for evidence budget]" : diff;
    const labeled = "command core:diff (fresh this turn):\n" + capped;
    const used = taken.reduce((sum, entry) => sum + entry.text.length + 2, 0);
    if (used + labeled.length + 2 <= input.maxChars || taken.length === 0) {
      diffText = labeled;
    } else {
      omitted += 1;
    }
  }

  const messages = toMessages(taken);
  if (messages.length === 0 && !diffText) return { text: null, messages: [] };
  const total = input.retained.length + (diff ? 1 : 0);
  const shown = taken.length + (diffText ? 1 : 0);
  const accounting =
    omitted > 0
      ? `[${total} retained, ${shown} re-served below as tool results; ${omitted} omitted for budget. Re-inspect to expand.]`
      : `[${total} retained, all re-served below as tool results.]`;
  const text = [
    "<evidence>",
    "[Earlier answers, re-served fresh this turn. Anything in the last two steps is not repeated here.]",
    ...(diffText ? [diffText] : []),
    accounting,
    "</evidence>",
  ].join("\n\n");
  return { text, messages };
}
