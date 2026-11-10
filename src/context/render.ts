/**
 * machine_code — render the model prompt from run state + the current step.
 *
 * The prompt is the system prompt, the assembled task context, a compact state
 * block, current working-file content, and the transcript as a call ledger:
 * recent tool payloads in full, older bulk summarized with a re-fetch path.
 * Full bytes live in the run ledger and the assembled context, both
 * re-readable; replaying every dump every turn is what made long runs cost
 * millions of tokens. The last few results stay verbatim so the current
 * step's evidence is always intact.
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

/** A complete step: the assistant's calls all have results in the same step.
 * An incomplete trailing step is dropped so the provider never sees an orphan
 * tool call — that is protocol validity, not compression. */
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

/** Every complete assistant/tool step, oldest first, unchanged. Leading user
 * messages (the task) are kept: the request must survive every turn, not just
 * the first. */
const SUMMARIZE_AT_CHARS = 2048;
const KEEP_FULL_RESULTS = 3;
const KEEP_FULL_ASSISTANT = 2;
const SUMMARY_LINES = 6;

/** Total text chars in a message content payload. */
function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
      total += ((block as Record<string, unknown>).text as string).length;
    }
  }
  return total;
}

/** Shrink one text payload to its head plus an honest marker. Never touches
 * toolCall blocks: protocol validity depends on their exact shape. */
function shrinkText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= SUMMARY_LINES + 1) return text;
  const head = lines.slice(0, SUMMARY_LINES).join("\n").replace(/\s+$/, "");
  return `${head}\n…[${lines.length - SUMMARY_LINES} more lines, ${text.length.toLocaleString()} chars total — earlier tool output, summarized; re-run the call for full bytes]`;
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content.length > SUMMARIZE_AT_CHARS ? shrinkText(content) : content;
  }
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "toolCall") return block;
    if (typeof b.text === "string" && (b.text as string).length > SUMMARIZE_AT_CHARS) {
      return { ...b, text: shrinkText(b.text as string) };
    }
    return block;
  });
}

/**
 * The transcript as a call ledger: the last few payloads verbatim, older
 * bulk summarized. Assistant text keeps a longer verbatim tail than tool
 * results (reasoning continuity matters; dumps do not). Operates on copies;
 * stored history keeps full detail for provenance and resume.
 */
function summarizeOldPayloads(messages: MessageLike[]): MessageLike[] {
  const resultIdx: number[] = [];
  const assistantIdx: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "toolResult") resultIdx.push(index);
    else if (message.role === "assistant") assistantIdx.push(index);
  });
  const fullResults = new Set(resultIdx.slice(-KEEP_FULL_RESULTS));
  const fullAssistant = new Set(assistantIdx.slice(-KEEP_FULL_ASSISTANT));
  return messages.map((message, index) => {
    if (message.role === "toolResult" && !fullResults.has(index) && contentChars(message.content) > SUMMARIZE_AT_CHARS) {
      return { ...message, content: summarizeContent(message.content) };
    }
    if (message.role === "assistant" && !fullAssistant.has(index) && contentChars(message.content) > SUMMARIZE_AT_CHARS * 2) {
      return { ...message, content: summarizeContent(message.content) };
    }
    return message;
  });
}
function transcriptSteps(messages: readonly MessageLike[]): MessageLike[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "assistant") starts.push(i);
  }
  const out: MessageLike[] = [];
  const firstAssistant = starts[0] ?? messages.length;
  for (let i = 0; i < firstAssistant; i += 1) {
    if (messages[i]?.role === "user") out.push(messages[i]!);
  }
  if (starts.length === 0) return out;
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : messages.length;
    if (!completeStep(messages, start, end)) continue;
    out.push(...messages.slice(start, end));
  }
  return out;
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
  overviewMaxChars?: number,
  commandIndex?: string,
): RenderedPrompt {
  const source = messages as unknown as MessageLike[];
  const system = source.find((message) => message.role === "system");
  // Fixed prompt section order (prompt-cache stable):
  //   system → assembled context → map index → tool guide → command index
  //     → transcript → working context → run state.
  // The stable prefix renders before the transcript so it stays byte-identical
  // across turns. The per-turn working context and run state sit *after* the
  // transcript: putting them before it changed the prefix every turn and the
  // provider cache stopped at the fixed blocks (~3.5k tokens). The state is
  // also the last thing the model reads, which is where it belongs.
  const guide = TOOL_GUIDE;
  const startup = trimContextText(startupContext, overviewMaxChars);
  const stable = [startup, mapIndex, guide, commandIndex].filter(Boolean).join("\n\n");
  const volatile = [state.renderWorkingContext(), state.renderBlock()].filter(Boolean).join("\n\n");
  const out = [
    ...(system ? [system] : []),
    ...(stable ? [{ role: "user", content: stable, timestamp: Date.now() } as MessageLike] : []),
    ...summarizeOldPayloads(transcriptSteps(source)),
    ...(volatile ? [{ role: "user", content: volatile, timestamp: Date.now() } as MessageLike] : []),
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
