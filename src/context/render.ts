/**
 * machine_code — render the model prompt from run state + the current step.
 *
 * The prompt is not a transcript replay. It is the system prompt, a compact
 * state block, and the immediately preceding assistant/tool step (the evidence
 * for the next action). Older evidence lives in state and artifacts.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunStateStore } from "./state.js";

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

function lastStep(messages: readonly MessageLike[]): MessageLike[] {
  let assistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      assistant = i;
      break;
    }
  }
  if (assistant >= 0) {
    const step = messages.slice(assistant);
    const calls = toolCalls(messages[assistant]!);
    if (calls.length === 0) return step;
    const results = new Set(
      step
        .filter((message) => message.role === "toolResult" && typeof message.toolCallId === "string")
        .map((message) => message.toolCallId as string),
    );
    // Never send an assistant tool call without every result.
    if (calls.every((id) => results.has(id))) return step;
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
): RenderedPrompt {
  const source = messages as unknown as MessageLike[];
  const system = source.find((message) => message.role === "system");
  const block = [mapIndex, startupContext, state.renderBlock()].filter(Boolean).join("\n\n");
  const user: MessageLike = {
    role: "user",
    content: block,
    timestamp: Date.now(),
  };
  const step = lastStep(source);
  const out = [
    ...(system ? [system] : []),
    user,
    ...step,
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
