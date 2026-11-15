commit: e57084189f5ef1302bd34a17ca8c6989dc7750b9
depends: timeline-absorbs-thinking, timeline-call-blocks, timeline-human-results, timeline-visual-grammar, orchestration-page, orchestrator-keeps-runs-moving
files: src/tui/screens/run-detail/run-detail.ts, src/tui/screens/run-detail/keys.ts, src/tui/state.ts, src/tui.ts
tags: tui
acceptance: script:build
keywords: Timeline, follow ON, following latest event, space, expand, space to expand

# Run Details: live tail — only the newest call stays expanded

From ideas/on-the-run-details-page-combine-thinking-and-out: "show thinking as it unfolds, only collapse past calls/timestamps". Today every block previews up to 4 body lines whether or not anyone is looking at it, and the live stream has no pinned tail.

## Current state

- Non-expanded events show fixed 4-line previews for output/thinking (run-detail.ts:356-384), prompt tails (:331-334), and results (:423-425); expansion is the `expanded` set toggled by space/enter (keys.ts:70-77, :150-151), keyed `${runId}:${eventIndex}` (run-detail.ts:294).
- Follow mode (F, default ON) pins the cursor to the newest rendered line via the -1 sentinel (keys.ts:60-63, :80-86); render snaps `eventSel` (run-detail.ts:471-473); `timelineFollow` lives in src/tui/state.ts.
- The live streaming segment for the open call lands with timeline-absorbs-thinking.

## Behavior change

1. Default collapse policy: completed call blocks render their header only, plus a one-line result summary (ok/ERR and what the tool returned or changed). The fixed 4-line preview policy for past blocks goes away. Only the newest call block — the last model call or the open tool block — renders its full body, where thinking/response unfold live.
2. space/enter still expands a collapsed past block (the existing `expanded` set); toggling the newest block collapses it to header-only as well.
3. Follow ON pins the view to the tail of the live/newest block (not merely the last line of the whole list); as new blocks start, older blocks auto-collapse. The collapse is derived at render time, not stored — no new persistent state.
4. With follow off, a past block the cursor rests on never auto-collapses under the user; j/k still move line by line over rendered lines.
5. Keep the "space to expand" copy and the `space expand` hint (run-detail.ts:170) accurate for collapsed blocks; `v` verbose mode unchanged.

## Acceptance

- `script:build` passes.
- A long finished run reads as a scannable list of one-line call headers with only the tail block expanded; expanding a past block and pressing j/k does not collapse it out from under the cursor; follow keeps the live tail in view.
