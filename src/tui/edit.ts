/**
 * machine_code — shared cursor-based text editing.
 *
 * A pure readline-style editor over a single line of text plus a cursor
 * column. Callers hold one cursor field per editable composer text and pass
 * `{ text, cursor }` in with each keypress, getting a new pair back. The
 * helpers never read or write the TuiState struct — editing state stays local
 * to the caller so any number of fields can route through the same functions.
 *
 * Cursor columns count UTF-16 code units, matching `String` indexing. Keys:
 *
 * - `\x01` ctrl+a — start of line
 * - `\x05` ctrl+e — end of line
 * - `\x02` / `\x06` ctrl+b / ctrl+f — one character left/right
 * - `\x1bp` / `\x1bf` alt+b / alt+f — one word left/right
 * - `\x04` ctrl+d — delete the character under the cursor
 * - `\x1bd` alt+d — delete to the end of the current word
 * - `\x08` / `\x7f` backspace — delete the character before the cursor
 * - `\x0b` ctrl+k — delete to end of line
 * - `\x15` ctrl+u — delete to start of line
 * - `\x1b[D` / `\x1b[C` left/right arrow — one character left/right
 * - any other displayable character — insert at the cursor
 */

export interface EditLine {
  text: string;
  cursor: number;
}

const CTRL_A = "\x01";
const CTRL_E = "\x05";
const CTRL_B = "\x02";
const CTRL_F = "\x06";
const CTRL_D = "\x04";
const CTRL_H = "\x08";
const CTRL_K = "\x0b";
const CTRL_U = "\x15";
const ALT_B = "\x1bp";
const ALT_F = "\x1bf";
const ALT_D = "\x1bd";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";

/** Clamp a cursor column into the string's valid range (0..length). */
function clamp(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor));
}

/** Cursor column of the start of the word boundary at or before `at`. */
function wordStart(text: string, at: number): number {
  let i = clamp(text, at);
  // Skip trailing whitespace, then skip the word itself.
  while (i > 0 && /\s/.test(text[i - 1]!)) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i -= 1;
  return i;
}

/** Cursor column of the end of the word boundary at or after `at`. */
function wordEnd(text: string, at: number): number {
  let i = clamp(text, at);
  // Skip the current word, then any following whitespace.
  while (i < text.length && !/\s/.test(text[i]!)) i += 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

/**
 * Apply one `data` key to an edit line and return the new `{ text, cursor }`.
 * Unrecognised escape sequences leave the line unchanged so callers never
 * corrupt the editor with an arrow or modifier they did not handle.
 */
export function editLine({ text, cursor }: EditLine, data: string): EditLine {
  switch (data) {
    case CTRL_A:
      return { text, cursor: 0 };
    case CTRL_E:
      return { text, cursor: text.length };
    case CTRL_B:
    case LEFT:
      return { text, cursor: Math.max(0, cursor - 1) };
    case CTRL_F:
    case RIGHT:
      return { text, cursor: Math.min(text.length, cursor + 1) };
    case ALT_B:
      return { text, cursor: wordStart(text, cursor) };
    case ALT_F:
      return { text, cursor: wordEnd(text, cursor) };
    case CTRL_D:
      if (cursor >= text.length) return { text, cursor };
      return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case ALT_D:
      return { text: text.slice(0, cursor) + text.slice(wordEnd(text, cursor)), cursor };
    case CTRL_H:
    case BACKSPACE:
      if (cursor <= 0) return { text, cursor };
      return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case CTRL_K:
      return { text: text.slice(0, cursor), cursor };
    case CTRL_U:
      return { text: text.slice(cursor), cursor: 0 };
    default:
      // Escape sequences we do not recognise are ignored; displayable
      // characters (any non-escape payload) insert at the cursor.
      if (data.startsWith("\x1b")) return { text, cursor };
      return { text: text.slice(0, cursor) + data + text.slice(cursor), cursor: cursor + data.length };
  }
}
