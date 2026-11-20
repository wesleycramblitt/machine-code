depends: tui-newrun-enter-inserts-at-cursor
tags: tui
files: src/tui.ts, src/tui/screens/composer/keys.ts, src/tui/screens/issue-composer/keys.ts
keywords: new-run composer, new-issue composer, EDITOR, prompt, vim
acceptance: script:build

# Edit TUI prompts in $EDITOR for real vim

New-run and new-issue prompts use built-in `editLine` readline keys (`src/tui/edit.ts:124-158`: ctrl+a/e/b/f/d/k/u, alt+b/f/d, arrows). No vim mode exists. No external editor exists for prompts. Settings screen already suspends raw mode and runs `$EDITOR` with inherit stdio (`src/tui.ts:209-226`). `proc.ts` stays piped-only; prompts must use same `spawnSync` inherit pattern, not `runProc`.

Add one normal-mode key in each composer (for example `E`) that writes prompt to temp file, suspends raw mode, spawns `$EDITOR`/`$VISUAL`, reads file back, restores raw mode, updates prompt and cursor. Reuse `openEditor` suspend pattern. Notify when `$EDITOR` is empty or launch fails. Do not build vim modal keys. Document key in composer help line.

Verify: set `EDITOR=vim`, press key, edit and save, prompt updates; unset `EDITOR` shows notice.
