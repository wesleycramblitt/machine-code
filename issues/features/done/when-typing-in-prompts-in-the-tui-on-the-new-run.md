id: af62f9
branch: mc/when-typing-in-prompts-in-the-tui-on-the-new-run-af62f9
commit: cb5e3fe914dc4b102501cd5d948f436b0ec75c90
acceptance: script:build

Auto-created from run.

When typing in prompts in the TUI on the new run page or new issue page, there are several weird problems that happen with the cursor. I can't seem to go up or down with it with arrow keys,  Alt+b doesn't work to move back a word.  I can't scroll (up/down would work for that). Sometime when typing and moving a lot the cursor is in the wrong place and letters start showing up in odd places.   Make the algorithm far more robust, and fill in the gaps with any missing features
