priority: high
tags: tui
files: src/tui/edit.ts, src/tui/state.ts
keywords: newRunCursor, newIssueCursor, cursor editing, edit helper
acceptance: script:build
depends: 

# Shared cursor-based text editing helper for TUI composers

When a user types a prompt for a new run or a new issue, all editing happens
at the end of the string. The insert handler appends printable characters and
backspace removes the last character:

```
s.newrun.prompt += printable(data);            // composer/keys.ts:91
s.newrun.prompt = s.newrun.prompt.slice(0,-1); // composer/keys.ts:89
```

There is nowhere to put the cursor or edit in the middle. Give every
composer text field a cursor and route all editing through one shared helper.

## What changes

Create a pure text-editing module `src/tui/edit.ts` that works on
`{ text, cursor }` and implements a readline-style binding set. Add a cursor
field to TuiState for every editable composer text so the helper can target
any field. After this lands, an engineer can wire either composer to the
helper without duplicating editing logic.

The helper must support, with cursor movement and in-place edit:

- `ctrl+a` — move cursor to start of the line.
- `ctrl+e` — move cursor to end of the line.
- `ctrl+b` and `ctrl+f` — move cursor one character left/right.
- `alt+b` and `alt+f` — move cursor one word left/right (words split on
  whitespace).
- `ctrl+d` — delete the character at the cursor (nothing when at end).
- `alt+d` — delete from the cursor to the end of the current word.
- `ctrl+h` / backspace — delete the character before the cursor (the
  existing end-of-line behavior).
- `ctrl+k` — delete from the cursor to end of line.
- `ctrl+u` — delete from the cursor to start of line.
- left/right arrow (`\x1b[D` / `\x1b[C`) — move cursor one character.
- plain printable characters — insert at the cursor, pushing the rest of the
  line right.
- Return the new `{ text, cursor }` pair given the current pair and one key
  `data` string, so callers keep a single state field per editor.

The helper must not read or write TuiState itself — it is a pure function
over the current text and cursor. Callers hold one `number` cursor field per
editor and pass it in.

Add cursor fields to TuiState for the editors that do not have one yet:

- `newIssueCursor` for the issue prompt (mirrors the existing `newRunCursor`).
- `modelPickCursor` for the model picker filter text.
- `itemPickCursor` for the issue picker filter text.
- `newRunContextFilterCursor` for the context-tab filter.
- `newIssueFieldCursor` for issue field-edit mode.

These fields are declared here so later wiring issues only touch their own
keys files and never create merge conflicts on `state.ts`.

## Entry points

- `src/tui/screens/composer/keys.ts:84-96` — the run prompt insert block to
  be replaced by helper calls (wired in the follow-on issue).
- `src/tui/screens/issue-composer/keys.ts:44-91` — the issue prompt plus
  field-edit blocks (wired in the follow-on issue).
- `src/tui/state.ts:317` — existing `newRunCursor` field; add the rest here.
- The renderers already receive `cursor` in their props
  (`ComposerProps.cursor`, `IssueComposerProps.cursor`) and use it to place
  the caret, so no renderer change is needed for insert-mode editing.

## Verify

The helper compiles cleanly and the TUI still builds and runs. A prompt can
be edited at any position after the follow-on issues land.