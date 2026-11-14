/**
 * machine_code — run detail keys.
 *
 * Section navigation, timeline expand/follow/verbosity, process
 * follow/open/kill, related-run opening, answer/interrupt/correct/fork,
 * issue approval, and delete. Returns true when consumed.
 *
 * In the timeline, j/k move the cursor line by line over every rendered
 * line (header or expanded body); space expands the event under the cursor.
 * There is no ^D/^U in the timeline.
 */
import { layout } from "../../../paths.js";
import { listAllRuns } from "../../../state/runs.js";
import { CTRL_D, CTRL_U, HALF_PAGE } from "../../format.js";
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
  if (data === "j" || data === "\x1b[B") {
    if (s.runSection === "timeline") { s.timelineFollow = false; s.eventSel++; }
    else if (s.runSection === "processes") { s.processFollow = false; s.processSel++; }
    else if (s.runSection === "thinking") { s.thinkingFollow = false; s.thinkingScroll++; }
    else if (s.runSection === "changes") {
      // Diff open: j/k page the diff; otherwise they move the file cursor.
      if (s.changeOpen !== null) s.runScroll++;
      else s.changeSel++;
    }
    else if (s.runSection === "related") s.childSel++;
    else s.runScroll++;
    ctx.draw();
    return true;
  }
  if (data === "k" || data === "\x1b[A") {
    if (s.runSection === "timeline") { s.timelineFollow = false; s.eventSel--; }
    else if (s.runSection === "processes") { s.processFollow = false; s.processSel = Math.max(0, s.processSel - 1); }
    else if (s.runSection === "thinking") { s.thinkingFollow = false; s.thinkingScroll = Math.max(0, s.thinkingScroll - 1); }
    else if (s.runSection === "changes") {
      if (s.changeOpen !== null) s.runScroll = Math.max(0, s.runScroll - 1);
      else s.changeSel = Math.max(0, s.changeSel - 1);
    }
    else if (s.runSection === "related") s.childSel = Math.max(0, s.childSel - 1);
    else s.runScroll = Math.max(0, s.runScroll - 1);
    ctx.draw();
    return true;
  }
  const moveSection = (delta: number) => {
    const index = RUN_SECTIONS.indexOf(s.runSection);
    s.runSection = RUN_SECTIONS[(index + delta + RUN_SECTIONS.length) % RUN_SECTIONS.length]!;
    s.runScroll = 0;
    s.changeSel = 0;
    s.changeOpen = null;
    s.processSel = 0;
    s.processFollow = false;
    if (s.runSection === "timeline") {
      s.timelineFollow = true;
      s.eventSel = -1; // sentinel: render snaps the cursor to the last line
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
    if (s.eventCursor < 0) return true;
    const key = eventKey(detail.summary.id, s.eventCursor);
    if (s.expanded.has(key)) s.expanded.delete(key); else s.expanded.add(key);
  };
  if (data === " ") { toggleEvent(); ctx.draw(); return true; }
  if (data === "f") { ctx.forkRun(detail); ctx.draw(); return true; }
  if (data === "r") { ctx.resumeRun(detail); ctx.draw(); return true; }
  if (s.runSection === "timeline" && data === "F") {
    s.timelineFollow = !s.timelineFollow;
    if (s.timelineFollow) { s.eventSel = -1; }
    ctx.notify(s.timelineFollow ? "following latest event" : "follow off");
    ctx.draw();
    return true;
  }
  if (s.runSection === "timeline" && data === "v") {
    s.timelineVerbose = !s.timelineVerbose;
    s.timelineFollow = true;
    s.eventSel = -1;
    ctx.notify(s.timelineVerbose ? "showing all events" : "showing key events");
    ctx.draw();
    return true;
  }
  // In the timeline, j/k move the line cursor rather than paging, so there is no ^D/^U.
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
    else if (s.runSection === "changes") {
      // Enter toggles the selected file's full diff; the scroll resets both
      // ways so the view always starts at the top.
      s.runScroll = 0;
      s.changeOpen = s.changeOpen === null ? s.changeSel : null;
    }
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
      s.eventSel = -1;
    }
    ctx.draw();
    return true;
  }
  ctx.draw();
  return true;
}
