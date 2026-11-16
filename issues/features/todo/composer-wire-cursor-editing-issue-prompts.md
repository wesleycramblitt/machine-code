priority: high
tags: tui
files: src/tui/screens/issue-composer/keys.ts
keywords: newIssueInsert, prompt editing, newIssueCursor, newIssueFieldEdit
acceptance: script:build
depends: composer-editor-shared-cursor-helper

# Cursor editing for the new-issue composer fields

The new-issue composer edits the prompt and its inline comma-text fields the
same append-only way as the run composer:

- the issue prompt, `newIssueInsert` mode
  (`issue-composer/keys.ts:79-91`)
- the inline field editor for acceptance/tags/depends/files/keywords,
  `newIssueFieldEdit` mode (`issue-composer/keys.ts:44-76`)

A user cannot correct a typo in the middle of an issue prompt or a tags list
without deleting what follows.

## What changes

Route the prompt editor and the inline field editor through the shared
`src/tui/edit.ts` helper so both keep a cursor position and support the
readline bindings (`ctrl+a`, `ctrl+e`, `ctrl+b/f`, `alt+b/f`, `ctrl+d`,
`alt+d`, `ctrl+k`, `ctrl+u`, backspace, arrows).

Concretely:

- Issue prompt insert mode: on each key, call the helper with
  `{ text: s.newIssue.prompt, cursor: s.newIssueCursor }`, apply the returned
  text and cursor, and keep the existing `\r`/`\n` newline behavior, the
  `12_000`-character cap, and `\x1b`-exits-insert behavior.
- Inline field mode: call the helper with the field's current value and
  `newIssueFieldCursor`, then write the result back through `setField`. Keep
  the `512`-character cap, Enter-confirms, and Esc-cancels-restores-undo
  behavior.
- Both modes already hold their own state, so `ctrl+k` reaching the end of
  the line should follow existing backspace semantics for the field value.

Leave the normal-mode cycling keys (`k`/`p`/`a`/`t`/`d`/`f`/`w`/`v`/`r`/`e`)
exactly as they are — this issue only changes editing inside the two text
fields.

## Entry points

- `src/tui/screens/issue-composer/keys.ts:42-207` —
  `handleIssueComposerKeys`.
- Cursor fields come from the `composer-editor-shared-cursor-helper` issue
  (`newIssueCursor`, `newIssueFieldCursor`).

## Verify

Build (`script:build`) passes. In the new-issue composer insert mode, place
the cursor mid-prompt, insert a word, and confirm the prompt tail is
preserved. In field-edit mode, `ctrl+a` jumps the caret to the front.