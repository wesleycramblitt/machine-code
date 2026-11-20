commit: 90d75e081525339b8c3111c090e6a7d80b1f7554
files: src/tui/screens/issue-composer/composer.ts, src/tui/screens/composer/composer.ts
tags: tui
acceptance: script:build
keywords: prompt box, Edit body, insert mode

# Prompt caret disappears except at end of text

Reproduce: open the new issue composer (`n` from list), press `e` to edit the body, type a line, move left with arrow or Ctrl+b. Reproduce in the new run composer prompt editor the same way.

What fails: the issue composer prompt box splices the `▌` block only while `insert` is true (`renderIssueComposer` in `src/tui/screens/issue-composer/composer.ts:77-82`); in normal mode it renders plain wrapped text with no caret. Entering with `e` jumps to end of text (`src/tui/screens/issue-composer/keys.ts:128`), so the user never sees where the caret sits after leaving insert or moving inside a field. Same gap applies to the run composer prompt box in `src/tui/screens/composer/composer.ts`.

Expected: the prompt box always shows the caret at the current cursor column, in and out of insert mode (field lines already do this via `fieldLine` caret windowing). Keep the block visible on wrapped lines and keep the caret-line scroll pin that insert mode already has.
