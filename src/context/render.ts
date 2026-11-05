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
 * The task pack carries task files with the correct size. Remove the assembled
 * file blocks so a truncated copy cannot compete with the pack.
 */
function withoutFileBlocks(text: string | undefined): string | undefined {
  if (!text || !text.includes('<context-block kind="file"')) return text;
  const stripped = text
    .replace(/<context-block kind="file"[^>]*>[\s\S]*?<\/context-block>\s*/g, "")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
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
  packText?: string,
  ledgerText?: string,
): RenderedPrompt {
  const source = messages as unknown as MessageLike[];
  const system = source.find((message) => message.role === "system");
  // The bound task packet leads. It names the work; the repo map is reference.
  // The task pack holds symbol-aware specifics, and the state block holds the
  // current plan/changes. Stable content stays before volatile state so the
  // provider cache can reuse the prefix. A run without a pack falls back to the
  // working-context slice.
  const details = packText ?? state.renderWorkingContext();
  const guide = packText ? "" : TOOL_GUIDE;
  const startup = packText ? withoutFileBlocks(startupContext) : startupContext;
  const block = [startup, mapIndex, guide, details, ledgerText, state.renderBlock()]
    .filter(Boolean)
    .join("\n\n");
  const user: MessageLike = {
    role: "user",
    content: block,
    timestamp: Date.now(),
  };
  const step = recentSteps(source, 2);
  const out = [
    ...(system ? [system] : []),
    user,
    ...step,
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
