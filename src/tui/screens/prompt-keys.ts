/**
 * machine_code — prompt screen keys.
 *
 * Text entry for the prompt plus Enter to inject. Returns true when consumed.
 */
import { printable } from "../format.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handlePromptKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b") { s.screen = "run"; s.promptText = ""; ctx.draw(); return true; }
  if (data === "\r" || data === "\n") { ctx.submitPrompt(); ctx.draw(); return true; }
  if (data === "\x7f" || data === "\b") { s.promptText = s.promptText.slice(0, -1); ctx.draw(); return true; }
  if (!data.startsWith("\x1b")) { s.promptText += printable(data); ctx.draw(); return true; }
  ctx.draw();
  return true;
}