/**
 * machine_code — spend screen keys.
 *
 * Scrolling plus `g` (group by) and `d` (day range). Read-only ledger;
 * `r` just repaints. Returns true when the key was consumed.
 */
import { CTRL_D, CTRL_U, HALF_PAGE } from "../format.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleSpendKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b[A" || data === "k") { s.spendScroll = Math.max(0, s.spendScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.spendScroll++; ctx.draw(); return true; }
  if (data === CTRL_U) { s.spendScroll = Math.max(0, s.spendScroll - HALF_PAGE); ctx.draw(); return true; }
  if (data === CTRL_D) { s.spendScroll += HALF_PAGE; ctx.draw(); return true; }
  if (data === "g") {
    const values: Array<"provider" | "model" | "day" | "agent"> = ["provider", "model", "day", "agent"];
    s.spendBy = values[(values.indexOf(s.spendBy) + 1) % values.length]!;
    s.spendScroll = 0;
    ctx.draw();
    return true;
  }
  if (data === "d") {
    const values = [7, 30, 90, 0];
    s.spendDaysWindow = values[(values.indexOf(s.spendDaysWindow) + 1) % values.length]!;
    s.spendScroll = 0;
    ctx.draw();
    return true;
  }
  if (data === "r") { ctx.draw(); return true; }
  ctx.draw();
  return true;
}
