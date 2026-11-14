id: 56483f
branch: mc/on-the-run-details-page-in-the-tui-on-the-timeli-56483f
acceptance: script:build

Auto-created from run.

On the run details page, in the TUI, on the Timeline tab. As you scroll the timeline with j/k, the cursor should just move up and down on all lines, not just timestamps, and the cursor should have color encoding even when in sections (so you can see it).  When a section is expanded with Enter, that just adds more lines for the cursor to scroll. Currently it focuses the cursor in that section, and you can't move past the end or before the beginning without hitting Enter again.
