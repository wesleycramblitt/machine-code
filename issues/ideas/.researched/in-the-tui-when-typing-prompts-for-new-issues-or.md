id: 393d0c
branch: mc/in-the-tui-when-typing-prompts-for-new-issues-or-393d0c
commit: 9093b274e9c7bb5545b606eba80e4a6c23582903
acceptance: research:verify

In the TUI, when typing prompts for new issues or new runs, we need richer features for editing the prompts.  An easy way to do this would be to have vim style keybindings ready to go. If we could literally use vim for the text that would be perfect. If to do this we have to "recreate" vim in a sense, I'd rather go with basic cli bindings that help me go back and edit text. For example ctrl+a to go to the front of the line, alt+d to delete a word, and so on. I'd also only do this if it is easy to just hook in command line key bindings without reimplementing them. I do prefer vim, but investigate which one is doable. If neither are doable without a ton of work, produce a doc explaining why, and I'll plan something else, maybe a small set of useful manual keybindings we implement.
