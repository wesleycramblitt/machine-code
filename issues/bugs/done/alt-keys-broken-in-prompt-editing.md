commit: 9899f1899af61689d472d958bfeef8080c9273a0
priority: high
files: src/tui.ts, src/tui/format.ts, src/tui/edit.ts, src/tui/screens/composer/keys.ts, src/tui/screens/issue-composer/keys.ts, src/tui/screens/models-keys.ts
tags: tui, input
acceptance: script:build
keywords: Alt+d, Alt+f, Alt+b, editLine, depends, word delete, splitKeys, new issue page, new run page

# Alt-modified keys break prompt editing (Alt+d jumps to the depends field)

In the TUI, every Alt-modified editing key is misread. The terminal sends an
Alt+key as an escape-prefixed sequence (`\x1b` + the key). The input dispatch
tears that into a bare ESC plus a plain letter, so instead of the intended
edit it exits insert mode and then fires a second, unrelated command.

Reproduce on the new issue page (`n` then `e` to enter the prompt editor):

1. Type some text in the prompt box, place no cursor movement.
2. Press `Alt+d`.
3. Expected: the current word after the cursor is deleted (the word-boundary
   delete defined in `editLine`, src/tui/edit.ts:92-93).
4. Actual: the editor exits insert mode and the `d` lands on the normal-mode
   handler, which jumps editing to the "Depends" field
   (src/tui/screens/issue-composer/keys.ts:74, 162-169).

Root cause: `splitKeys` (src/tui/format.ts:503-524) splits `\x1bd` into
`["\x1b", "d"]` because it only keeps `[`/`O` CSI sequences together
(lines 509-513); any other ESC prefix becomes a bare `"\x1b"`. The text-entry
dispatch branch (src/tui.ts:1798) requires the chunk to contain no ESC, so
every Alt+key chunk falls through to `splitKeys` and is split. The ESC handler
then consumes the first piece and the plain letter handler consumes the second.

The same bug robs `Alt+b` / `Alt+f` (word back/forward),
`Alt+d` (word delete) and any other `\x1b<letter>` sequence of their meaning
in every editor that routes through `editLine`: the new-run prompt
(src/tui/screens/composer/keys.ts:91), the issue prompt and fields
(src/tui/screens/issue-composer/keys.ts:63,76), the model/issue picker filters
(src/tui/screens/composer/keys.ts:58,75), and the context filter. All the
`editLine` cases for `ALT_B, ALT_F, ALT_D` (src/tui/edit.ts:85-93) are
currently unreachable dead code.

Behavior change required:

- An Alt+key in a prompt or field editor performs its single EDITING action
  (word back / word forward / delete word), and never also triggers the ESC
  exit or any normal-mode handler.
- The ESC-exit, the plain-letter commands (e.g. `d` = depends, `j`/`k`
  navigation), and the `\x1b[D` / `\x1b[C` arrow handlers still work for the
  keys they name; only the Alt-modified variants stop aliasing them.

Implementation note (how, not part of the deliverable): the escape-prefixed
`\x1b<letter>` pair must be delivered to the editor un-split, and must be
dispatched before the plain-letter handlers so `Alt+d` never reaches `d`.
`editLine` intentionally ignores unrecognised `\x1b…` sequences
(src/tui/edit.ts:105), so an unsplit Alt key either edits or is ignored —
safer than today's double-fire. Do not change the saving of prompts or the
`Alt+d` that appears in field-line key hints on other screens.
