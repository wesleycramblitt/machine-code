/**
 * machine_code — screen frame contract.
 *
 * Every screen render is a pure function of explicit props: it returns the
 * body lines plus footer content, and any updated scroll offset. State lives
 * in the TUI root; screens never mutate it. This keeps each screen reusable
 * and testable without a terminal.
 */
import type { UiTheme } from "../format.js";
import { selectableLines } from "../scroll.js";

export interface Viewport {
  cols: number;
  narrow: boolean;
  bodyH: number;
  theme: UiTheme;
  /** Current toast text ("" when none); screens append it to `secondary`. */
  toast: string;
}

export interface ScreenFrame {
  body: string[];
  actions: string;
  extraActions?: string;
  secondary?: string;
  secondaryStyled?: boolean;
  bottomAlign?: { above: string[]; block: string[]; filler?: string } | null;
  runCwd?: string;
  runHints?: string;
  footerMapTokens?: string[];
  footerCtx?: string;
  footerBandTone?: string;
  /** Updated scroll offset when the screen owns a scrollable list. */
  scroll?: number;
}

/** Pad short content to exactly `bodyH` lines so the frame stays stable. */
export function clipLines(lines: string[], bodyH: number): string[] {
  if (lines.length > bodyH) return lines.slice(0, bodyH);
  return [...lines, ...Array.from({ length: bodyH - lines.length }, () => "")];
}

/** Window a line list to the viewport and pad it in one step. */
export function windowedBody(lines: string[], sel: number, scroll: number, bodyH: number): { body: string[]; scroll: number } {
  const w = selectableLines(lines, sel, scroll, bodyH);
  return { body: clipLines(w.lines, bodyH), scroll: w.scroll };
}
