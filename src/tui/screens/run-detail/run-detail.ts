/**
 * machine_code — run detail screen.
 *
 * Pure render of one run across its sections (overview, timeline, thinking,
 * changes, processes, related, context). Derived data (pending question,
 * related runs, thinking chunks) is computed inside from the detail; the
 * caller supplies scroll/cursor state plus cached changes and receives
 * updated offsets back.
 */
import {
  B, BL, C, D, G, GR, M, R, RED, W, Y, SUBTAB_BG, ZEBRA_BG,
  ago, agentTone, background, command, contextTone, editSummaryLines, fit,
  fmtMoney, fmtRunTokens, fmtTokens, icon, isEditToolEvent, joinCommands, recentEditEvents,
  progress, selected, statusColor, stripAnsi, trunc, visible, wrapText, wrapTokenList,
} from "../../format.js";
import {
  describeTimelineEvent, describeToolArgs, isTimelineEvent, lastTimelineIndex, waitingForRun,
} from "../../timeline.js";
import { scrollLines } from "../../scroll.js";
import { contextUsage, readContextManifest, relatedRuns, thinkingChunks, touchedPaths, type ThinkingChunk } from "../../../report/run.js";
import { readStateView, summarizeRun } from "../../../state/outcome.js";
import { latestUnansweredQuestion, readInbox } from "../../../state/question.js";
import { reconcileProcessRecords } from "../../../processes/reconcile.js";
import { readLogTail } from "../../../processes/logs.js";
import { CAPABILITY_AXES } from "../../../config.js";
import type { RunEvent } from "../../../state/runs.js";
import { clipLines } from "../types.js";
import { RUN_SECTIONS, RUN_SECTION_LABEL, type RunDetailFrame, type RunDetailProps } from "./types.js";

export function renderRunDetail(props: RunDetailProps): RunDetailFrame {
  const { cols, short, bodyH, theme } = props;
  const detail = props.detail;
  const section = props.section;
  let runScroll = props.runScroll;
  let processSel = props.processSel;
  const processFollow = props.processFollow;
  let eventSel = props.eventSel;
  let eventScroll = props.eventScroll;
  let eventBodyScroll = props.eventBodyScroll;
  const timelineFollow = props.timelineFollow;
  const timelineVerbose = props.timelineVerbose;
  let thinkingScroll = props.thinkingScroll;
  const thinkingFollow = props.thinkingFollow;
  let childSel = props.childSel;
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
    const outcomeText =
      s.summary ??
      summarizeRun({
        summary: s,
        events: ev,
        state: readStateView(detail.dir),
        finalText: s.finalText,
      }).text;
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
          return ` ${C}◌${R} ${B}starting${R}${C}${waitingDots}${R}${age}`;
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
      hint("D", "delete", RED),
      ...(pending ? [hint("a", "answer", Y)] : []),
      ...(["running", "awaiting_input", "paused"].includes(s.status)
        ? [hint("i", s.status === "running" ? "interrupt" : "cancel", RED)]
        : []),
      ...(section === "timeline"
        ? [
            hint("j/k", "events"),
            hint("space", "expand", G),
            hint("^D/^U", "scroll", Y),
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
          : section === "overview" || section === "changes" || section === "context"
            ? [hint("j/k", "scroll"), hint("^D/^U", "page", Y)]
            : section === "related"
              ? [hint("j/k", "select"), hint("^D/^U", "page", Y)]
              : []),
    ]);
    footerMapTokens = props.mapTokens(s.worktree ?? s.repoRoot);
    const sectionBar = wrapTokenList(
      RUN_SECTIONS.map((section) =>
        section === section
          ? `${theme.sectionActiveBg}${theme.sectionActiveFg}${B} ${RUN_SECTION_LABEL[section]} ${R}`
          : `${SUBTAB_BG}${theme.sectionFg} ${RUN_SECTION_LABEL[section]} ${R}`,
      ),
      cols - 2,
      "  ",
    ).map((line) => background(fit(` ${line}`, cols), theme.sectionBg));
    const ctxUsage = contextUsage(s.usage, ev);
    const timeLabel = s.endedAt ? `ended ${ago(s.endedAt)} ago` : `updated ${ago(s.lastActivityAt)} ago`;
    const lines: string[] = [
      ` ${icon(s.status)} ${B}${BL}${s.id}${R}  ${statusColor(s.status)}${s.status.toUpperCase()}${R}  ${agentTone(s.agent)}${s.agent}${R}${s.mode ? `/${s.mode}` : ""}  ${G}${s.modelCalls}${R} call(s)  ${Y}${fmtMoney(s.cost.actual)}${R}  ${D}${timeLabel}${R}`,
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
      // outcome plus one snippet per detail section (thinking, edits,
      // activity, changes) instead of duplicating their full bodies.
      if (s.error || s.status === "failed" || s.status === "blocked") {
        lines.push(` ${B}${statusColor(s.status)}Status${R}`);
        const statusText = s.error ?? s.status.toUpperCase();
        const statusTone = RED;
        for (const line of wrapText(statusText, cols - 4).slice(0, short ? 3 : 6)) {
          lines.push(`  ${statusTone}${line}${R}`);
        }
      }
      if (pending?.text) lines.push(` ${Y}? ASK${R} ${W}${trunc(pending.text, cols - 8)}${R}`);
      lines.push(` ${B}${G}Summary${R}`);
      for (const rawLine of outcomeText.split("\n")) {
        for (const line of wrapText(rawLine, cols - 4)) lines.push(`  ${W}${line}${R}`);
      }
      lines.push(` ${B}${BL}Request${R}`);
      for (const line of wrapText(s.request, cols - 4).slice(0, 3)) lines.push(`  ${W}${line}${R}`);
      const lastThinking = thinking.length > 0 ? thinking[thinking.length - 1] : undefined;
      if (lastThinking) {
        lines.push("", ` ${B}${Y}Thinking snippet${R} ${D}latest · full text in Thinking${R}`);
        for (const line of wrapText(lastThinking.text, cols - 4).slice(-3)) lines.push(`  ${D}${line}${R}`);
      }
      const snippetEdits = recentEditEvents(ev, 3);
      if (snippetEdits.length > 0) {
        lines.push("", ` ${B}${G}Edit snippet${R} ${D}latest ${snippetEdits.length} · full diffs in Thinking${R}`);
        for (const editEvent of snippetEdits) {
          const summary = editSummaryLines(editEvent, cols - 6);
          lines.push(`  ${G}✎${R} ${W}${trunc(summary[0] ?? "edit", Math.max(16, cols - 8))}${R}`);
        }
      }
      if (recentActivity.length) {
        const activityLive =
          waiting && waiting.kind !== "input" && waiting.kind !== "paused"
            ? ` ${C}◌ waiting on ${trunc(waiting.label, Math.max(12, cols - 48))}${waitingDots}${R}`
            : s.status === "running"
              ? ` ${G}live${R}`
              : "";
        lines.push("", ` ${B}${C}Activity snippet${R}${activityLive} ${D}full log in Timeline${R}`);
        for (const event of recentActivity.slice(-4)) {
          const time = String(event.t ?? "").slice(11, 19);
          lines.push(`  ${D}${time}${R} ${trunc(describeTimelineEvent(event), Math.max(12, cols - 12))}`);
        }
      }
      lines.push("", ` ${B}${G}Changes${R} ${touched.length ? `${G}${touched.length}${R} ${D}path(s)${R}` : `${D}none yet${R}`}` +
        (relatedList.length ? `  ${D}related${R}  ${M}${relatedList.length}${R}` : "") +
        `  ${D}parent${R}  ${s.parentRunId ? `${D}${s.parentRunId.slice(-8)}${R}` : `${D}none${R}`}`);
      if (context) {
        lines.push(`  ${D}context${R} ${C}${context.chars.toLocaleString()} chars / ${context.sources.length} sources${R}`);
      }
      const w = scrollLines(lines, runScroll, bodyH);
      runScroll = w.scroll;
      body = clipLines(w.lines, bodyH);
    } else if (section === "timeline") {
      const eventLines: string[] = [];
      const starts: number[] = [];
      /** Visible events in render order, for zebra striping. */
      const visibleOrder: number[] = [];
      let timelineAttempt = 0;
      if (timelineFollow) {
        const lastVisible = lastTimelineIndex(ev, timelineVerbose);
        if (lastVisible >= 0 && eventSel !== lastVisible) {
          eventSel = lastVisible;
          eventBodyScroll = 0;
        }
      }
      for (let i = 0; i < ev.length; i++) {
        starts[i] = eventLines.length;
        const event = ev[i]!;
        if (event.type === "model_select" && event.call === 0) timelineAttempt += 1;
        if (!isTimelineEvent(event, timelineVerbose)) continue;
        visibleOrder.push(i);
        const isSelected = i === eventSel;
        const prefix = isSelected ? `${C}▸${R}` : " ";
        const time = String(event.t ?? "").slice(11, 19);
        // Selection never expands: block heights stay stable while moving,
        // so the cursor does not jump. Space toggles expansion manually.
        const expandedEvent = expanded.has(`${s.id}:${i}`);
        const type = String(event.type);
        if (type === "run_start") eventLines.push(`${prefix} ${GR}${time}${R} ${C}▶ start${R} ${agentTone(String(event.agent))}${event.agent}${R}${event.mode ? `/${event.mode}` : ""}`);
        else if (type === "model_select") {
          if (event.error) eventLines.push(`${prefix} ${GR}${time}${R} ${RED}select error ${String(event.error)}${R}`);
          else {
            const estimate = (event.estimate ?? {}) as { inputTokens?: number; outputTokens?: number };
            eventLines.push(`${prefix} ${GR}${time}${R} ${BL}select${R} ${C}${String(event.key)}${R} ${D}${event.estimate ? `${estimate.inputTokens ?? 0}+${estimate.outputTokens ?? 0} tok` : ""}${R}`);
            if (expandedEvent && Array.isArray(event.candidates)) {
              for (const candidate of event.candidates.slice(0, 4)) {
                const chosen = candidate.key === event.key ? `${C}✓${R}` : " ";
                eventLines.push(`    ${chosen} ${D}${Number(candidate.score ?? 0).toFixed(3)}${R} ${candidate.key} ${D}fit ${Number(candidate.fit ?? 0).toFixed(2)}${R}`);
              }
            }
          }
        } else if (type === "model_request") {
          const messages = Number(event.messages ?? 0);
          const chars = Number(event.chars ?? 0);
          eventLines.push(`${prefix} ${GR}${time}${R} ${BL}input${R} ${D}${messages} msg · ${fmtTokens(chars)} chars${R}`);
          const input = typeof event.input === "string" ? event.input : "";
          if (input) {
            const inputLines = input.split("\n");
            while (inputLines.length > 0 && inputLines[inputLines.length - 1]!.trim() === "") inputLines.pop();
            // The head is the repeating system prompt; the tail is the
            // unique send for this call, so the preview shows the tail.
            const shown = expandedEvent ? inputLines : inputLines.slice(-4);
            if (!expandedEvent && inputLines.length > 4) {
              eventLines.push(`    ${D}… ${inputLines.length - 4} head lines hidden (space to expand)${R}`);
            }
            for (const line of shown) {
              for (const wrapped of wrapText(line, Math.max(30, cols - 6))) eventLines.push(`    ${D}${wrapped}${R}`);
            }
          }
        } else if (type === "model_call_end") {
          const usage = (event.usage ?? {}) as { totalTokens?: number; input?: number; output?: number };
          eventLines.push(`${prefix} ${GR}${time}${R} ${M}◉${R} ${W}${String(event.provider)}${R}/${String(event.model)} ${statusColor(String(event.stopReason))}${String(event.stopReason)}${R} ${G}${fmtTokens(Number(usage.totalTokens ?? 0))}${R}tok ${Y}$${Number(event.cost ?? 0).toFixed(5)}${R}`);
          const callChunks =
            typeof event.call === "number"
              ? (thinkingByCall.get(`${timelineAttempt}:${event.call}`) ?? [])
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
          // Streaming deltas are coalesced by the Thinking section; showing
          // each chunk here split the response into unreadable fragments.
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
        } else if (type === "error_classified") eventLines.push(`${prefix} ${GR}${time}${R} ${RED}⚠ ${String(event.kind)}${R}`);
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
      eventSel = Math.max(0, Math.min(ev.length - 1, eventSel));
      while (eventSel < ev.length - 1 && !isTimelineEvent(ev[eventSel], timelineVerbose)) eventSel += 1;
      while (eventSel > 0 && !isTimelineEvent(ev[eventSel], timelineVerbose)) eventSel -= 1;
      // Full-width stripes and selection. Padding must sit INSIDE the
      // tone wrap: the frame paints body background over everything past
      // the wrap's final reset, so unwrapped padding would punch
      // body-colored holes at every line end.
      for (let order = 0; order < visibleOrder.length; order++) {
        const evIdx = visibleOrder[order]!;
        const nextIdx = visibleOrder[order + 1];
        const blockStart = starts[evIdx] ?? 0;
        const blockEnd = nextIdx !== undefined ? (starts[nextIdx] ?? eventLines.length) : eventLines.length;
        if (evIdx === eventSel) {
          if (blockStart < blockEnd) {
            eventLines[blockStart] = selected(fit(eventLines[blockStart]!, cols), true);
          }
          continue;
        }
        if (order % 2 === 0) continue;
        for (let line = blockStart; line < blockEnd; line++) {
          eventLines[line] = background(fit(eventLines[line]!, cols), ZEBRA_BG);
        }
      }
      const timeWait =
        waiting && timelineFollow && waiting.kind !== "input" && waiting.kind !== "paused" ? waitingLine() : null;
      const visibleCount = Math.max(1, bodyH - 4 - (timeWait ? 1 : 0));
      const start = starts[eventSel] ?? 0;
      const end = starts[eventSel + 1] ?? eventLines.length;
      if (end - start <= visibleCount) {
        eventBodyScroll = 0;
        // Keep the whole selected block visible; selected model calls should
        // show their output, not just their header.
        if (end > eventScroll + visibleCount) eventScroll = end - visibleCount;
        if (start < eventScroll) eventScroll = start;
      } else {
        // A long block starts at the top so the first output lines are visible.
        // ^D/^U move the line offset inside the block.
        const maxBodyScroll = Math.max(0, end - start - visibleCount);
        eventBodyScroll = Math.max(0, Math.min(eventBodyScroll, maxBodyScroll));
        eventScroll = start + eventBodyScroll;
      }
      eventScroll = Math.max(0, Math.min(eventScroll, Math.max(0, eventLines.length - visibleCount)));
      lines.push(...eventLines.slice(eventScroll, eventScroll + visibleCount));
      if (timeWait) lines.push(timeWait);
      body = clipLines(lines, bodyH);
    } else if (section === "thinking") {
      // Human-readable output: assistant text interleaved with edit/write
      // calls rendered as -/+ diff snippets (not raw JSON). Timeline keeps
      // the full details; this section stays skimmable.
      const thinkingLines: string[] = [];
      type ThinkingEntry =
        | { at: string; kind: "thinking" | "text"; call?: number; complete: boolean; text: string }
        | { at: string; kind: "edit"; event: RunEvent };
      const entries: ThinkingEntry[] = [];
      for (const chunk of thinking) {
        entries.push({ at: chunk.at, kind: chunk.kind, call: chunk.call, complete: chunk.complete, text: chunk.text });
      }
      for (const event of ev) {
        if (event.type !== "tool_call" || !isEditToolEvent(event)) continue;
        entries.push({ at: String(event.t ?? ""), kind: "edit", event });
      }
      entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      for (const entry of entries) {
        if (entry.kind === "edit") {
          const summary = editSummaryLines(entry.event, cols - 6);
          const failed = Boolean((entry.event as { isError?: unknown }).isError);
          thinkingLines.push(
            ` ${GR}${String(entry.at).slice(11, 19)}${R} ${G}✎ edit${R}${failed ? ` ${RED}ERR${R}` : ""} ${W}${trunc(summary[0] ?? "edit", Math.max(16, cols - 24))}${R}`,
          );
          for (const line of summary.slice(1)) {
            const tone = line.startsWith("+") ? G : line.startsWith("-") ? RED : D;
            thinkingLines.push(`   ${tone}${trunc(line, Math.max(16, cols - 8))}${R}`);
          }
          thinkingLines.push("");
          continue;
        }
        const label = entry.kind === "thinking" ? `${M}thinking${R}` : `${C}response${R}`;
        const live = entry.complete ? "" : `${Y} live${R}`;
        thinkingLines.push(` ${GR}${String(entry.at).slice(11, 19)}${R} ${D}call ${entry.call ?? "?"}${R} ${label}${live}`);
        for (const line of wrapText(entry.text, Math.max(20, cols - 6))) thinkingLines.push(` ${entry.kind === "thinking" ? D : W}${line}${R}`);
        thinkingLines.push("");
      }
      if (thinkingLines.length === 0) thinkingLines.push(` ${D}No assistant text recorded yet.${R}`);
      // In follow mode the eye is on the bottom line, so pin the wait
      // there too — the header copy covers the top of the viewport.
      const thinkWait =
        waiting && thinkingFollow && waiting.kind !== "input" && waiting.kind !== "paused" ? waitingLine() : null;
      const viewport = bodyH - lines.length - (thinkWait ? 1 : 0);
      if (thinkingFollow) thinkingScroll = Math.max(0, thinkingLines.length - viewport);
      thinkingScroll = Math.max(0, Math.min(thinkingScroll, Math.max(0, thinkingLines.length - viewport)));
      lines.push(...thinkingLines.slice(thinkingScroll, thinkingScroll + viewport));
      if (thinkWait) lines.push(thinkWait);
      body = clipLines(lines, bodyH);
    } else if (section === "changes") {
      const changes = props.changes;
      lines.push(` ${B}${C}Worktree${R} ${D}${s.worktree ?? "(none)"}${R}`);
      if (changes.error) lines.push(` ${Y}${changes.error}${R}`);
      if (changes.status) for (const line of changes.status.split("\n").slice(0, Math.max(3, bodyH - 12))) lines.push(`  ${W}${line}${R}`);
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
          const line =
            ` ${tone}${icon}${R} ${D}${record.id}${R} ${tone}${record.status.padEnd(10)}${R}` +
            ` ${D}${record.origin.padEnd(8)}${R} ${W}${trunc(record.name, Math.max(16, cols - 48))}${R} ${D}${pid}${ended}${R}`;
          lines.push(selected(line, i === processSel));
          const log = readLogTail(record.stdoutLog, 4_000);
          const tail = log.trim().split("\n").filter(Boolean).at(-1);
          if (tail && i === processSel) lines.push(`   ${D}${trunc(tail, Math.max(16, cols - 6))}${R}`);
        }
      }
      body = clipLines(lines, bodyH);
    } else if (section === "related") {
      lines.push(` ${B}${C}Lineage${R}`);
      if (s.orchestrationId) {
        lines.push(
          `  ${D}orchestration${R} ${C}${s.orchestrationId}${R}` +
            `${s.orchestrationScope ? ` ${D}${s.orchestrationScope}${R}` : ""}`,
        );
      }
      if (s.attempt !== undefined) lines.push(`  ${D}attempt${R}     ${W}${s.attempt}${R}`);
      if (s.phase) lines.push(`  ${D}phase${R}       ${W}${s.phase}${R}`);
      if (s.planReview) lines.push(`  ${D}plan review${R} ${W}${s.planReview}${R}`);
      if (s.resultReview) lines.push(`  ${D}result${R}      ${W}${s.resultReview}${R}`);
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
        const line = ` ${icon(related.status)} ${D}${related.id.slice(-8)}${R} ${agentTone(related.agent)}${related.agent}${R}${related.mode ? `/${related.mode}` : ""} ${D}${fmtTokens(related.usage.totalTokens)} tok · ${fmtMoney(related.cost.actual)} · ${ago(related.lastActivityAt)}${R} ${related.request.replace(/\s+/g, " ").slice(0, 40)}`;
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
    eventScroll,
    eventBodyScroll,
    thinkingScroll,
    childSel,
  };
}
