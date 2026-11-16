priority: high
tags: tui
files: src/tui/screens/composer/keys.ts
keywords: newRunInsert, prompt editing, newRunCursor, modelPickText, itemPickText, newRunContextFilter
acceptance: script:build
depends: composer-editor-shared-cursor-helper

# Cursor editing for the new-run composer fields

The new-run composer edits four pieces of text by appending to the end and
slicing off the last character:

- the run prompt, `newRunInsert` mode (`composer/keys.ts:84-96`)
- the model picker filter, `modelPickText` (`composer/keys.ts:57-70`)
- the issue picker filter, `itemPickText` (`composer/keys.ts:74-83`)
- the context-tab filter, `newRunContextFilter` (`composer/keys.ts:118-125`)

A user cannot correct a typo in the middle of the prompt or filter without
deleting everything after it.

## What changes

Route all four editors through the shared `src/tui/edit.ts` helper so each
field keeps its cursor position and supports the readline bindings
(`ctrl+a`, `ctrl+e`, `ctrl+b/f`, `alt+b/f`, `ctrl+d`, `alt+d`, `ctrl+k`,
`ctrl+u`, backspace, arrows). Entries in the middle of a line no longer lose
the rest of the text.

Concretely:

- Run prompt insert mode: on each key, call the helper with
  `{ text: s.newrun.prompt, cursor: s.newRunCursor }`, apply the returned
  text and cursor, and keep the existing `12_000`-character cap and
  `\x1b`-exits-insert behavior.
- Model picker, item picker, and context filter: give each its own cursor
  field, call the helper the same way, and re-run the existing picker/filter
  recompute after every edit so the results stay in sync.
- Arrow keys move the caret without changing the text.

Leave the normal-mode navigation keys (`h/l/j/k`, `a/t/f/g/m`, etc.) exactly
as they are — this issue only changes editing inside the four text fields.

## Entry points

- `src/tui/screens/composer/keys.ts:19-249` — `handleComposerKeys`.
- Cursor fields come from the `composer-editor-shared-cursor-helper` issue;
  `newRunCursor` already exists at `state.ts:317`.

## Verify

Build (`script:build`) passes. In the new-run composer insert mode, place the
cursor in the middle of a typed prompt, type a word, and confirm the tail of
the prompt is preserved.