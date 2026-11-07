/**
 * machine_code — settings screen keys.
 *
 * Cursor movement only; Enter opens the underlying file in $EDITOR via
 * the composer's own binding. Returns true when the key was consumed.
 */
import { CTRL_D, CTRL_U, HALF_PAGE } from "../format.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleSettingsKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b[A" || data === "k") { s.settingsSel = Math.max(0, s.settingsSel - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.settingsSel++; ctx.draw(); return true; }
  if (data === CTRL_U) { s.settingsSel = Math.max(0, s.settingsSel - HALF_PAGE); ctx.draw(); return true; }
  if (data === CTRL_D) { s.settingsSel += HALF_PAGE; ctx.draw(); return true; }
  ctx.draw();
  return true;
}
