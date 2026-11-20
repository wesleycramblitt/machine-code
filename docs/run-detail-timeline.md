# Run detail timeline readability

The run detail timeline shows one block per model call or tool call in order.

Human-readable mode is ON by default. Press `v` in the timeline to toggle raw records OFF/ON. The state lives in `timelineHumanReadable` (see `src/tui/screens/run-detail/types.ts:53`).

Collapsed blocks show the tail, not the head. Model blocks show the last ~15 lines of final output (or thinking). Tool blocks show the last ~12 lines of the result. This keeps finished output visible while it scrolls up.

Expanded blocks show full detail with sub-sections. Model inputs expand per context section. Tool calls with many files expand per file. Press `space` on a block to expand it, `space` on a sub-section to open only that part.

Tool headers use human summaries, not JSON. See `describeToolArgs` and `describeToolBody` in `src/tui/timeline.ts`. Edit blocks show per-file diffs.

Live output stays in place. Streaming thinking and output render inside the open call block until `model_call_end` arrives. The block then collapses to the tail view.
