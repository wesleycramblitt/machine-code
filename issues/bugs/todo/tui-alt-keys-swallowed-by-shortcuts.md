acceptance: script:build
files: src/tui/screens/issue-composer/keys.ts, src/tui/screens/composer/keys.ts, src/tui/edit.ts
keywords: Alt+d, depends, delete word, insert mode, field edit
tags: tui

# Alt edit keys fire page shortcuts instead of editing

Reproduce: open the new issue composer, press `e`, type `hello world`, move left one word, press Alt+d. Expected: delete the word under the cursor. Actual: the composer leaves insert mode and opens the Depends field editor (`d` shortcut in `src/tui/screens/issue-composer/keys.ts:162-169`).

What fails: both composers test `data === "\x1b"` before calling `editLine` (issue composer insert at `src/tui/screens/issue-composer/keys.ts:73-74` and field edit at `:44-45`; run composer insert at `src/tui/screens/composer/keys.ts:85-86`). A terminal that delivers Alt as two reads (ESC, then the letter) therefore exits edit mode on the first read, and the letter lands in normal mode, where single letters `t w d f a v r k p e` are field and page shortcuts. A combined `\x1bd` chunk works (deleted by `ALT_D` in `src/tui/edit.ts:149-150`), so the bug is timing-dependent.

Expected: while editing prompt text or a field, Alt+letter and Alt+arrow sequences always reach `editLine` (Alt+b/f/d, Ctrl+a/e/b/f/d/k/u, arrows) and never trigger normal-mode shortcuts; a lone ESC still exits edit mode. Cover every edit binding `edit.ts` documents, in both composers and in field edit, model/item picker filter, and context filter paths that route through `editLine`. Keep plain-letter shortcuts working unchanged in normal mode.
