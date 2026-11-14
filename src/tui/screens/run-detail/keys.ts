/**
 * machine_code — run detail keys.
 *
 * Section navigation, timeline expand/follow/verbosity, process
 * follow/open/kill, related-run opening, answer/interrupt/correct/fork,
 * issue approval, and delete. Returns true when consumed.
 *
 * In the timeline, j/k move between events; inside an expanded event they
 * scroll the block body (no ^D/^U there).
 */
import { layout } from "../../../paths.js";
import { listAllRuns } from "../../../state/runs.js";
import { CTRL_D, CTRL_U, HALF_PAGE } from "../../format.js";
import { isTimelineEvent, lastTimelineIndex, stepTimelineSelection } from "../../timeline.js";
import { RUN_SECTIONS } from "./types.js";
import { relatedRuns } from "../../../report/run.js";
import { reconcileProcessRecords } from "../../../processes/reconcile.js";
import { terminateAllProcesses, terminateProcessRecord } from "../../../processes/supervisor.js";
import type { TuiState } from "../../state.js";
import type { KeyServices } from "../keys.js";

const eventKey = (runId: string, index: number): string => `${runId}:${index}`;

export function handleRunKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const detail = ctx.runDetailData();
  if (!detail) { s.screen = "list"; ctx.draw(); return true; }
  const n = detail.events.length;
  const selected = (): boolean => {
    while (s.eventSel < n && !isTimelineEvent(detail.events[s.eventSel], s.timelineVerbose)) s.eventSel += 1;
    return s.eventSel < n;
  };
  const expanded = (): boolean => s.expanded.has(eventKey(detail.summary.id, s.eventSel));
  const stepTimeline = (direction: -1 | 1): void => {
    s.timelineFollow = false;
    const next = stepTimelineSelection(detail.events, s.eventSel, direction, s.timelineVerbose);
    if (next !== s.eventSel) {
      s.eventSel = next;
      s.eventBodyScroll = 0;
    }
  };
  const stepOrScroll = (direction: -1 | 1): void => {
    if (s.runSection !== "timeline") { stepTimeline(direction); return; }
    if (!selected()) return;
    if (expanded()) { s.timelineFollow = false; s.eventBodyScroll = Math.max(0, s.eventBodyScroll + direction); }
    else stepTimeline(direction);
  };
  if (data === "j" || data === "\x1b[B") {
    if (s.runSection === "timeline") stepOrScroll(1);
    else if (s.runSection === "processes") { s.processFollow = false; s.processSel++; }
    else if (s.runSection === "thinking") { s.thinkingFollow = false; s.thinkingScroll++; }
    else if (s.runSection === "related") s.childSel++;
    else s.runScroll++;
    ctx.draw();
    return true;
  }
  if (data === "k" || data === "\x1b[A") {
    if (s.runSection === "timeline") stepOrScroll(-1);
    else if (s.runSection === "processes") { s.processFollow = false; s.processSel = Math.max(0, s.processSel - 1); }
    else if (s.runSection === "thinking") { s.thinkingFollow = false; s.thinkingScroll = Math.max(0, s.thinkingScroll - 1); }
    else if (s.runSection === "related") s.childSel = Math.max(0, s.childSel - 1);
    else s.runScroll = Math.max(0, s.runScroll - 1);
    ctx.draw();
    return true;
  }
  const moveSection = (delta: number) => {
    const index = RUN_SECTIONS.indexOf(s.runSection);
    s.runSection = RUN_SECTIONS[(index + delta + RUN_SECTIONS.length) % RUN_SECTIONS.length]!;
    s.runScroll = 0;
    s.processSel = 0;
    s.processFollow = false;
    s.eventScroll = 0;
    s.eventBodyScroll = 0;
    if (s.runSection === "timeline") {
      s.timelineFollow = true;
      const last = lastTimelineIndex(detail.events, s.timelineVerbose);
      if (last >= 0) s.eventSel = last;
    }
    s.thinkingFollow = true;
    ctx.draw();
  };
  if (data === "h" || data === "\x1b[D") { moveSection(-1); return true; }
  if (data === "l" || data === "\x1b[C") { moveSection(1); return true; }
  if (data === "]" || data === "[") { moveSection(data === "]" ? 1 : -1); return true; }
  const toggleEvent = () => {
    if (s.runSection !== "timeline") return true;
    s.timelineFollow = false;
    if (!selected()) return true;
    s.eventBodyScroll = 0;
    const key = eventKey(detail.summary.id, s.eventSel);
    if (s.expanded.has(key)) s.expanded.delete(key); else s.expanded.add(key);
  };
  if (data === " ") { toggleEvent(); ctx.draw(); return true; }
  if (data === "f") { ctx.forkRun(detail); ctx.draw(); return true; }
  if (data === "r") { ctx.resumeRun(detail); ctx.draw(); return true; }
  if (s.runSection === "timeline" && data === "F") {
    s.timelineFollow = !s.timelineFollow;
    if (s.timelineFollow) {
      const last = lastTimelineIndex(detail.events, s.timelineVerbose);
      if (last >= 0) s.eventSel = last;
      s.eventBodyScroll = 0;
    }
    ctx.notify(s.timelineFollow ? "following latest event" : "follow off");
    ctx.draw();
    return true;
  }
  if (s.runSection === "timeline" && data === "v") {
    s.timelineVerbose = !s.timelineVerbose;
    const last = lastTimelineIndex(detail.events, s.timelineVerbose);
    if (last >= 0) s.eventSel = last;
    s.eventBodyScroll = 0;
    ctx.notify(s.timelineVerbose ? "showing all events" : "showing key events");
    ctx.draw();
    return true;
  }
  // In the timeline, j/k scrolls the expanded block, so there is no ^D/^U.
  if ((data === CTRL_D || data === CTRL_U) && s.runSection !== "timeline") {
    const direction = data === CTRL_D ? 1 : -1;
    if (s.runSection === "thinking") {
      s.thinkingFollow = false;
      s.thinkingScroll = Math.max(0, s.thinkingScroll + direction * HALF_PAGE);
    } else if (s.runSection === "processes") {
      s.processFollow = false;
      s.processSel = Math.max(0, s.processSel + direction * 5);
    } else if (s.runSection === "related") {
      s.childSel = Math.max(0, s.childSel + direction * 5);
    } else {
      s.runScroll = Math.max(0, s.runScroll + direction * HALF_PAGE);
    }
    ctx.draw();
    return true;
  }
  if (s.runSection === "processes" && data === "F") {
    s.processFollow = !s.processFollow;
    if (s.processFollow) s.processSel = Math.max(0, reconcileProcessRecords(detail.dir).length - 1);
    ctx.notify(s.processFollow ? "following latest process" : "follow off");
    ctx.draw();
    return true;
  }
  if (s.runSection === "processes" && data === "o") {
    const record = reconcileProcessRecords(detail.dir)[s.processSel];
    if (!record) ctx.notify("no process selected");
    else ctx.openEditor(record.stdoutLog);
    ctx.draw();
    return true;
  }
  if (s.runSection === "processes" && data === "x") {
    const record = reconcileProcessRecords(detail.dir)[s.processSel];
    if (!record) ctx.notify("no process selected");
    else {
      void (async () => {
        try {
          const outcome = await terminateProcessRecord(record);
          ctx.notify(outcome === "kill" ? `SIGKILL ${record.id}` : `SIGTERM ${record.id}`);
        } catch (error) {
          ctx.notify((error as Error).message);
        }
        ctx.draw();
      })();
    }
    ctx.draw();
    return true;
  }
  if (s.runSection === "processes" && data === "X") {
    void (async () => {
      const outcome = await terminateAllProcesses(reconcileProcessRecords(detail.dir));
      ctx.notify(
        outcome.terminated || outcome.killed
          ? `terminated ${outcome.terminated}${outcome.killed ? `, killed ${outcome.killed}` : ""}`
          : "no live processes",
      );
      ctx.draw();
    })();
    ctx.draw();
    return true;
  }
  if (data === "a") { ctx.answerRun(detail.summary); ctx.draw(); return true; }
  if (data === "i") { ctx.interrupt(detail.summary); ctx.draw(); return true; }
  if (data === "c") { ctx.startCorrect(detail.summary); ctx.draw(); return true; }

  if (data === "D") {
    s.deleteTarget = { kind: "run", run: detail.summary };
    s.deleteReturn = "run";
    s.screen = "delete";
    ctx.draw();
    return true;
  }
  if (data === "\r" || data === "\n") {
    if (s.runSection === "timeline") toggleEvent();
    else if (s.runSection === "processes") {
      const record = reconcileProcessRecords(detail.dir)[s.processSel];
      if (!record) ctx.notify("no process selected");
      else ctx.openEditor(record.stdoutLog);
    }
    else if (s.runSection === "related") {
      const scopeRuns = s.runsRepoScope === "cwd"
        ? listAllRuns(layout(ctx.repoRoot).home).filter((run) => run.repoRoot === ctx.repoRoot && !s.deletingRuns.has(run.id))
        : listAllRuns(layout(ctx.repoRoot).home).filter((run) => !s.deletingRuns.has(run.id));
      const child = relatedRuns(scopeRuns, detail.summary)[s.childSel];
      if (child) { s.selectedRunId = child.id; s.runSection = "overview"; s.screen = "run"; }
    }
    ctx.draw();
    return true;
  }
  if (data === "g") {
    s.thinkingFollow = true;
    if (s.runSection === "timeline") {
      s.timelineFollow = true;
      const last = lastTimelineIndex(detail.events, s.timelineVerbose);
      if (last >= 0) s.eventSel = last;
      s.eventBodyScroll = 0;
    }
    ctx.draw();
    return true;
  }
  ctx.draw();
  return true;
}
