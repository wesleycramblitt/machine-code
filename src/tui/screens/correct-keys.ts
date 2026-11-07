/**
 * machine_code — correct screen keys.
 *
 * Text entry for the correction plus `i` to only interrupt the parent.
 * Enter forks a corrective child run. Returns true when consumed.
 */
import { printable } from "../format.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleCorrectKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b") { s.screen = "run"; s.correctText = ""; ctx.draw(); return true; }
  if (data === "i") { ctx.interrupt(ctx.runDetailData()?.summary); s.screen = "run"; ctx.draw(); return true; }
  if (data === "\r" || data === "\n") { ctx.submitCorrection(); ctx.draw(); return true; }
  if (data === "\x7f" || data === "\b") { s.correctText = s.correctText.slice(0, -1); ctx.draw(); return true; }
  if (!data.startsWith("\x1b")) { s.correctText += printable(data); ctx.draw(); return true; }
  ctx.draw();
  return true;
}
