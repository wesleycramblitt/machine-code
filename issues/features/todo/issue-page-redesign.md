tags: issues
acceptance: script:build

# Change the ui/ux of the issue details page. 
Move "Feature", "Bug", ...  to the far left, add the background color and font color from the runs page (Red background, black bold text for Bugs).
Have the slug next on the same line. then the status [Done], make the slug and status colored the same as the runs page (done is gray for example)
Next line.
Branch:  ....      Worktree: .....     (Make the headings bright white and bold, text can be the normal gray)
Next line.
Priority: ....   Review:  ....   (same style)
Next line
Prompt:  (bold)
Next line: full prompt taking as many lines as needed.
Next lines are sections for context, acceptance gates, etc (all other parts of the feature)
Then Runs just like it already is.

# Key commands
Remove build, review, Back[esc] (In fact, remove the heading Runs, models... and so on and put Back[esc] with a red background up top like the new run page)
Approve can become Approve & Merge

## Todo
- [ ] Read the issue detail page and the runs-page styling
- [ ] Apply the runs-page colors and header layout
- [ ] Check branch, worktree, priority, and review lines
- [ ] Finish
