/**
 * machine_code — answer screen keys.
 *
 * Text entry for the reply plus 1-9 option shortcuts and Enter-to-send.
 * Sending appends to the run inbox; the run picks it up without replaying
 * the transcript. Returns true when the key was consumed.
 */
import { appendInbox, latestUnansweredQuestion, readInbox } from "../../state/question.js";
import { printable } from "../format.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";
import { CTRL_D, CTRL_U } from "../format.js";

export function handleAnswerKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b") { s.screen = "run"; s.answerText = ""; s.answerOptions = []; s.answerScroll = 0; ctx.draw(); return true; }
  if (data === CTRL_U) { s.answerScroll = Math.max(0, s.answerScroll - Math.max(1, Math.floor(s.answerPage / 2))); ctx.draw(); return true; }
  if (data === CTRL_D) { s.answerScroll += Math.max(1, Math.floor(s.answerPage / 2)); ctx.draw(); return true; }
  if (/^[1-9]$/.test(data) && s.answerOptions.length > 0 && s.answerText.length === 0) {
    const option = s.answerOptions[Number(data) - 1];
    if (option) { s.answerText = option; ctx.draw(); return true; }
  }
  if (data === "\r" || data === "\n") {
    if (s.answerText.trim() && s.selectedRunId) {
      const detail = ctx.runDetailData();
      if (detail) {
        try {
          appendInbox(detail.dir, { questionId: s.answerQuestionId, kind: "answer", text: s.answerText, source: "tui" });
          ctx.notify("answer recorded");
        } catch { ctx.notify("could not record answer"); }
      }
    }
    s.screen = "run";
    s.answerText = "";
    s.answerOptions = [];
    s.answerScroll = 0;
    ctx.draw();
    return true;
  }
  if (data === "\x7f" || data === "\b") { s.answerText = s.answerText.slice(0, -1); ctx.draw(); return true; }
  if (!data.startsWith("\x1b")) { s.answerText += printable(data); ctx.draw(); return true; }
  ctx.draw();
  return true;
}
