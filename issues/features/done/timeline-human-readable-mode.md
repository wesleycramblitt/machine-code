commit: f529bab9ef622b5ba4b519d1ed3d3095030078ca
depends: timeline-readable-collapse
files: src/tui/screens/run-detail/run-detail.ts, src/tui/screens/run-detail/keys.ts, src/tui/state.ts
acceptance: script:build
keywords: timeline, human readable, verbose, mode, toggle, run detail, v

# Human-readable / raw mode toggle for the timeline

The timeline has no way to switch between a reformatted, human-readable view
and the exact raw requests/responses. The existing "v" key (`timelineVerbose`,
`keys.ts:84`, `run-detail.ts:749,761`) only toggles between grouped call blocks
and raw single-event rows — it never changes how an event's *content* is
presented. In raw mode the tool args are still `JSON.stringify` and the input is
still flat text, so the user cannot fall back to "show me the exact JSON" or
"hide the JSON" cleanly.

Add a top-level human-readable mode for the timeline that the user flips on
and off. The readable mode is what the timeline shows by default today's UI
points toward: grouped call blocks, human-shaped inputs and outputs, diffs for
edits. The raw mode is the ground truth: the exact event records and their
JSON args, no reformatting.

## What changes

- A new state flag on the run-detail TUI state (sibling of `timelineVerbose` in
  `src/tui/state.ts`) that is `true` when the timeline renders human-readable
  and `false` when it renders raw. Default `true`.
- A key (refit the existing "v" toggle or add a new one — pick one binding and
  update the hints at `run-detail.ts:634`) that flips the flag and redraws.
  The hint text names the mode, e.g. "human readable ON/OFF".
- `renderRunDetail` and `renderModelCallBlock` / `renderToolCallBlock` read the
  flag. In raw mode, the existing `timelineVerbose` behaviour (every event as a
  raw row, `groupTimelineCalls(ev, verbose)`) stays as the fallback path, so
  raw mode means "show me each record exactly as it was logged".
- In readable mode, the restructured human rendering from the dependent issues
  (`timeline-readable-collapse` first, then `timeline-event-type-rendering`)
  applies.
- When this issue lands, readable mode builds on the collapse-tail behaviour
  from the dependency; the event-type refinements land later in
  `timeline-event-type-rendering`. The toggle itself must work and be visible
  even before those refinements land.

## Verification

Open the run detail timeline and:

1. Press the mode key and confirm the timeline re-renders between the grouped
   (human) view and the raw per-event rows (the current "v" behaviour), and
   that the footer hint reflects the active mode.
2. In raw mode, an expanded tool event shows its exact JSON args; in readable
   mode it shows the human-shaped body. Toggling never crashes and preserves
   scroll position reasonably.
3. The mode persists across a redraw tick (moving the cursor), not just a
   single frame.
