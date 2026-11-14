id: 1023e8
branch: mc/in-the-tui-when-reviewing-the-changes-tab-on-the-1023e8
commit: cb3b5855c89a5e8bf4eeddd5e19ef0e4ee0e839a
acceptance: script:build

In the TUI, when reviewing the changes tab on the run details page, I see the new key command bound to Enter, I don't see any changes, any cursor to move up and down with j/k and any diffs expanded. I do see the worktree and edited files list that was there to begin with. This page should be a place you can easily view the changes bound to the feature at any stage: untracked in the worktree, changes in the feature branch itself, and if merged and pruned, the changes there were in the commit/merge.   The interface should also obviously work to look through those changes with the cursor using j/k and open them with enter.
