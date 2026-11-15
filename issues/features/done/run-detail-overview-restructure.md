commit: bc2fd68c36335bdf53ab65f05a2bcb9c4a272f6e
files: src/tui/screens/run-detail/run-detail.ts
tags: tui
acceptance: script:build
keywords: Run Details, Overview, Summary, Changes, Thinking snippet, Activity snippet, Edit snippet

# Restructure the run details Overview tab

On the run details page, restructure the Overview tab's rendering. Replace the
single "Summary" heading with several color-encoded section headings, truncate
the snippet sections to 10 lines, drop the Edit snippet section entirely, and
expand Changes to a color-encoded heading that lists one summary line per
changed path.

## Current state

In `renderRunDetail` (src/tui/screens/run-detail/run-detail.ts:694-747), the
overview section currently renders:

- A conditional "Status" section (only when the run erred/blocked, line 698-705)
- "Summary" heading + full outcome text (line 707-710)
- "Request" heading + first 3 lines of the request (line 711-712)
- "Thinking snippet" heading + last 3 lines (line 713-717)
- "Edit snippet" section (line 718-725)
- "Activity snippet" heading + last 4 lines (line 726-738)
- "Changes" summary line (line 739-741)
- Context line (line 742-744)

The prompt's removal list (Outcome, Recorded status, Work, Issues, Commands,
Errors, Retries, Response, Last Model) describes an older, fuller overview that
is already gone — do not search for or re-add any of those. Scope strictly to
the deltas below.

## What changes

1. **Summary → color-encoded headings.** Remove the "Summary" heading and the
   `outcomeText` body (lines 707-710). The status already appears in the header
   line (`statusColor` + `s.status.toUpperCase()`, line 682), so the Outcome
   text need not be duplicated. Keep the existing conditional "Status" section
   for erred/blocked runs unchanged.

2. **Request to 10 lines.** The Request heading stays; render up to 10 lines of
   the request instead of the current 3 (`slice(0, 3)` → `slice(0, 10)`).

3. **Thinking snippet to 10 lines.** Keep the heading; render up to 10 lines of
   the latest thinking chunk instead of the current 3 (`.slice(-3)` → up to 10
   lines).

4. **Remove the Edit snippet section** (lines 718-725) including the
   `snippetEdits` computation and loop.

5. **Activity snippet to 10 lines.** Keep the heading; render up to 10 lines of
   activity instead of the current 4 (`.slice(-4)` → up to 10).

6. **Changes as a color-encoded heading with per-path summary lines.**
   Replace the single "Changes" Summary-count line with a color-encoded
   "Changes" heading, then list each changed path on its own line (one summary
   line per path from the `touched` list), instead of "N path(s)".

7. **Footer hint.** In the overview footer (line 655) remove the `^D/^U page`
   hint, leaving only `j/k scroll`. Apply the same change to the `context`
   section footer (same line 655), which shares the hint list.

## Verification

Build passes (`script:build`). In the TUI, open a run's Overview tab: no
"Summary", "Edit snippet", or "Outcome" text; Request, Thinking snippet, and
Activity snippet each show up to 10 lines; Changes is a color-encoded heading
with each changed path on its own line; the footer shows `j/k scroll` only
(unless the run is erred/blocked and still shows the Status section).
