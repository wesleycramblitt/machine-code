priority: high
tags: tui, rendering
files: src/tui/screens/composer/composer.ts, src/tui/screens/issue-composer/composer.ts
keywords: cursor, ▌, prompt, insert mode, field edit, renderComposer, renderIssueComposer
acceptance: script:build

# Editor cursor is always shown at the end of the text, never at the cursor position

In the TUI, the `▌` cursor block is rendered appended to the end of the text,
so while editing a prompt the cursor only ever appears at the last character.
It never reflects the actual caret column inside the text, which makes
mid-text editing (Alt+f / Alt+b / arrow keys / ctrl+a / ctrl+e) invisible.

Reproduce:

1. Open the new-run prompt (`p`) or the issue prompt (`n` then `e`), type a
   few words.
2. Move the caret into the middle of the first word with `Alt+f`-style motion
   or the left arrow (`\x1b[D`).
3. Expected: the `▌` block appears at the caret column inside the text.
4. Actual: the `▌` stays pinned to the end of the last line; only the text
   under the caret changes from the motion that should have moved.

Root cause: `renderComposer` renders `wrapText(insert ? `${promptText}▌` :
promptText, …)` (src/tui/screens/composer/composer.ts:669) and
`renderIssueComposer` does the same `wrapText(`${promptText}${GR}▌${R}`, …)`
(src/tui/screens/issue-composer/composer.ts:61). Both append the block
character unconditionally at the end instead of inserting it at the cursor
column. Because it is included before wrapping, it is also drawn even when it
lands on a different wrapped line from the caret.

Behavior change required:

- While editing any prompt or comma-field text, the `▌` block appears at the
  exact cursor column of the current caret, on the correct wrapped line.
- When the caret is at end of text, the block sits at the end as it does
  today, so no regression for the common typing case.
- Applies to the field lines (Tags / Keywords / Depends / Files / Acceptance
  Gates / Verification / Review) of the issue composer where a field is being
  edited inline, as well as the two prompt boxes.

Both offenders live in the composer render files; there is no shared
"cursor block placement" helper yet. Do not change which commands the cursor
can move with — only the drawn position.