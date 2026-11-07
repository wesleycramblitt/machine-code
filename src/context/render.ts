/**
 * machine_code — render the model prompt from run state + the current step.
 *
 * The prompt is not a transcript replay. It is the system prompt, the assembled
 * task context, a compact state block, current working-file content, and the
 * last two complete assistant/tool steps. Older evidence lives in state and
 * artifacts.
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
 * priority order, so the first blocks that fit are kept and the rest are
 * named as omitted.
 */
export function trimContextText(text: string | undefined, maxChars?: number): string | undefined {
  if (!text) return text;
  if (maxChars === undefined || maxChars <= 0 || text.length <= maxChars) return text;
  const blocks = [...text.matchAll(/<context-block[\s\S]*?<\/context-block>/g)].map((match) => match[0]);
  if (blocks.length === 0) {
    return `${text.slice(0, Math.max(0, maxChars - 24)).replace(/\s+$/, "")}\n…[context truncated]`;
  }
  const header = "<context>\nAssembled context for this run. Blocks are in priority order.\n";
  const footer = "\n</context>";
  let out = header;
  let kept = 0;
  for (const block of blocks) {
    if (out.length + block.length + 2 + footer.length > maxChars) break;
    out += `\n${block}`;
    kept += 1;
  }
  if (kept === 0) {
    return `${header}\n_Context blocks omitted for the model budget._${footer}`.slice(0, maxChars);
  }
  const omission = kept < blocks.length ? `\n_…${blocks.length - kept} block(s) omitted._` : "";
  if (out.length + omission.length + footer.length > maxChars) {
    out = out.slice(0, Math.max(0, maxChars - omission.length - footer.length));
  }
  out += omission + footer;
  return out.length <= maxChars ? out : `${out.slice(0, Math.max(0, maxChars - 24)).replace(/\s+$/, "")}\n…[context truncated]`;
}

/** Cap on one replayed tool-result text block. The ledger keeps the full
 * bytes (with a recall pointer) and working context re-sends current file
 * content, so the replayed steps stay small without losing anything
 * recoverable. Copies blocks; never mutates the stored transcript. */
const STEP_TEXT_CAP = 6_000;

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

/** Cap on replayed assistant reasoning. Runs are isolated, so the model's own
 * words ride along in full; the cap only stops pathological growth, keeping
 * the newest reasoning. Whitespace-only blocks (a model that thinks without
 * writing) are skipped. Read-only over the transcript. */
const MAX_REASONING_CHARS = 32_000;

/** Every word the model has said to itself this run, oldest first. Tool
 * results stay capped in the replayed steps and full in the ledger; this is
 * the reasoning continuity weak models need to avoid re-deriving — and
 * drifting from — their own conclusions. */
function collectReasoning(messages: readonly MessageLike[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown[]) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
        texts.push(b.text);
      }
    }
  }
  const full = texts.join("\n");
  if (full.length <= MAX_REASONING_CHARS) return full;
  const kept = full.slice(-MAX_REASONING_CHARS).replace(/^\S*\n/, "");
  return `…[${full.length - kept.length} earlier reasoning chars omitted]\n${kept}`;
}

/** Keep the last few complete assistant/tool steps, never an orphan call. */
function recentSteps(messages: readonly MessageLike[], count = 2): MessageLike[] {
  const assistants: number[] = [];
  for (let i = messages.length - 1; i >= 0 && assistants.length < count; i -= 1) {
    if (messages[i]?.role === "assistant") assistants.push(i);
  }
  if (assistants.length > 0) {
    for (const start of assistants.reverse()) {
      const step = messages.slice(start);
      const calls = toolCalls(messages[start]!);
      if (calls.length === 0) return step;
      const results = new Set(
        step
          .filter((message) => message.role === "toolResult" && typeof message.toolCallId === "string")
          .map((message) => message.toolCallId as string),
      );
      if (calls.every((id) => results.has(id))) return step;
    }
  }
  // A user answer (ask) or follow-up is its own step.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      const userMessages = messages.filter((message) => message.role === "user");
      return userMessages.length > 1 ? [messages[i]!] : [];
    }
  }
  return [];
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
): RenderedPrompt {
  const source = messages as unknown as MessageLike[];
  const system = source.find((message) => message.role === "system");
  // The assembled context is the prompt. Stable content stays before volatile
  // state so the provider cache can reuse the prefix.
  const details = state.renderWorkingContext();
  const guide = TOOL_GUIDE;
  const startup = trimContextText(startupContext, overviewMaxChars);
  const reasoning = collectReasoning(source);
  const reasoningBlock = reasoning
    ? `<reasoning>\nYour own thinking so far this run, oldest first. Trust conclusions you already reached; do not re-derive them.\n\n${reasoning}\n</reasoning>`
    : "";
  const block = [startup, mapIndex, guide, reasoningBlock, details, ledgerText, state.renderBlock()]
    .filter(Boolean)
    .join("\n\n");
  const user: MessageLike = {
    role: "user",
    content: block,
    timestamp: Date.now(),
  };
  const step = capStepText(recentSteps(source, 2));
  const out = [
    ...(system ? [system] : []),
    user,
    ...step,
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
