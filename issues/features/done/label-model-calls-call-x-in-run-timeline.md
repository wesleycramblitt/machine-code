commit: 2b5e90b9cd7cbb81c40e797697493e80efc1962d
priority: high
files: src/tui/screens/run-detail/run-detail.ts
tags: tui
acceptance: script:build
keywords: Run Details, Timeline, Call, model call

# Label each model call "Call x" with clear begin and end

The run-detail timeline renders each model call as a purple-banded block (see `renderModelCallBlock`, `src/tui/screens/run-detail/run-detail.ts:181-360`), but the header carries no call ordinal and no explicit start/end markers. `groupTimelineCalls` already threads an `attempt` counter and each event's `call` number through the block (`src/tui/screens/run-detail/run-detail.ts:101-168`); the renderer just never shows them. When a run makes many calls, or an agent retries, you cannot tell which model call you are looking at or where one ends and the next begins.

What changes: each model call block is labeled with its ordinal — `Call 1`, `Call 2`, … — in the header band, counted in order of appearance across the timeline (across retries, so a fresh `model_select` with `call === 0` increments the label; this is exactly the `attempt` counter). The label is the first thing read on the band, before the provider/model. Begin and end are unambiguous: the band opens the block, and a matching close marker (e.g. the bandwidth reset or a short end line) appears right where the block ends, so that where one call finishes and the next starts is explicit even when both are purple.

You know it is done when: a timeline of a multi-call run reads "Call 1", "Call 2", … left to right, each block visibly self-delimited, and a streaming call shows its ordinal while live ("streaming…") exactly as an ended call does.

Bounds: all changes live in `src/tui/screens/run-detail/run-detail.ts`. Reuse `group.attempt` for the ordinal so the label is stable with the block's expansion/collapse state. Do not change the purple band (that is a separate change) or the event grouping logic.
