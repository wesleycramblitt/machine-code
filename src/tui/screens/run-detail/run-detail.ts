/**
 * machine_code — run detail screen.
 *
 * Pure render of one run across its sections (overview, timeline, changes,
 * processes, related, context). Derived data (pending question,
 * related runs, thinking chunks) is computed inside from the detail; the
 * caller supplies scroll/cursor state plus cached changes and receives
 * updated offsets back.
 */
import {
  B, BL, C, D, G, GR, M, PANEL_BG, PURPLE_BG, R, RED, W, WHITE, Y, SUBTAB_BG, ZEBRA_BG,
  ago, agentTone, background, command, contextTone, editSummaryLines, fit,
  fmtMoney, fmtRunTokens, fmtTokens, icon, joinCommands, printable,
  recentEditEvents, progress, selected, statusColor, stripAnsi, trunc, visible,
  wrapText, wrapTokenList,
} from "../../format.js";
import {
  describeTimelineEvent, describeToolArgs, describeToolBody, isTimelineEvent,
  waitingForRun, type TimelineEventLike,
} from "../../timeline.js";
import { scrollLines, selectableLines } from "../../scroll.js";
import { contextUsage, readContextManifest, relatedRuns, thinkingChunks, touchedPaths, type ThinkingChunk } from "../../../report/run.js";
import { latestUnansweredQuestion, readInbox } from "../../../state/question.js";
import { reconcileProcessRecords } from "../../../processes/reconcile.js";
import { readLogTail } from "../../../processes/logs.js";
import { CAPABILITY_AXES } from "../../../config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clipLines } from "../types.js";
import { RUN_SECTIONS, RUN_SECTION_LABEL, type RunDetailFrame, type RunDetailProps } from "./types.js";

/**
 * Full per-call prompts live in the run dir (prompts/call-NNN.txt), written
 * when the prompt exceeds the event-log cap. The timeline preview only ever
 * holds the head, so expanding an input loads the file lazily here instead
 * of on every 1s tick. Wrapped lines are cached per (file, width); prompt
 * files are immutable, so entries never go stale. Bounded to a few expanded
 * inputs to cap memory.
 */
const promptFileCache = new Map<string, string[]>();
function fullPromptLines(runDir: string, inputFile: string, cols: number): string[] | null {
  const abs = join(runDir, inputFile);
  if (!abs.startsWith(runDir) || !existsSync(abs)) return null;
  const key = `${abs}::${cols}`;
  const cached = promptFileCache.get(key);
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const wrapped of wrapText(line, Math.max(30, cols - 6))) out.push(wrapped);
  }
  promptFileCache.set(key, out);
  while (promptFileCache.size > 3) {
    const oldest = promptFileCache.keys().next();
    if (oldest.done) break;
    promptFileCache.delete(oldest.value);
  }
  return out;
}

/** One timeline call block: a model call or tool call grouped with its parts. */
interface TimelineGroup {
  kind: "model" | "tool" | "plain";
  /** First event index — also the block id used for expansion state. */
  first: number;
  /** Member event indices in event order; the block renders as one unit. */
  members: number[];
  /** Attempt counter when the block starts (thinkingByCall key prefix). */
  attempt: number;
  /** Call ordinal for display (1-based model-call number). */
  ordinal: number;
}

/** The tool call id, stringified; empty when the event carries none. */
const toolCallIdOf = (event: TimelineEventLike): string => {
  const id = (event as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" ? id : typeof id === "number" ? String(id) : "";
};

/**
 * Animated dots for live markers ("streaming…", "running…", "live"): the
 * 1s redraw tick advances the pattern, the same cadence as waitingDots.
 */
const streamDots = (): string => ".".repeat(1 + (Math.floor(Date.now() / 500) % 3));

/**
 * Group events into call blocks before rendering: a model call is its
 * select/request plus the matching model_call_end; a tool call is its start
 * plus the tool_call completion sharing its toolCallId. Pairing follows the
 * open-marker pattern of waitingForRun: a completion joins the most recent
 * unmatched start (same toolCallId when both carry one, nearest unmatched
 * start otherwise — resumed logs can drop ids). An unmatched completion
 * becomes a completed block of its own; an unmatched start stays open
 * (running). Everything else is a single-event block, and verbose mode makes
 * every event single so the raw per-event rows survive there.
 */
function groupTimelineCalls(ev: TimelineEventLike[], verbose: boolean): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let attempt = 0;
  let ordinal = 0;
  /** Open model blocks keyed `${attempt}:${call}`, closed by their call end. */
  const openModels = new Map<string, number>();
  /** Unmatched tool starts, in event order; completions consume one. */
  const openTools: Array<{ group: number; id: string; tool: string }> = [];
  for (let i = 0; i < ev.length; i++) {
    const event = ev[i]!;
    if (event.type === "model_select" && event.call === 0) attempt += 1;
    const type = String(event.type);
    // Streaming deltas render coalesced inside their call block.
    if (type === "model_delta" || !isTimelineEvent(event, verbose)) continue;
    const call = typeof event.call === "number" ? event.call : undefined;
    if (type === "model_select" || type === "model_request") {
      const key = `${attempt}:${call ?? "?"}`;
      const open = openModels.get(key);
      if (open !== undefined) {
        groups[open]!.members.push(i);
        continue;
      }
      openModels.set(key, groups.length);
      ordinal += 1;
      groups.push({ kind: "model", first: i, members: [i], attempt, ordinal });
    } else if (type === "model_call_end") {
      const key = `${attempt}:${call ?? "?"}`;
      const open = openModels.get(key);
      if (open !== undefined) {
        groups[open]!.members.push(i);
        openModels.delete(key);
      } else {
        // Resumed logs: the completion arrives without its request.
        ordinal += 1;
        groups.push({ kind: "model", first: i, members: [i], attempt, ordinal });
      }
    } else if (type === "tool_call_start") {
      openTools.push({
        group: groups.length,
        id: toolCallIdOf(event),
        tool: String(event.tool ?? ""),
      });
      groups.push({ kind: "tool", first: i, members: [i], attempt, ordinal });
    } else if (type === "tool_call") {
      const id = toolCallIdOf(event);
      const tool = String(event.tool ?? "");
      let pick = -1;
      if (id) {
        for (let k = openTools.length - 1; k >= 0; k--) {
          if (openTools[k]!.id === id) { pick = k; break; }
        }
      }
      if (pick < 0) {
        // No id to match (or the pair never met): nearest unmatched start,
        // preferring the same tool.
        for (let k = openTools.length - 1; k >= 0; k--) {
          if (openTools[k]!.tool === tool) { pick = k; break; }
        }
        if (pick < 0 && openTools.length > 0) pick = openTools.length - 1;
      }
      if (pick >= 0) {
        const match = openTools.splice(pick, 1)[0]!;
        groups[match.group]!.members.push(i);
      } else {
        groups.push({ kind: "tool", first: i, members: [i], attempt, ordinal });
      }
    } else {
      groups.push({ kind: "plain", first: i, members: [i], attempt, ordinal });
    }
  }
  return groups;
}

/**
 * One model call as a single block: exactly one timestamped header —
 * provider/model, stop reason, tokens and cost from model_call_end, or the
 * request's provider/model plus "streaming…" while the call is live — on a
 * full-width purple band behind a two-character ◉/◌ gutter, so a scan of
 * the timeline separates model calls from tool work without reading a
 * word. The request body and the response (output/thinking) indent under
 * the header; → marks request lines and ← marks response lines. The header
 * leads with the call ordinal ("Call 1", "Call 2", … — group.ordinal, so the
 * label holds across expansion/collapse), and an ended block closes with a
 * dim "· end Call N" line, so where one call stops and the next starts is
 * explicit even when both bands are purple. Expansion keeps the lazy
 * full-prompt-file behavior.
 */
function renderModelCallBlock(
  group: TimelineGroup,
  ev: TimelineEventLike[],
  opts: {
    eventLines: string[];
    cols: number;
    runDir: string;
    expandedEvent: boolean;
    compact: boolean;
    thinkingByCall: Map<string, ThinkingChunk[]>;
  },
): void {
  const { eventLines, cols, runDir, expandedEvent, compact, thinkingByCall } = opts;
  const members = group.members.map((index) => ev[index]!);
  const select = members.find((event) => String(event.type) === "model_select");
  const request = members.find((event) => String(event.type) === "model_request");
  const end = members.find((event) => String(event.type) === "model_call_end");
  const time = String(members[0]!.t ?? "").slice(11, 19);
  if (end) {
    const usage = (end.usage ?? {}) as { totalTokens?: number; input?: number; output?: number };
    // Header band: purple behind white names makes model calls readable in
    // a scan; tokens, cost, and stop reason keep their value tones.
    eventLines.push(
      background(
        fit(
          `${WHITE}◉ ${B}${WHITE}Call ${group.ordinal}${R} ${GR}${time}${R} ${B}${WHITE}${String(end.provider)}${R}/${B}${WHITE}${String(end.model)}${R} ${statusColor(String(end.stopReason))}${String(end.stopReason)}${R} ${G}${fmtTokens(Number(usage.totalTokens ?? 0))}${R}${D}tok${R} ${Y}${Number(end.cost ?? 0).toFixed(5)}${R}`,
          cols,
        ),
        PURPLE_BG,
      ),
    );
  } else if (select?.error) {
    eventLines.push(
      background(fit(`${WHITE}◉ ${B}${WHITE}Call ${group.ordinal}${R} ${GR}${time}${R} ${RED}select error ${String(select.error)}${R}`, cols), PURPLE_BG),
    );
  } else {
    // Live call: name what the model is about to answer.
    const provider = String(request?.provider ?? "");
    const model = String(request?.model ?? "");
    const name = provider || model ? `${provider}${provider && model ? "/" : ""}${model}` : "model";
    eventLines.push(
      background(fit(`${WHITE}◌ ${B}${WHITE}Call ${group.ordinal}${R} ${GR}${time}${R} ${B}${WHITE}${name}${R} ${Y}streaming…${streamDots()}${R}`, cols), PURPLE_BG),
    );
  }
  // Collapse policy: a compact (non-tail) past block shows its result
  // summary only — the header plus a one-line ok/ERR line — even when the
  // user did not expand it. The newest block stays open to unfold live.
  if (compact && !expandedEvent && end) {
    const usage = (end.usage ?? {}) as { input?: number; output?: number };
    const callChunks = typeof end.call === "number"
      ? (thinkingByCall.get(`${group.attempt}:${end.call}`) ?? [])
      : [];
    const textChunk = callChunks
      .filter((chunk) => chunk.kind === "text")
      .map((chunk) => chunk.text)
      .join("");
    const output = (
      typeof end.text === "string" && end.text.trim().length > 0
        ? end.text
        : textChunk
    ).trim();
    const first = output.split("\n").find((line) => line.trim().length > 0) ?? "";
    eventLines.push(
      `    ${end.isError ? RED : G}${end.isError ? "ERR" : "ok"}${R}` +
        (output ? ` ${D}${trunc(first, Math.max(20, cols - 10))}${R}` : "") +
        ` ${D}${usage.input ?? 0}→${usage.output ?? 0}${R}` +
        ` ${D}(space to expand)${R}`,
    );
    eventLines.push(`    ${D}· end Call ${group.ordinal}${R}`);
    return;
  }
  // Selection detail stays available under the block (expanded only).
  if (expandedEvent && select && Array.isArray(select.candidates)) {
    const estimate = (select.estimate ?? {}) as { inputTokens?: number; outputTokens?: number };
    eventLines.push(`    ${BL}select${R} ${C}${String(select.key)}${R} ${D}${select.estimate ? `${estimate.inputTokens ?? 0}+${estimate.outputTokens ?? 0} tok` : ""}${R}`);
    for (const candidate of select.candidates.slice(0, 4)) {
      const chosen = candidate.key === select.key ? `${C}✓${R}` : " ";
      eventLines.push(`    ${chosen} ${candidate.key} ${D}fit ${Number(candidate.fit ?? 0).toFixed(2)}${R}`);
    }
  }
  if (request) {
    const messages = Number(request.messages ?? 0);
    const chars = Number(request.chars ?? 0);
    const inputFile = typeof request.inputFile === "string" ? request.inputFile : "";
    eventLines.push(`    ${BL}→${R} ${D}request${R} ${D}${messages} msg · ${fmtTokens(chars)} chars${R}${inputFile ? ` ${D}full prompt in file${R}` : ""}`);
    // The event preview is head-only (log cap). When a full prompt file was
    // recorded, expanding loads the exact text the model saw; otherwise fall
    // back to the capped preview.
    const full = expandedEvent && inputFile ? fullPromptLines(runDir, inputFile, cols) : null;
    if (full !== null) {
      eventLines.push(`    ${D}… full prompt ${chars.toLocaleString()} chars · ${full.length.toLocaleString()} lines · j/k scrolls${R}`);
      for (const line of full) eventLines.push(`    ${D}${line}${R}`);
    } else {
      if (expandedEvent && inputFile) {
        eventLines.push(`    ${Y}full prompt file missing (${inputFile}); showing capped preview${R}`);
      }
      const input = typeof request.input === "string" ? request.input : "";
      if (input) {
        const inputLines = input.split("\n");
        while (inputLines.length > 0 && inputLines[inputLines.length - 1]!.trim() === "") inputLines.pop();
        // The head is the repeating system prompt; the tail is the unique
        // send for this call, so the preview shows the tail.
        const shown = expandedEvent ? inputLines : inputLines.slice(-4);
        if (!expandedEvent && inputLines.length > 4) {
          eventLines.push(`    ${D}… ${inputLines.length - 4} head lines hidden (space to expand${inputFile ? "; full prompt in file" : ""})${R}`);
        }
        for (const line of shown) {
          for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
        }
      }
    }
    // Live streaming view: while this call has no model_call_end yet, its
    // coalesced thinking/response text renders here as it arrives.
    const liveChunks = typeof request.call === "number"
      ? (thinkingByCall.get(`${group.attempt}:${request.call}`) ?? [])
      : [];
    for (const chunk of liveChunks) {
      if (chunk.complete) continue;
      const text = chunk.text.trim();
      if (!text) continue;
      const isThinking = chunk.kind === "thinking";
      eventLines.push(`    ${M}${isThinking ? "thinking" : "output"}${R}${Y} live${streamDots()}${R}`);
      for (const wrapped of wrapText(text, Math.max(30, cols - 6))) {
        eventLines.push(`    ${isThinking ? D : W}${wrapped}${R}`);
      }
    }
  }
  if (!end) return;
  // The response: final output plus thinking, keyed to this call.
  const callChunks = typeof end.call === "number"
    ? (thinkingByCall.get(`${group.attempt}:${end.call}`) ?? [])
    : [];
  const textChunk = callChunks
    .filter((chunk) => chunk.kind === "text")
    .map((chunk) => chunk.text)
    .join("");
  const output = (
    typeof end.text === "string" && end.text.trim().length > 0
      ? end.text
      : textChunk
  ).trim();
  if (output) {
    const outputLines = output.split("\n");
    const shown = expandedEvent ? outputLines : outputLines.slice(0, 4);
    const more =
      !expandedEvent && outputLines.length > shown.length
        ? ` ${D}(${outputLines.length - shown.length} more lines; space to expand)${R}`
        : "";
    eventLines.push(`    ${M}←${R} ${M}output${R}${more}`);
    for (const line of shown) {
      for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${W}${wrapped}${R}`);
    }
  }
  const reasoning = callChunks
    .filter((chunk) => chunk.kind === "thinking")
    .map((chunk) => chunk.text)
    .join("\n")
    .trim();
  if (reasoning) {
    const reasoningLines = reasoning.split("\n");
    const shown = expandedEvent ? reasoningLines : reasoningLines.slice(0, 4);
    const more =
      !expandedEvent && reasoningLines.length > shown.length
        ? ` ${D}(${reasoningLines.length - shown.length} more lines; space to expand)${R}`
        : "";
    eventLines.push(`    ${M}←${R} ${M}thinking${R}${more}`);
    for (const line of shown) {
      for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
    }
  }
  const usage = (end.usage ?? {}) as { input?: number; output?: number };
  if (expandedEvent) {
    eventLines.push(`    ${D}input ${usage.input ?? 0}  output ${usage.output ?? 0}${R}`);
  }
  // Close marker: makes the block boundary explicit even when the next
  // block opens with the same purple band.
  eventLines.push(`    ${D}· end Call ${group.ordinal}${R}`);
}

/**
 * Pull the human text out of a tool result: plain string, text-content
 * blocks, a `{ text }` object, or a JSON fallback for exotic shapes. Tool
 * results arrive as { content: [{ type: "text", text }] } from the loop.
 */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const parts = result
      .map((item) =>
        item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : undefined,
      )
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join("\n");
  }
  if (result !== null && typeof result === "object" && typeof (result as { text?: unknown }).text === "string") {
    return (result as { text: string }).text;
  }
  return JSON.stringify(result ?? "");
}

/** First lines of a body, with a note when lines were cut. */
function headLines(lines: string[], cap: number): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `… ${lines.length - cap} more lines`];
}

/** Last lines of a body, with a note when lines were cut (command output). */
function tailLines(lines: string[], cap: number): string[] {
  if (lines.length <= cap) return lines;
  return [`… ${lines.length - cap} earlier lines`, ...lines.slice(lines.length - cap)];
}

/**
 * Expanded result body, shaped per tool: the text body for read/inspect/
 * search/map/context/skill/artifact, a status line plus the output tail for
 * commands, what changed (path, wrote-N note, diff lines) for write/edit,
 * and the first lines for unknown tools. Errors surface the error message.
 * Callers sanitize (printable/stripAnsi) and wrap to the terminal width.
 */
function toolResultLines(
  tool: string,
  result: unknown,
  isError: boolean,
  args: Record<string, unknown> | undefined,
  completion: TimelineEventLike,
): string[] {
  const text = printable(stripAnsi(resultText(result))).trim();
  const lines = text ? text.split("\n").filter((line) => line.trim().length > 0) : [];
  if (isError) return lines.length > 0 ? lines : ["(error with no message)"];
  if (lines.length === 0) return ["(empty result)"];
  switch (tool) {
    case "command":
      return ["status: ok", ...tailLines(lines, 20)];
    case "read":
    case "inspect":
    case "search":
    case "map":
    case "context":
    case "skill":
    case "artifact":
      return headLines(lines, 24);
    case "write":
    case "edit": {
      const out: string[] = [];
      if (args && typeof args.path === "string") out.push(`changed: ${args.path}`);
      const content = args && typeof args.content === "string" ? args.content : undefined;
      if (content) {
        out.push(`wrote ${content.split("\n").length} lines · ${fmtTokens(Buffer.byteLength(content, "utf8"))} chars`);
      }
      const diff = editSummaryLines(completion, 160, 20).slice(1);
      return [...out, ...diff.slice(0, Math.max(0, 24 - out.length))];
    }
    default:
      return headLines(lines, 12);
  }
}

/**
 * One tool call as a single block: exactly one timestamped header naming the
 * tool and its outcome (ok/ERR, duration; "running…" while the completion is
 * missing) on a full-width charcoal band behind a two-character gutter icon
 * (✎ edits, ⚡ everything else), so tool work reads apart from model calls.
 * The request as a "→ request" line (human args; the full key: value body
 * when expanded), and the response as a "← response" body shaped per tool —
 * the edit diff, the result text for read/search and friends, the error
 * message in red on failure.
 */
function renderToolCallBlock(
  start: TimelineEventLike,
  completion: TimelineEventLike | undefined,
  opts: { eventLines: string[]; cols: number; expandedEvent: boolean; compact: boolean },
): void {
  const { eventLines, cols, expandedEvent, compact } = opts;
  const time = String(start.t ?? "").slice(11, 19);
  const tool = String(start.tool ?? "");
  const isEdit = tool === "write" || tool === "edit";
  const args = (start.args ?? (start as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
  const human = describeToolArgs(tool, args ?? undefined);
  const running = completion === undefined;
  // Header band: charcoal keeps tool work readable apart from purple model
  // calls; name, outcome, and duration keep their tones.
  eventLines.push(
    background(
      fit(
        `${!running && isEdit ? `${G}✎ ` : `${Y}⚡ `}${GR}${time}${R} ${B}${W}${tool}${R}` +
          (running
            ? ` ${Y}running…${streamDots()}${R}`
            : ` ${completion!.isError ? `${RED}ERR${R}` : `${G}ok${R}`}${typeof completion!.durationMs === "number" ? ` ${D}${completion!.durationMs}ms${R}` : ""}`),
        cols,
      ),
      PANEL_BG,
    ),
  );
  // Collapse policy: a compact (non-tail) past block shows its result
  // summary only — the header plus a one-line ok/ERR line. The request line
  // and diff are elided so a long run scans as one header per call.
  if (compact && !expandedEvent && completion && !running) {
    const isError = !!completion.isError;
    const all = printable(stripAnsi(resultText(completion.result))).split("\n").filter((line) => line.trim().length > 0);
    const first = all[0] ?? "";
    eventLines.push(
      `    ${isError ? RED : G}${isError ? "ERR" : "ok"}${R}` +
        (first ? ` ${D}${trunc(first, Math.max(20, cols - 10))}${R}` : "") +
        ` ${D}(space to expand)${R}`,
    );
    return;
  }
  // The request: one-line human args by default; key: value body expanded.
  eventLines.push(`    ${Y}→${R} ${D}request${R}${human ? ` ${W}${trunc(human, Math.max(12, cols - 8))}${R}` : ""}`);
  if (expandedEvent && args) {
    for (const raw of describeToolBody(tool, args)) {
      for (const wrapped of wrapText(printable(stripAnsi(raw)), Math.max(20, cols - 8))) {
        eventLines.push(`      ${D}${wrapped}${R}`);
      }
    }
  }
  if (running) return;
  const result = completion!.result;
  const showDiff = isEdit && !expandedEvent;
  const showResult = result !== undefined && (expandedEvent || !isEdit);
  if (!showDiff && !showResult) return;
  eventLines.push(`    ${completion!.isError ? RED : G}←${R} ${D}response${R}`);
  if (showDiff) {
    // The diff is the meat of an edit; the raw result ("ok") is not.
    for (const line of editSummaryLines(completion!, cols - 6, 5).slice(1)) {
      const tone = line.startsWith("+") ? G : line.startsWith("-") ? RED : D;
      eventLines.push(`    ${tone}${trunc(line, Math.max(16, cols - 8))}${R}`);
    }
  }
  if (showResult) {
    const isError = !!completion!.isError;
    const all = printable(stripAnsi(resultText(result))).split("\n").filter((line) => line.trim().length > 0);
    if (expandedEvent) {
      // Full body shaped per tool; errors read as errors in RED.
      for (const raw of toolResultLines(tool, result, isError, args, completion!)) {
        const tone = isError ? RED : isEdit && raw.startsWith("+") ? G : isEdit && raw.startsWith("-") ? RED : D;
        for (const wrapped of wrapText(printable(stripAnsi(raw)), Math.max(20, cols - 8))) {
          eventLines.push(`      ${tone}${wrapped}${R}`);
        }
      }
    } else {
      for (const line of all.slice(0, 3)) eventLines.push(`      ${trunc(line, Math.max(20, cols - 8))}`);
      if (all.length > 3) eventLines.push(`      ${D}… (${all.length - 3} more; space to expand)${R}`);
    }
  }
}

export function renderRunDetail(props: RunDetailProps): RunDetailFrame {
  const { cols, short, bodyH, theme } = props;
  const detail = props.detail;
  const section = props.section;
  let runScroll = props.runScroll;
  let processSel = props.processSel;
  const processFollow = props.processFollow;
  let eventSel = props.eventSel;
  let eventCursor = props.eventCursor;
  const timelineFollow = props.timelineFollow;
  const timelineVerbose = props.timelineVerbose;
  let childSel = props.childSel;
  let changeSel = props.changeSel;
  let changeOpen = props.changeOpen;
  const expanded = props.expanded;
  let runCwd = "";
  let runHints = "";
  let footerMapTokens: string[] = [];
  let footerCtx = "";
  let body: string[] = [];

  
    const s = detail.summary;
    const ev = detail.events;
    const pending = latestUnansweredQuestion(
      ev.filter((event) => event.type === "question") as Array<{ questionId?: string; text?: string }>,
      readInbox(detail.dir),
    );
    const context = readContextManifest(detail.dir);
    // Related runs honor the repo scope: the panel must not resurrect
    // rows the list hides when the human filtered to the cwd. The Enter
    // handler below selects from the same scoped list, so navigation and
    // rendering agree.
    const relatedList = relatedRuns(props.scopedRuns, s);
    const thinking = thinkingChunks(ev);
    const recentActivity = ev.filter((event) => isTimelineEvent(event, false)).slice(-8);
    // What the run is currently waiting on. The 1s redraw tick animates
    // the dots, so a live wait visibly advances instead of looking frozen.
    const waiting = waitingForRun(s, ev, { hasPendingQuestion: Boolean(pending) });
    const waitingDots = ".".repeat(1 + (Math.floor(Date.now() / 500) % 3));
    const waitingLine = (): string | null => {
      if (!waiting) return null;
      const elapsed = ago(waiting.since);
      const age = elapsed === "—" ? "" : ` ${D}(${elapsed})${R}`;
      const label = trunc(waiting.label, Math.max(12, cols - 32));
      switch (waiting.kind) {
        case "input":
          return ` ${Y}?${R} ${B}awaiting your answer${R} ${D}press ${B}${Y}a${R}${D} to reply${R}`;
        case "paused":
          return ` ${Y}⏸${R} ${B}${waiting.label}${R}${age}`;
        case "model":
          return ` ${BL}◌${R} ${B}waiting on ${label}${R}${waiting.streaming ? ` ${G}streaming${R}` : ""}${C}${waitingDots}${R}${age}`;
        case "tool":
          return ` ${Y}◌${R} ${B}waiting on ${label}${R}${Y}${waitingDots}${R}${age}`;
        case "process":
          return ` ${C}◌${R} ${B}waiting on ${label}${R}${C}${waitingDots}${R}${age}`;
        case "child":
          return ` ${M}◌${R} ${B}waiting on ${label}${R}${M}${waitingDots}${R}${age}`;
        case "starting":
          // Prolonged "starting" with no progress is a stuck handoff: the
          // worktree / supervisor / orchestrator never advanced past the
          // created state. After a configurable window, name it actionable.
          return ` ${C}◌${R} ${B}starting${R}${C}${waitingDots}${R}${age}`;
        case "failed":
          return ` ${R}✗${R} ${R}${B}${waiting.label}${R}${age} ${D}view logs: ${B}logs${R}${D} / retry: ${B}retry${R}${D} / cancel: ${B}cancel${R}`;
        case "working":
          return ` ${C}◌${R} ${B}working${R}${C}${waitingDots}${R}${age}`;
      }
    };
    const thinkingByCall = new Map<string, ThinkingChunk[]>();
    for (const chunk of thinking) {
      if (typeof chunk.call !== "number") continue;
      const key = `${chunk.attempt ?? 0}:${chunk.call}`;
      const list = thinkingByCall.get(key) ?? [];
      list.push(chunk);
      thinkingByCall.set(key, list);
    }
    const touched = touchedPaths(ev);
    runCwd = `${s.worktree ?? s.repoRoot}  ${s.worktree ? "worktree" : "read-only"}`;
    const hint = (key: string, label: string, tone = M): string =>
      `${B}${tone}${key}${R} ${D}${label}${R}`;
    runHints = joinCommands([
      command("f", "fork", undefined, Y),
      ...(["blocked", "failed", "interrupted", "paused"].includes(s.status)
        ? [command("r", "resume", undefined, G)]
        : []),
      hint("D", "delete", RED),
      ...(pending ? [hint("a", "answer", Y)] : []),
      ...(["running", "awaiting_input", "paused"].includes(s.status)
        ? [hint("i", s.status === "running" ? "interrupt" : "cancel", RED)]
        : []),
      ...(section === "timeline"
        ? [
            hint("j/k", "move", Y),
            hint("space", "expand", G),
            hint("F", `follow ${timelineFollow ? "ON" : "OFF"}`, Y),
            hint("v", timelineVerbose ? "all" : "key events"),
          ]
        : section === "processes"
          ? [
              hint("j/k", "select"),
              hint("^D/^U", "page", Y),
              hint("F", "follow", Y),
              hint("o", "log", G),
              hint("x", "kill", RED),
              hint("X", "kill all", RED),
            ]
          : section === "overview" || section === "context"
            ? [hint("j/k", "scroll")]
            : section === "changes"
              ? [
                  hint("j/k", "select"),
                  hint("enter", changeOpen === null ? "open diff" : "close diff", G),
                  hint("^D/^U", "page", Y),
                ]
              : section === "related"
                ? [hint("j/k", "select"), hint("^D/^U", "page", Y)]
                : []),
    ]);
    // Index health is about the repo the user operates, not the run's
    // ephemeral worktree (which never carries a map cache, so this always
    // read MAP✗ MOD- and implied something was broken).
    footerMapTokens = props.mapTokens(s.repoRoot);
    const sectionBar = wrapTokenList(
      RUN_SECTIONS.map((entry) =>
        entry === section
          ? `${theme.sectionActiveBg}${theme.sectionActiveFg}${B} ${RUN_SECTION_LABEL[entry]} ${R}`
          : `${SUBTAB_BG}${theme.sectionFg} ${RUN_SECTION_LABEL[entry]} ${R}`,
      ),
      cols - 2,
      "  ",
    ).map((line) => background(fit(` ${line}`, cols), theme.sectionBg));
    const ctxUsage = contextUsage(s.usage, ev);
    const timeLabel = s.endedAt ? `ended ${ago(s.endedAt)} ago` : `updated ${ago(s.lastActivityAt)} ago`;
    const lines: string[] = [
      ` ${icon(s.status)} ${B}${BL}${s.id}${R}  ${statusColor(s.status)}${s.status.toUpperCase()}${R}  ${agentTone(s.agent)}${s.agent}${R}  ${G}${s.modelCalls}${R} call(s)  ${Y}${fmtMoney(s.cost.actual)}${R}  ${D}${timeLabel}${R}`,
      ` ${M}${fmtRunTokens(s.usage.totalTokens)}${R}${D} total${R}`,
    ];
    footerCtx = `${C}ctx${R} ${W}${fmtRunTokens(ctxUsage.tokens)}${R}`;
    const itemId = s.itemId ?? s.packetId;
    const prMeta = [itemId ? `${itemId}` : "", s.prNumber ? `PR #${s.prNumber} ${s.prState ?? ""}` : ""]
      .filter(Boolean)
      .join("  ");
    if (prMeta) lines.push(` ${D}${prMeta}${R}`);
    const wl = waitingLine();
    if (wl) lines.push(wl);
    lines.push("", ...sectionBar, "");
    if (section === "overview") {
      // Lean overview: header already carries status/agent/cost. Show the
      // outcome plus one snippet per detail section (thinking, activity,
      // changes) instead of duplicating their full bodies.
      if (s.error || s.status === "failed" || s.status === "blocked") {
        lines.push(` ${B}${W}Status${R}`);
        const statusLabel = `[${s.status.toUpperCase()}]`;
        const statusText = s.error ? `${statusLabel} ${s.error}` : statusLabel;
        const statusTone = RED;
        for (const line of wrapText(statusText, cols - 4).slice(0, short ? 3 : 6)) {
          lines.push(`  ${statusTone}${line}${R}`);
        }
      }
      if (pending?.text) lines.push(` ${Y}? ASK${R} ${W}${trunc(pending.text, cols - 8)}${R}`);
      lines.push(` ${B}${BL}Request${R}`);
      for (const line of wrapText(s.request, cols - 4).slice(0, 10)) lines.push(`  ${D}${line}${R}`);
      const lastThinking = thinking.length > 0 ? thinking[thinking.length - 1] : undefined;
      if (lastThinking) {
        lines.push("", ` ${B}${Y}Thinking snippet${R} ${D}latest · full text in Timeline${R}`);
        for (const line of wrapText(lastThinking.text, cols - 4).slice(-10)) lines.push(`  ${D}${line}${R}`);
      }
      if (recentActivity.length) {
        const activityLive =
          waiting && waiting.kind !== "input" && waiting.kind !== "paused"
            ? ` ${C}◌ waiting on ${trunc(waiting.label, Math.max(12, cols - 48))}${waitingDots}${R}`
            : s.status === "running"
              ? ` ${G}live${R}`
              : "";
        lines.push("", ` ${B}${C}Activity snippet${R}${activityLive} ${D}full log in Timeline${R}`);
        for (const event of recentActivity.slice(-10)) {
          const time = String(event.t ?? "").slice(11, 19);
          lines.push(`  ${D}${time}${R} ${D}${trunc(describeTimelineEvent(event), Math.max(12, cols - 12))}${R}`);
        }
      }
      if (touched.length) {
        lines.push("", ` ${B}${G}Changes${R}`);
        for (const path of touched) lines.push(`  ${G}✎${R} ${W}${path}${R}`);
      } else {
        lines.push("", ` ${B}${G}Changes${R} ${D}none yet${R}`);
      }
      if (relatedList.length) {
        lines.push(`  ${D}related${R}  ${M}${relatedList.length}${R}`);
      }
      if (s.parentRunId) {
        lines.push(`  ${D}parent${R}  ${D}${s.parentRunId.slice(-8)}${R}`);
      }
      if (context) {
        lines.push(`  ${D}context${R} ${C}${context.chars.toLocaleString()} chars / ${context.sources.length} sources${R}`);
      }
      const w = scrollLines(lines, runScroll, bodyH);
      runScroll = w.scroll;
      body = clipLines(w.lines, bodyH);
    } else if (section === "timeline") {
      const eventLines: string[] = [];
      /**
       * Rendered line span per call block, for cursor mapping and zebra:
       * band is the header line (kept free of stripes), expanded marks
       * bodies that read as one canvas. Blank separators join no span.
       */
      const spans: Array<{ start: number; end: number; rep: number; band: number; expanded: boolean }> = [];
      // One block per call: a model call carries its select/request/end as a
      // unit, a tool call its start/completion. Plain blocks fall through to
      // the per-event renderer below; verbose mode makes every block plain,
      // so "v" keeps the raw rows.
      const groups = groupTimelineCalls(ev, timelineVerbose);
      // The newest call block (last model or tool group) is the live tail:
      // it renders its full body by default so output unfolds as it arrives.
      // Collapse is derived at render time from the expanded set, never
      // stored, so each older block auto-collapses once a new one starts.
      let tailGroup = -1;
      if (!timelineVerbose) {
        for (let gi = groups.length - 1; gi >= 0; gi--) {
          const k = groups[gi]!.kind;
          if (k === "model" || k === "tool") { tailGroup = gi; break; }
        }
      }
      const compact = !timelineVerbose;
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi]!;
        // Rhythm: exactly one blank line between blocks, none inside. The
        // separator sits outside every span, so stripes and cursor mapping
        // skip it.
        if (gi > 0) eventLines.push("");
        const start = eventLines.length;
        const event = ev[group.first]!;
        const prefix = " ";
        const time = String(event.t ?? "").slice(11, 19);
        // The cursor can rest on any rendered line (header or body); space
        // toggles the containing block's expansion. Block ids reuse the
        // block's first event index, so existing expanded sets keep working.
        // For the tail the set is inverted: present means the user collapsed
        // the live block, absent means it stays open.
        const userExpanded = expanded.has(`${s.id}:${group.first}`);
        const isTail = gi === tailGroup;
        const expandedEvent = isTail ? !userExpanded : userExpanded;
        const type = String(event.type);
        if (group.kind === "model") {
          renderModelCallBlock(group, ev, { eventLines, cols, runDir: detail.dir, expandedEvent, compact, thinkingByCall });
          spans.push({ start, end: eventLines.length, rep: group.first, band: start, expanded: expandedEvent });
          continue;
        }
        if (group.kind === "tool") {
          const completion = group.members.length > 1 ? ev[group.members[1]!] : undefined;
          renderToolCallBlock(event, completion, { eventLines, cols, expandedEvent, compact });
          spans.push({ start, end: eventLines.length, rep: group.first, band: start, expanded: expandedEvent });
          continue;
        }
        if (type === "run_start") eventLines.push(`${prefix} ${GR}${time}${R} ${C}▶ start${R} ${agentTone(String(event.agent))}${event.agent}${R}`);
        else if (type === "model_select") {
          if (event.error) eventLines.push(`${prefix} ${GR}${time}${R} ${RED}select error ${String(event.error)}${R}`);
          else {
            const estimate = (event.estimate ?? {}) as { inputTokens?: number; outputTokens?: number };
            eventLines.push(`${prefix} ${GR}${time}${R} ${BL}select${R} ${C}${String(event.key)}${R} ${D}${event.estimate ? `${estimate.inputTokens ?? 0}+${estimate.outputTokens ?? 0} tok` : ""}${R}`);
            if (expandedEvent && Array.isArray(event.candidates)) {
              for (const candidate of event.candidates.slice(0, 4)) {
                const chosen = candidate.key === event.key ? `${C}✓${R}` : " ";
                eventLines.push(`    ${chosen} ${candidate.key} ${D}fit ${Number(candidate.fit ?? 0).toFixed(2)}${R}`);
              }
            }
          }
        } else if (type === "model_request") {
          const messages = Number(event.messages ?? 0);
          const chars = Number(event.chars ?? 0);
          const inputFile = typeof event.inputFile === "string" ? event.inputFile : "";
          eventLines.push(`${prefix} ${GR}${time}${R} ${BL}input${R} ${D}${messages} msg · ${fmtTokens(chars)} chars${R}${inputFile ? ` ${D}full prompt in file${R}` : ""}`);
          // The event preview is head-only (log cap). When a full prompt file
          // was recorded, expanding loads the exact text the model saw;
          // otherwise fall back to the capped preview.
          const full = expandedEvent && inputFile ? fullPromptLines(detail.dir, inputFile, cols) : null;
          if (full !== null) {
            eventLines.push(`    ${D}… full prompt ${chars.toLocaleString()} chars · ${full.length.toLocaleString()} lines · j/k scrolls${R}`);
            for (const line of full) eventLines.push(`    ${D}${line}${R}`);
          } else {
            if (expandedEvent && inputFile) {
              eventLines.push(`    ${Y}full prompt file missing (${inputFile}); showing capped preview${R}`);
            }
            const input = typeof event.input === "string" ? event.input : "";
            if (input) {
              const inputLines = input.split("\n");
              while (inputLines.length > 0 && inputLines[inputLines.length - 1]!.trim() === "") inputLines.pop();
              // The head is the repeating system prompt; the tail is the
              // unique send for this call, so the preview shows the tail.
              const shown = expandedEvent ? inputLines : inputLines.slice(-4);
              if (!expandedEvent && inputLines.length > 4) {
                eventLines.push(`    ${D}… ${inputLines.length - 4} head lines hidden (space to expand${inputFile ? "; full prompt in file" : ""})${R}`);
              }
              for (const line of shown) {
                for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
              }
            }
          }
          // Live streaming view: while this call has no model_call_end yet,
          // its coalesced thinking/response text renders here as it arrives —
          // the old Thinking tab's live view, now inside the timeline.
          const openCallChunks = typeof event.call === "number"
            ? (thinkingByCall.get(`${group.attempt}:${event.call}`) ?? [])
            : [];
          for (const chunk of openCallChunks) {
            if (chunk.complete) continue;
            const text = chunk.text.trim();
            if (!text) continue;
            const isThinking = chunk.kind === "thinking";
            eventLines.push(`    ${M}${isThinking ? "thinking" : "output"}${R}${Y} live${streamDots()}${R}`);
            for (const wrapped of wrapText(text, Math.max(30, cols - 6))) {
              eventLines.push(`    ${isThinking ? D : W}${wrapped}${R}`);
            }
          }
        } else if (type === "model_call_end") {
          const usage = (event.usage ?? {}) as { totalTokens?: number; input?: number; output?: number };
          eventLines.push(`${prefix} ${GR}${time}${R} ${M}◉${R} ${W}${String(event.provider)}${R}/${String(event.model)} ${statusColor(String(event.stopReason))}${String(event.stopReason)}${R} ${G}${fmtTokens(Number(usage.totalTokens ?? 0))}${R}tok ${Y}$${Number(event.cost ?? 0).toFixed(5)}${R}`);
          const callChunks =
            typeof event.call === "number"
              ? (thinkingByCall.get(`${group.attempt}:${event.call}`) ?? [])
              : [];
          const textChunk = callChunks
            .filter((chunk) => chunk.kind === "text")
            .map((chunk) => chunk.text)
            .join("");
          const output = (
            typeof event.text === "string" && event.text.trim().length > 0
              ? event.text
              : textChunk
          ).trim();
          if (output) {
            const outputLines = output.split("\n");
            const shown = expandedEvent ? outputLines : outputLines.slice(0, 4);
            const more =
              !expandedEvent && outputLines.length > shown.length
                ? ` ${D}(${outputLines.length - shown.length} more lines; space to expand)${R}`
                : "";
            eventLines.push(`    ${M}output${R}${more}`);
            for (const line of shown) {
              for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${W}${wrapped}${R}`);
            }
          }
          const reasoning = callChunks
            .filter((chunk) => chunk.kind === "thinking")
            .map((chunk) => chunk.text)
            .join("\n")
            .trim();
          if (reasoning) {
            const reasoningLines = reasoning.split("\n");
            const shown = expandedEvent ? reasoningLines : reasoningLines.slice(0, 4);
            const more =
              !expandedEvent && reasoningLines.length > shown.length
                ? ` ${D}(${reasoningLines.length - shown.length} more lines; space to expand)${R}`
                : "";
            eventLines.push(`    ${M}thinking${R}${more}`);
            for (const line of shown) {
              for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
            }
          }
          if (expandedEvent) {
            eventLines.push(`    ${D}input ${usage.input ?? 0}  output ${usage.output ?? 0}${R}`);
          }
        } else if (type === "model_delta") {
          // Streaming deltas render coalesced under the call's input row
          // (live view); showing each raw chunk here splits the response
          // into unreadable fragments.
        } else if (type === "tool_call_start") {
          const startArgs = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
          const human = describeToolArgs(String(event.tool ?? ""), startArgs ?? undefined);
          eventLines.push(`${prefix} ${GR}${time}${R} ${Y}⚡${R} ${B}${String(event.tool)}${R}${human ? ` ${D}${trunc(human, Math.max(12, cols - 24))}${R}` : ` ${D}calling…${R}`}`);
          if (expandedEvent && event.args) {
            const argsText = stripAnsi(JSON.stringify(event.args));
            for (const line of wrapText(argsText, cols - 6)) eventLines.push(`    ${D}${line}${R}`);
          }
        } else if (type === "tool_call") {
          const toolName = String(event.tool ?? "");
          const isEdit = toolName === "write" || toolName === "edit";
          const callArgs = (event.args ?? (event as { call?: { args?: unknown } }).call?.args) as Record<string, unknown> | undefined;
          const human = describeToolArgs(toolName, callArgs);
          eventLines.push(`${prefix} ${GR}${time}${R} ${isEdit ? `${G}✎${R}` : `${Y}⚡${R}`} ${B}${toolName}${R} ${event.isError ? `${RED}ERR${R}` : `${G}ok${R}`}${typeof event.durationMs === "number" ? ` ${D}${event.durationMs}ms${R}` : ""}${human ? ` ${D}${trunc(human, Math.max(12, cols - 32))}${R}` : ""}`);
          if (expandedEvent && callArgs) {
            for (const line of wrapText(JSON.stringify(callArgs), cols - 6)) eventLines.push(`    ${D}${line}${R}`);
          }
          if (isEdit && !expandedEvent) {
            // The diff is the meat of an edit; the raw result ("ok") is not.
            for (const line of editSummaryLines(event, cols - 6, 5).slice(1)) {
              const tone = line.startsWith("+") ? G : line.startsWith("-") ? RED : D;
              eventLines.push(`    ${tone}${trunc(line, Math.max(16, cols - 8))}${R}`);
            }
          }
          const result = event.result;
          if (result !== undefined && (expandedEvent || !isEdit)) {
            const text = stripAnsi(typeof result === "string" ? result : JSON.stringify(result));
            if (expandedEvent) {
              for (const line of text.split("\n")) {
                for (const wrapped of wrapText(line, cols - 6)) eventLines.push(`    ${G}→${R} ${wrapped}`);
              }
            } else {
              const preview = text.split("\n").filter((line) => line.trim().length > 0).slice(0, 3);
              for (const line of preview) eventLines.push(`    ${G}→${R} ${trunc(line, Math.max(20, cols - 8))}`);
              if (text.split("\n").length > 3) eventLines.push(`    ${D}… (${text.split("\n").length - 3} more; space to expand)${R}`);
            }
          }
        } else if (type === "gates") {
          const results = Array.isArray(event.results) ? (event.results as Array<{ passed?: boolean; command?: string }>) : [];
          eventLines.push(`${prefix} ${GR}${time}${R} ${B}⊞ gates${R} ${event.passed ? `${G}PASS${R}` : `${RED}FAIL${R}`}`);
          if (!expandedEvent && !event.passed) {
            // A failing gate's command is the actionable part.
            for (const gate of results.filter((gate) => !gate.passed).slice(0, 2)) {
              eventLines.push(`    ${RED}✗${R} ${trunc(String(gate.command ?? ""), Math.max(16, cols - 10))}`);
            }
          }
          if (expandedEvent && Array.isArray(event.results)) {
            for (const gate of results) eventLines.push(`    ${gate.passed ? `${G}✓` : `${RED}✗`}${R} ${gate.command}`);
          }
        } else if (type === "error_classified") {
          const msg = String(event.message ?? "");
          eventLines.push(`${prefix} ${GR}${time}${R} ${RED}⚠ ${String(event.kind)}${R}${msg ? ` ${D}${trunc(msg, Math.max(20, cols - 30))}${R}` : ""}`);
        }
        else if (type === "malformed_tool_call") eventLines.push(`${prefix} ${GR}${time}${R} ${RED}⚠ malformed tool call${R} ${D}${String(event.model ?? "")}${R}`);
        else if (type === "retry") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}↻ retry${R} ${D}${String(event.failedModel)}${R}`);
        else if (type === "control") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}⌘ ${String(event.action)}${R}`);
        else if (type === "run_end") eventLines.push(`${prefix} ${GR}${time}${R} ${statusColor(String(event.status))}■ ${String(event.status).toUpperCase()}${R}`);
        else if (type === "child_spawned") eventLines.push(`${prefix} ${GR}${time}${R} ${M}↳ child${R} ${C}${String(event.childRunId ?? "").slice(-8)}${R} ${agentTone(String(event.role ?? ""))}${String(event.role ?? "")}${R}`);
        else if (type === "child_completed") eventLines.push(`${prefix} ${GR}${time}${R} ${M}↲ child done${R} ${C}${String(event.childRunId ?? "").slice(-8)}${R} ${String(event.status ?? "")}`);
        else if (type === "run_summary") eventLines.push(`${prefix} ${GR}${time}${R} ${B}${G}summary${R} ${D}${String(event.headline ?? event.stopReason ?? "")}${R}`);
        else if (type === "turn_cap") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}turn cap${R} ${D}${String(event.turns ?? "")} turns${R}`);
        else if (type === "budget_exhausted") eventLines.push(`${prefix} ${GR}${time}${R} ${Y}budget exhausted${R} ${D}${String(event.totalTokens ?? "")} tok${R}`);
        else if (type === "loop_blocked") {
          const reason =
            event.reason === "no-progress"
              ? `no progress after ${String(event.noProgressCalls ?? "?")} research call(s)`
              : event.reason === "next-required"
                ? "no next action recorded"
                : event.reason === "plan-required"
                  ? "no concrete build plan recorded"
                  : String(event.tool ?? "");
          eventLines.push(`${prefix} ${GR}${time}${R} ${RED}loop blocked${R} ${D}${reason}${R}`);
        }
        else if (type === "context_assembled") eventLines.push(`${prefix} ${GR}${time}${R} ${BL}context${R} ${D}${fmtTokens(Number(event.chars ?? 0))} chars${R}`);
        else eventLines.push(`${prefix} ${GR}${time}${R} ${D}${type}${R}`);
      }
      if (eventLines.length === 0) {
        lines.push(` ${D}(no timeline events yet)${R}`);
        body = clipLines(lines, bodyH);
      } else {
        eventSel = Math.max(0, Math.min(eventSel, eventLines.length - 1));
        // Follow: pin the cursor to the newest rendered line.
        if (timelineFollow) eventSel = eventLines.length - 1;
        // Which block contains the cursor line: eventCursor maps back to the
        // block's first event, so space/enter toggle the whole call block.
        eventCursor = -1;
        for (const span of spans) {
          if (eventSel >= span.start && eventSel < span.end) {
            eventCursor = span.rep;
            break;
          }
        }
        // Zebra stripes across every other block. Header bands keep their
        // own paint (a stripe would erase it), expanded bodies read as one
        // canvas, and the cursor row wins (selected applies after this).
        for (let g = 0; g < spans.length; g++) {
          const span = spans[g]!;
          if (g % 2 === 0 || span.expanded) continue;
          for (let line = span.start; line < span.end; line++) {
            if (line === eventSel || line === span.band) continue;
            eventLines[line] = background(fit(eventLines[line]!, cols), ZEBRA_BG);
          }
        }
        // Color-coded cursor row, wherever it rests (header or body line).
        eventLines[eventSel] = selected(fit(eventLines[eventSel]!, cols), true);
        const timeWait =
          waiting && timelineFollow && waiting.kind !== "input" && waiting.kind !== "paused" ? waitingLine() : null;
        const visibleCount = Math.max(1, bodyH - 4 - (timeWait ? 1 : 0));
        const view = selectableLines(eventLines, eventSel, eventSel, visibleCount);
        lines.push(...view.lines);
        if (timeWait) lines.push(timeWait);
        body = clipLines(lines, bodyH);
      }
    } else if (section === "changes") {
      const changes = props.changes;
      const files = changes.files;
      // A stale file index (the list changed since the last draw) falls back
      // to the list view instead of rendering an out-of-range selection.
      if (changeOpen !== null && (changeOpen < 0 || changeOpen >= files.length)) changeOpen = null;
      lines.push(` ${B}${C}Worktree${R} ${D}${s.worktree ?? "(none)"}${R}`);
      if (changes.error) lines.push(` ${Y}${changes.error}${R}`);
      if (changeOpen === null) {
        if (changes.status) for (const line of changes.status.split("\n").slice(0, Math.max(3, bodyH - 12))) lines.push(`  ${W}${line}${R}`);
        // One row per changed file: porcelain code, path, and +/- line counts
        // parsed from that file's diff. Enter opens the full diff below.
        if (files.length > 0) {
          lines.push("", ` ${B}${C}Changed files${R}`);
          changeSel = Math.max(0, Math.min(changeSel, files.length - 1));
          for (let i = 0; i < files.length; i++) {
            const file = files[i]!;
            let adds = 0;
            let dels = 0;
            for (const line of file.diff.split("\n")) {
              if (line.startsWith("+") && !line.startsWith("+++")) adds += 1;
              else if (line.startsWith("-") && !line.startsWith("---")) dels += 1;
            }
            const row = `  ${file.code} ${W}${trunc(file.path, Math.max(20, cols - 18))}${R} ${G}+${adds}${R}${RED}-${dels}${R}`;
            lines.push(selected(row, i === changeSel));
          }
        }
        if (changes.diffStat) {
          lines.push("", ` ${B}${C}Diffstat${R}`);
          for (const line of changes.diffStat.split("\n").slice(0, Math.max(2, bodyH - 18))) lines.push(`  ${D}${line}${R}`);
        }
        if (changes.recent) {
          lines.push("", ` ${B}${C}Recent commits${R}`);
          for (const line of changes.recent.split("\n").slice(0, 5)) lines.push(`  ${W}${line}${R}`);
        }
        if (touched.length) {
          lines.push("", ` ${B}${C}Touched by tools${R}`);
          for (const path of touched.slice(0, 10)) lines.push(`  ${G}✎${R} ${W}${path}${R}`);
        }
      } else {
        // Full per-file diff, verbatim from git: ---/+++ headers, @@ hunks,
        // +/- lines. Pass-through — only colored and width-truncated.
        const file = files[changeOpen]!;
        lines.push("", ` ${B}${C}${trunc(file.path, Math.max(20, cols - 16))}${R} ${D}${file.code}${R} ${D}· enter closes${R}`, "");
        for (const line of file.diff.split("\n")) {
          const tone = line.startsWith("@@") ? C : line.startsWith("+") ? G : line.startsWith("-") ? RED : D;
          lines.push(`  ${tone}${trunc(line, cols - 4)}${R}`);
        }
      }
      const w = scrollLines(lines, runScroll, bodyH);
      runScroll = w.scroll;
      body = clipLines(w.lines, bodyH);
    } else if (section === "processes") {
      const records = reconcileProcessRecords(detail.dir);
      if (records.length === 0) {
        lines.push(` ${D}No OS processes recorded for this run.${R}`);
      } else {
        const live = records.filter((record) => record.status === "running").length;
        lines.push(` ${B}${C}Processes${R} ${D}${records.length} total · ${live} running${R}`);
        const viewport = Math.max(1, bodyH - lines.length - 1);
        if (processFollow) processSel = records.length - 1;
        processSel = Math.max(0, Math.min(processSel, records.length - 1));
        const start = Math.max(0, Math.min(processSel - Math.floor(viewport / 2), records.length - viewport));
        for (let i = start; i < Math.min(records.length, start + viewport); i++) {
          const record = records[i]!;
          const tone = record.status === "running" ? Y : record.status === "exited" ? G : RED;
          const icon = record.status === "running" ? "●" : record.status === "exited" ? "✓" : "✗";
          const pid = record.pid ? `pid ${record.pid}` : "pid -";
          const ended = record.exitCode === undefined ? "" : ` exit ${record.exitCode}`;
          const command = record.argv.length > 0 ? record.argv.join(" ") : record.name;
          const line =
            ` ${tone}${icon}${R} ${D}${record.id}${R} ${tone}${record.status.padEnd(10)}${R}` +
            ` ${D}${record.origin.padEnd(8)}${R} ${W}${trunc(command, Math.max(16, cols - 48))}${R} ${D}${pid}${ended}${R}`;
          lines.push(selected(line, i === processSel));
          const shownCommand = trunc(command, Math.max(16, cols - 48));
          if (i === processSel && shownCommand !== command) {
            lines.push(`   ${D}${trunc(command, Math.max(16, cols - 6))}${R}`);
          }
          const log = readLogTail(record.stdoutLog, 4_000);
          const tail = log.trim().split("\n").filter(Boolean).at(-1);
          if (tail && i === processSel) lines.push(`   ${D}${trunc(tail, Math.max(16, cols - 6))}${R}`);
        }
      }
      body = clipLines(lines, bodyH);
    } else if (section === "related") {
      lines.push(` ${B}${C}Lineage${R}`);
      if (s.attempt !== undefined) lines.push(`  ${D}attempt${R}     ${W}${s.attempt}${R}`);
      if (s.phase) lines.push(`  ${D}phase${R}       ${W}${s.phase}${R}`);
      if (s.planSnapshotHash) lines.push(`  ${D}snapshot${R}    ${D}${s.planSnapshotHash.slice(0, 12)}${R}`);
      if (s.parentRunId) lines.push(`  ${D}parent${R}      ${D}${s.parentRunId.slice(-8)}${R}`);
      if (s.resumedFrom) lines.push(`  ${D}resumed${R}     ${D}${s.resumedFrom.slice(-8)}${R}`);
      if (s.forkReason) lines.push(`  ${D}fork${R}        ${W}${s.forkReason}${R}`);
      lines.push("", ` ${B}${M}Related runs${R}`);
      if (relatedList.length === 0) lines.push(` ${D}No related runs.${R}`);
      if (childSel >= relatedList.length) childSel = Math.max(0, relatedList.length - 1);
      for (let i = 0; i < relatedList.length; i++) {
        const related = relatedList[i]!;
        const isSelected = i === childSel;
        const line = ` ${icon(related.status)} ${D}${related.id.slice(-8)}${R} ${agentTone(related.agent)}${related.agent}${R} ${D}${fmtTokens(related.usage.totalTokens)} tok · ${fmtMoney(related.cost.actual)} · ${ago(related.lastActivityAt)}${R} ${related.request.replace(/\s+/g, " ").slice(0, 40)}`;
        lines.push(selected(line, isSelected));
      }
      body = clipLines(lines, bodyH);
    } else if (section === "context") {
      if (!context) lines.push(` ${D}No context manifest recorded.${R}`);
      else {
        lines.push(` ${B}${C}Context manifest${R} ${D}${context.chars.toLocaleString()} chars / ${context.sources.length} sources${R}`);
        for (const source of context.sources) {
          const tone = contextTone(source.kind);
          lines.push(`  ${tone}${source.kind.padEnd(10)}${R} ${D}${String(source.bytes).padStart(6)}b${R} ${D}${source.origin.padEnd(9)}${R} ${W}${trunc(source.ref, cols - 36)}${R}${source.truncated ? ` ${Y}trunc${R}` : ""}${source.warning ? ` ${Y}${source.warning}${R}` : ""}`);
        }
        for (const warning of context.warnings) lines.push(`  ${Y}warning${R} ${W}${warning}${R}`);
      }
      const w = scrollLines(lines, runScroll, bodyH);
      runScroll = w.scroll;
      body = clipLines(w.lines, bodyH);
    }

  return {
    body,
    runCwd,
    runHints,
    footerMapTokens,
    footerCtx,
    runScroll,
    processSel,
    eventSel,
    eventCursor,
    childSel,
    changeSel,
    changeOpen,
  };
}
