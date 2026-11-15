id: 0c4b59
branch: mc/i-referenced-a-recently-completed-issue-that-ref-0c4b59
acceptance: script:build

Auto-created from run.

I referenced a recently completed issue that refactored the ui/ux of the overview page. As a part of that, it appears to have broken the timeline, now items in the timeline have no text. Fix the timeline so that it shows the text form the items properly.  Also, while you are at it, the Status section can use a different encoding color for the heading vs the text, and the text should have the actual status before the description.  So, mabye a white status heading, then red text under: [FAILED] all elibgible models...   Also, the text in requrest should be muted gray like the thinking and activity sections. Same with any other text on this page that isn't a heading or a non white color. Looks odd.
