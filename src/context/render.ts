/**
 * machine_code — render the model prompt from run state + the current step.
 *
 * The prompt is the system prompt, the assembled task context, a compact state
 * block, current working-file content, and a budgeted window of the real
 * transcript (assistant turns plus their tool results). The window is what
 * keeps the model oriented; dropping old tool results after two turns makes it
 * re-read the same evidence in waves. Older bytes stay in the ledger and can
 * be pulled back with context recall.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunStateStore } from "./state.js";
import { TOOL_GUIDE } from "../tools/policy.js";

interface MessageLike {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  [key: string]: unknown;
}

function toolCalls(message: MessageLike): string[] {
  if (!Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "toolCall" && typeof b.id === "string") ids.push(b.id);
  }
  return ids;
}

/**
 * Trim an assembled context bundle to a model budget. Blocks are already in
 * priority order, so the lowest-priority tail is dropped first and every
 * omission is named. Kept blocks are never sliced mid-content.
 */
export function trimContextText(text: string | undefined, maxChars?: number): string | undefined {
  if (!text) return text;
  if (maxChars === undefined || maxChars <= 0 || text.length <= maxChars) return text;
  const blocks = [...text.matchAll(/<context-block[\s\S]*?<\/context-block>/g)].map((match) => match[0]);
  if (blocks.length === 0) {
    return `${text.slice(0, Math.max(0, maxChars - 24)).replace(/\s+$/, "")}\n…[context truncated]`;
  }
  const nameOf = (block: string): string => block.match(/\ssource="([^"]*)"/)?.[1] ?? "context block";
  const header = "<context>\nAssembled context for this run. Blocks are in priority order.\n";
  const footer = "\n</context>";
  const describe = (names: string[]): string =>
    `\n_…${names.length} block(s) omitted for the model budget: ${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""}._`;
  let kept = blocks.length;
  while (kept > 0) {
    const dropped = blocks.slice(kept).map(nameOf);
    const omission = dropped.length === 0 ? "" : describe(dropped);
    let out = header;
    for (const block of blocks.slice(0, kept)) out += `\n${block}`;
    out += omission + footer;
    if (out.length <= maxChars) return out;
    kept -= 1;
  }
  const fallback = `${header}${describe(blocks.map(nameOf))}${footer}`;
  if (fallback.length <= maxChars) return fallback;
  return `${header}\n_…${blocks.length} block(s) omitted for the model budget._${footer}`.slice(0, maxChars);
}

/** Cap on one replayed tool-result text block. The ledger keeps the full
 * bytes (with a recall pointer) and working context re-sends current file
 * content, so the replayed steps stay small without losing anything
 * recoverable. Copies blocks; never mutates the stored transcript. */
const STEP_TEXT_CAP = 8_000;

/** Replay a window of the real transcript, not a fixed number of steps.
 * A run's own tool results are its working memory: dropping them after two
 * turns is why weak models re-read the same file in waves. The window is
 * bounded so a long run cannot grow without limit; newest steps win. */
const TRANSCRIPT_BUDGET_CHARS = 48_000;

function capStepText(step: MessageLike[]): MessageLike[] {
  return step.map((message) => {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
    const content = (message.content as unknown[]).map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as Record<string, unknown>;
      if (b.type !== "text" || typeof b.text !== "string" || b.text.length <= STEP_TEXT_CAP) return block;
      return {
        ...b,
        text: `${b.text.slice(0, STEP_TEXT_CAP).replace(/\s+$/, "")}\n…[step output truncated to ${STEP_TEXT_CAP} chars; full bytes are in the run ledger — use context recall]`,
      };
    });
    return { ...message, content };
  });
}

/** Rough size of a message's payload; JSON escaping adds a little, which the
 * budget absorbs. */
function messageChars(message: MessageLike): number {
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;
  let total = 0;
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") total += b.text.length;
    if (b.type === "toolCall") total += JSON.stringify(b.arguments ?? {}).length;
  }
  return total;
}

/** A complete step: the assistant's calls all have results in the same step. */
function completeStep(messages: readonly MessageLike[], start: number, end: number): boolean {
  const calls = toolCalls(messages[start]!);
  if (calls.length === 0) return true;
  const step = messages.slice(start, end);
  const results = new Set(
    step
      .filter((message) => message.role === "toolResult" && typeof message.toolCallId === "string")
      .map((message) => message.toolCallId as string),
  );
  return calls.every((id) => results.has(id));
}

/** The most recent complete assistant/tool steps that fit the replay budget.
 * Newest wins; the oldest kept step is allowed to overflow so the model
 * always sees the turn it is answering. */
function transcriptTail(
  messages: readonly MessageLike[],
  budgetChars = TRANSCRIPT_BUDGET_CHARS,
): MessageLike[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "assistant") starts.push(i);
  }
  if (starts.length === 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return [messages[i]!];
    }
    return [];
  }
  const picked: MessageLike[] = [];
  let used = 0;
  for (let k = starts.length - 1; k >= 0; k -= 1) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : messages.length;
    if (!completeStep(messages, start, end)) continue;
    const step = messages.slice(start, end);
    const size = step.reduce((total, message) => total + messageChars(message), 0);
    if (picked.length > 0 && used + size > budgetChars) break;
    picked.unshift(...step);
    used += size;
  }
  return picked;
}

export interface RenderedPrompt {
  messages: AgentMessage[];
  chars: number;
}

export function renderPromptMessages(
  messages: readonly AgentMessage[],
  state: RunStateStore,
  mapIndex?: string,
  startupContext?: string,
  ledgerText?: string,
  overviewMaxChars?: number,
  commandIndex?: string,
  transcriptBudget?: number,
): RenderedPrompt {
  const source = messages as unknown as MessageLike[];
  const system = source.find((message) => message.role === "system");
  // The assembled context is the prompt. Stable content stays before volatile
  // state so the provider cache can reuse the prefix.
  const details = state.renderWorkingContext();
  const guide = TOOL_GUIDE;
  const startup = trimContextText(startupContext, overviewMaxChars);
  const block = [startup, mapIndex, guide, commandIndex, details, ledgerText, state.renderBlock()]
    .filter(Boolean)
    .join("\n\n");
  const user: MessageLike = {
    role: "user",
    content: block,
    timestamp: Date.now(),
  };
  const step = capStepText(transcriptTail(source, transcriptBudget));
  const out = [
    ...(system ? [system] : []),
    user,
    ...step,
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
