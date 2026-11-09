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

/** One-line budget for a superseded step's tombstone. Enough to say what was
 * tried and what came back; the full bytes stay in the ledger. */
const TOMBSTONE_TEXT_CAP = 160;

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

/** Compact argument summary for a tombstone: just enough to recognize the
 * call that already happened, never the payload. */
function toolArgSummary(tool: string, params: Record<string, unknown>): string {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  switch (tool) {
    case "read": {
      const at = str(params.symbol)
        ? ` symbol ${params.symbol}`
        : typeof params.around === "number"
          ? ` around ${params.around}`
          : params.offset != null
            ? ` offset ${params.offset}`
            : "";
      return `${str(params.path)}${at}`.trim();
    }
    case "grep":
    case "search":
      return `"${str(params.pattern) || str(params.query)}" ${str(params.path) || str(params.paths) || ""}`.trim();
    case "map":
      return `${str(params.action)} ${str(params.pattern) || str(params.path) || ""}`.trim();
    case "glob":
      return str(params.pattern) || str(params.path) || "";
    case "edit":
    case "write":
      return str(params.path) || "";
    case "command":
      return str(params.name);
    case "context":
      return str(params.action);
    default:
      return JSON.stringify(params).slice(0, 80);
  }
}

function firstLine(text: string, maxChars: number): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  const clipped = line.trim().slice(0, maxChars);
  return line.trim().length > maxChars ? `${clipped}…` : clipped;
}

/** Collapse a superseded step to one line per tool call: what was tried and
 * the one-line outcome. Conclusions belong in memory facts, which are kept;
 * raw step output older than the working set does not help the next action.
 * Human answers (ask) are kept whole: short, high-signal, irreplaceable.
 * Copies messages; never mutates the stored transcript. */
function tombstoneStep(step: MessageLike[]): MessageLike[] {
  const calls = new Map<string, { tool: string; summary: string }>();
  for (const message of step) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const candidate = block as Record<string, unknown>;
      if (candidate?.type !== "toolCall" || typeof candidate.id !== "string" || typeof candidate.name !== "string") {
        continue;
      }
      calls.set(
        candidate.id,
        {
          tool: candidate.name,
          summary: toolArgSummary(candidate.name, (candidate.arguments ?? {}) as Record<string, unknown>),
        },
      );
    }
  }
  const out: MessageLike[] = [];
  for (const message of step) {
    // Assistant prose (thinking, conclusions) replays intact: the transcript
    // window is the only place reasoning survives, and prose is small next
    // to tool output. Argument payloads (whole files passed to write/edit)
    // do not replay: the call and its target are what matter.
    if (message.role === "assistant" && Array.isArray(message.content)) {
      out.push({
        ...message,
        content: message.content.map((block) => {
          const candidate = block as Record<string, unknown>;
          if (candidate?.type !== "toolCall" || typeof candidate.name !== "string") return block;
          return {
            ...candidate,
            arguments: {
              __replay: `${candidate.name} ${toolArgSummary(candidate.name, (candidate.arguments ?? {}) as Record<string, unknown>)}`.trim(),
            },
          };
        }),
      });
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const call = calls.get(message.toolCallId);
      if (call?.tool === "ask") {
        out.push(message);
        continue;
      }
      const texts = Array.isArray(message.content)
        ? (message.content as unknown[])
            .filter(
              (block): block is { type: string; text: string } =>
                !!block &&
                typeof block === "object" &&
                (block as Record<string, unknown>).type === "text" &&
                typeof (block as Record<string, unknown>).text === "string",
            )
            .map((block) => block.text)
        : [];
      const label = call ? `${call.tool}${call.summary ? ` ${call.summary}` : ""}`.trim() : "tool call";
      out.push({
        ...message,
        content: [
          { type: "text", text: `[earlier ${label} → ${firstLine(texts.join("\n"), TOMBSTONE_TEXT_CAP) || "(no output)"}]` },
        ],
      });
      continue;
    }
    out.push(message);
  }
  return out;
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

/** The most recent complete assistant/tool steps that fit the replay budget,
 * newest first. The oldest kept step is allowed to overflow so the model
 * always sees the turn it is answering. Steps (not flat messages) so the
 * caller can render the working set in full and tombstone the rest. */
function transcriptTail(
  messages: readonly MessageLike[],
  budgetChars = TRANSCRIPT_BUDGET_CHARS,
): MessageLike[][] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "assistant") starts.push(i);
  }
  if (starts.length === 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return [[messages[i]!]];
    }
    return [];
  }
  const picked: MessageLike[][] = [];
  let used = 0;
  for (let k = starts.length - 1; k >= 0; k -= 1) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : messages.length;
    if (!completeStep(messages, start, end)) continue;
    const step = messages.slice(start, end);
    const size = step.reduce((total, message) => total + messageChars(message), 0);
    if (picked.length > 0 && used + size > budgetChars) break;
    picked.unshift(step);
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
  // Fixed prompt section order (prompt-cache stable):
  //   system → assembled context → map index → tool guide → command index
  //     → working context → ledger tail → run state → transcript tail.
  // Stable content always renders before volatile per-turn content, so the
  // shared prefix stays byte-identical across turns and only the volatile
  // tail shifts — that is what keeps the provider prompt cache hot. Do not
  // reorder these sections or interleave volatile content into the stable
  // prefix without updating the prefix-stability test in test/context.test.js.
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
  // The newest step is the working set: replay it in full (capped per
  // block). Older steps collapse to one line per tool call — what was tried
  // and the one-line outcome — so the model stops paying full price for
  // evidence it already consumed. Conclusions live in memory facts regardless.
  const steps = transcriptTail(source, transcriptBudget);
  const step = steps.flatMap((entry, index) =>
    index === steps.length - 1 ? capStepText(entry) : tombstoneStep(entry),
  );
  const out = [
    ...(system ? [system] : []),
    user,
    ...step,
  ] as unknown as AgentMessage[];
  return { messages: out, chars: JSON.stringify(out).length };
}
