/**
 * machine_code — transcript checkpoints: the model conversation, persisted.
 *
 * The transcript (not the event log) is what a resumed run replays. It is
 * saved atomically at turn boundaries and, critically, when a run suspends in
 * `ask` — so a pending question + its later answer survive process death.
 *
 * Resume tail repair (repairResumeTail):
 * - assistant tail with unanswered tool calls → synthetic tool results
 *   (the inbox answer for `ask`, an explicit interruption error otherwise);
 * - terminal assistant text → a short "continue" user message;
 * - user/toolResult tail → continue as-is.
 *
 * When the transcript grows past the char budget, oldest complete turns are
 * dropped and replaced with a deterministic summary. The event log is never
 * replayed into the model.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./run-schema.js";

export const TRANSCRIPT_MAX_CHARS = 200_000;

export interface TranscriptFile {
  savedAt: string;
  /** Agent role of the invocation this transcript belongs to. */
  agent: string;
  /** Original request of the invocation. */
  request: string;
  messages: TranscriptMessage[];
}

/* Minimal structural view of pi-agent messages (they are plain JSON). */
export interface TranscriptMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

export function transcriptPath(runDir: string): string {
  return join(runDir, "transcript.json");
}

export function saveTranscript(
  runDir: string,
  data: { agent: string; request: string; messages: unknown[] },
): void {
  writeJsonAtomic(transcriptPath(runDir), {
    savedAt: new Date().toISOString(),
    agent: data.agent,
    request: data.request,
    messages: data.messages,
  });
}

export function loadTranscript(runDir: string): TranscriptFile | null {
  const file = transcriptPath(runDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TranscriptFile;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function transcriptChars(messages: readonly unknown[]): number {
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += 64;
    }
  }
  return total;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && typeof block === "object") {
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
        else if (block.type === "toolCall") parts.push(`${String(block.name)}(${JSON.stringify(block.arguments ?? {})})`);
      }
    }
    return parts.join(" ");
  }
  return "";
}

function summarizeTurn(turn: TranscriptMessage[]): string {
  const lines: string[] = [];
  for (const m of turn) {
    if (m.role === "user") {
      const t = textOf(m.content).replace(/\s+/g, " ").trim();
      if (t) lines.push(`- user: ${t.slice(0, 160)}`);
    } else if (m.role === "assistant") {
      const t = textOf(m.content).replace(/\s+/g, " ").trim();
      lines.push(`- assistant: ${t ? t.slice(0, 160) : "(tool calls only)"}`);
    } else if (m.role === "toolResult") {
      lines.push(`- result ${m.toolName ?? "?"}: ${m.isError ? "error" : "ok"}`);
    }
  }
  return lines.join("\n");
}

/**
 * Enforce the char budget: keep the leading messages (system prompt) and the
 * first user message (the original request), drop whole oldest turns, and
 * insert one deterministic summary message in their place.
 */
export function pruneTranscript(
  messages: TranscriptMessage[],
  maxChars: number = TRANSCRIPT_MAX_CHARS,
): { messages: TranscriptMessage[]; droppedTurns: number } {
  if (transcriptChars(messages) <= maxChars) return { messages, droppedTurns: 0 };

  // Leading messages (system prompt block) stay verbatim.
  let lead = 0;
  while (lead < messages.length && messages[lead]!.role === "system") lead += 1;

  const rest = messages.slice(lead);
  if (rest.length === 0) return { messages, droppedTurns: 0 };

  // First user message after the prompt carries the original request: keep.
  const firstIsUser = rest[0]!.role === "user";
  const keepHead = firstIsUser ? [rest[0]!] : [];
  const body = firstIsUser ? rest.slice(1) : rest;

  // Group the body into turns: each user message starts a turn; a trailing
  // assistant/toolResult group (no user) is its own turn.
  const turns: TranscriptMessage[][] = [];
  let current: TranscriptMessage[] = [];
  for (const m of body) {
    if (m.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);

  // Keep whole turns from the end while they fit (with slack for the summary).
  const kept: TranscriptMessage[][] = [];
  let used = transcriptChars([...messages.slice(0, lead), ...keepHead]);
  let dropped = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = transcriptChars(turns[i]!);
    if (used + cost > maxChars * 0.9 && kept.length > 0) {
      dropped = i + 1;
      break;
    }
    kept.unshift(turns[i]!);
    used += cost;
    if (i === 0) dropped = 0;
  }
  if (kept.length === 0) dropped = turns.length;

  const summaryText =
    dropped > 0
      ? `[transcript summary] ${dropped} earlier turn(s) were removed to fit the context budget. Deterministic digest of what was dropped:\n` +
        turns.slice(0, dropped).map((t) => summarizeTurn(t)).join("\n")
      : "";

  const out: TranscriptMessage[] = [...messages.slice(0, lead), ...keepHead];
  if (summaryText) {
    out.push({ role: "system", content: summaryText, timestamp: Date.now() });
  }
  for (const turn of kept) out.push(...turn);
  return { messages: out, droppedTurns: dropped };
}

/* -------------------------------------------------------- resume repair */

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function toolCallsOf(message: TranscriptMessage): ToolCallView[] {
  const calls: ToolCallView[] = [];
  if (!Array.isArray(message.content)) return calls;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block && block.type === "toolCall" && typeof block.id === "string") {
      calls.push({
        id: block.id,
        name: typeof block.name === "string" ? block.name : "unknown",
        args: (block.arguments ?? {}) as Record<string, unknown>,
      });
    }
  }
  return calls;
}

export interface ResumeRepair {
  messages: TranscriptMessage[];
  /** Tool calls that got a synthetic result. */
  repaired: Array<{ id: string; name: string; answered: boolean }>;
  /** True when a "continue" user message was appended after terminal text. */
  appendedResumePrompt: boolean;
}

/**
 * Repair a transcript tail so `agent.continue()` is always valid:
 * every unanswered tool call gets a synthetic result, and a terminal
 * assistant text tail gets a short resume instruction.
 *
 * `answerForQuestion` maps an ask tool call's question text to a recorded
 * answer (or null when the run died before the user responded).
 */
export function repairResumeTail(
  messages: TranscriptMessage[],
  answerForQuestion: (questionText: string) => string | null,
): ResumeRepair {
  const out = messages.map((m) => ({ ...m }));
  const repaired: ResumeRepair["repaired"] = [];
  let appendedResumePrompt = false;

  // Pass 1: reattach real answers to ask calls whose recorded result is the
  // pause/interrupt error (the user answered while the run was down).
  const askQuestionByCallId = new Map<string, string>();
  for (const m of out) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const call of toolCallsOf(m)) {
      if (call.name === "ask") askQuestionByCallId.set(call.id, String(call.args.question ?? ""));
    }
  }
  for (const m of out) {
    if (m.role !== "toolResult" || m.toolName !== "ask" || m.isError !== true) continue;
    if (typeof m.toolCallId !== "string") continue;
    const question = askQuestionByCallId.get(m.toolCallId);
    if (question === undefined) continue;
    const answer = answerForQuestion(question);
    if (answer !== null) {
      m.content = [{ type: "text", text: answer }];
      m.isError = false;
      repaired.push({ id: m.toolCallId, name: "ask", answered: true });
    }
  }

  // Pass 2: the tail must be continuable (user or toolResult last).
  const last = out[out.length - 1];
  if (last && last.role === "assistant") {
    const calls = toolCallsOf(last);
    if (calls.length > 0) {
      const answered = new Set<string>();
      for (const m of out) {
        if (m.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
      }
      for (const call of calls) {
        if (answered.has(call.id)) continue;
        let text: string;
        let isError: boolean;
        if (call.name === "ask") {
          const answer = answerForQuestion(call.args.question !== undefined ? String(call.args.question) : "");
          if (answer !== null) {
            text = answer;
            isError = false;
          } else {
            text = "(the run was interrupted while awaiting input; no answer was recorded)";
            isError = true;
          }
        } else {
          text = "(the run was interrupted before this tool result was recorded)";
          isError = true;
        }
        out.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text }],
          isError,
          timestamp: Date.now(),
        });
        repaired.push({ id: call.id, name: call.name, answered: call.name === "ask" && !isError });
      }
    } else {
      // Empty assistant shell (abort artifact): drop it and re-check. This
      // avoids stacking duplicate resume prompts across repeated resumes.
      while (out.length > 0) {
        const tail = out[out.length - 1]!;
        if (tail.role !== "assistant" || !isEmptyAssistant(tail)) break;
        out.pop();
      }
      const newLast = out[out.length - 1];
      if (!newLast || newLast.role === "assistant") {
        out.push({ role: "user", content: RESUME_PROMPT, timestamp: Date.now() });
        appendedResumePrompt = true;
      }
    }
  }
  // user/toolResult tails are directly continuable — nothing to do.
  return { messages: out, repaired, appendedResumePrompt };
}

export const RESUME_PROMPT = "The run was interrupted. Pick up exactly where you left off and finish the work.";

function isEmptyAssistant(m: TranscriptMessage): boolean {
  if (!Array.isArray(m.content)) return textOf(m.content).trim() === "";
  for (const block of m.content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return false;
    if (block.type === "toolCall") return false;
  }
  return true;
}
