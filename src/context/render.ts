/**
 * machine_code — render the model prompt from run state + the current step.
 *
 * The prompt is the system prompt, the assembled task context, a compact state
 * block, the current symbol map, and the last two transcript steps in full.
 * The seeds live in the assembled context; replaying every dump every turn
 * is what made long runs cost millions of tokens. Older steps are dropped
 * outright — durable knowledge lives in notes and the symbol map, not in
 * truncated call receipts. The last two results stay verbatim so the current
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
const KEEP_FULL_STEPS = 2;
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

function textOfMessage(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Keep the task head and the last two full steps. */
function transcriptMessages(source: readonly MessageLike[]): MessageLike[] {
  const steps = transcriptSteps(source);
  const firstAssistant = steps.findIndex((message) => message.role === "assistant");
  if (firstAssistant < 0) return steps;
  const groups: MessageLike[][] = [];
  for (const message of steps.slice(firstAssistant)) {
    if (message.role === "assistant") groups.push([message]);
    else if (groups.length > 0) groups[groups.length - 1]!.push(message);
  }
  const recent = groups.slice(-KEEP_FULL_STEPS).flat();
  return [...steps.slice(0, firstAssistant), ...recent];
}

/** ToolCallIds whose results survive in the kept transcript window. The
 * evidence section skips these so nothing is shown twice. */
export function keptToolCallIds(source: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of transcriptMessages(source as unknown as MessageLike[])) {
    const content = (message as MessageLike).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "toolResult" && typeof b.toolCallId === "string") ids.add(b.toolCallId);
      }
    }
  }
  return ids;
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
  symbolsMaxChars = 48_000,
  stateMaxChars = 30_000,
  evidence?: string,
): RenderedPrompt {
  const source = messages as unknown as MessageLike[];
  const system = source.find((message) => message.role === "system");
  // Fixed prompt section order (prompt-cache stable):
  //   system → assembled context → map index → tool guide → command index
  //     → transcript → workspace → symbols → run state → evidence.
  // The stable prefix renders before the transcript so it stays byte-identical
  // across turns. The ~1KB map index names every directory with file counts;
  // deeper structure pulls via inspect or map overview.
  // The per-turn symbols, run state, and evidence sit *after* the transcript
  // so they never shift the cache prefix.
  const guide = TOOL_GUIDE;
  const startup = trimContextText(startupContext, overviewMaxChars);
  const stable = [startup, mapIndex, guide, commandIndex].filter(Boolean).join("\n\n");
  const volatile = [
    state.renderWorkspace(),
    state.renderSymbols(symbolsMaxChars),
    state.renderBlock(stateMaxChars),
    evidence,
  ].filter(Boolean).join("\n\n");
  const out = [
    ...(system ? [system] : []),
    ...(stable ? [{ role: "user", content: stable, timestamp: Date.now() } as MessageLike] : []),
    ...transcriptMessages(source),
    ...(volatile ? [{ role: "user", content: volatile, timestamp: Date.now() } as MessageLike] : []),
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
