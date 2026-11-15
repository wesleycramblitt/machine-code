id: a7ba3d
branch: mc/in-the-tui-on-the-run-details-page-we-need-to-re-a7ba3d
acceptance: research:verify

Auto-created from run.

In the TUI, on the run details page, we need to restructure the ui a bit in the overview tab:

"Summary" as a heading, should be removed and replaced with several other headings each color encoded with different colors:
The "Outcome: ..." line can be removed or absorbed into Status (Looks like it is the same thing anyway?)
Remove the "Recorded status: ..." line
Remove the Work: ... line
Issues can be removed
Changes: becomes a color encoded heading, list a summary line of changes after on their own lines
Commands can be removed.
Errors can be removed
Retries can be removed
Response can be removed.
Last Model text can be removed.

The Request section can be broken into 10 lines
The thinking snippet section can be 10 lines as well

Remove the Edit Snippet section

The activiety snippet can be 10 lines

Remove the ^D/^U page  key command from the footer. j/k scrolls.
