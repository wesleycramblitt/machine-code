commit: b05de56ce7f44320b474b4b930ef315214c4c2a1
priority: high
depends: orchestration-page, orchestrator-keeps-runs-moving
files: src/tui/screens/run-detail/types.ts, src/tui/screens/run-detail/keys.ts, src/tui/screens/run-detail/run-detail.ts, src/tui/state.ts, src/tui.ts
tags: tui
acceptance: script:build
keywords: Run Details, Timeline, Thinking, full text in Thinking, full diffs in Thinking

# Run Details: fold the Thinking tab into Timeline and remove the tab

From ideas/on-the-run-details-page-combine-thinking-and-out: "combine thinking and output with the Timeline tab, and remove the separate Thinking tab … show thinking as it unfolds". One view must tell the whole story of a run; a second tab that only shows the same events re-sorted is a detour.

## Current state

- The Run Details tab bar lists a separate Thinking tab: `RunSection` union, `RUN_SECTIONS`, and `RUN_SECTION_LABEL` at src/tui/screens/run-detail/types.ts:13-25 (thinking is the 4th tab).
- The Thinking section renders at src/tui/screens/run-detail/run-detail.ts:508-555: `thinkingChunks(ev)` entries (kind `thinking`/`text`) plus edit `tool_call` events, sorted by timestamp; thinking dim (M), response cyan (C), a ` live` marker while the chunk is incomplete, edit rows as -/+ diffs, `thinkingFollow` pinning the bottom.
- The timeline skips `model_delta` entirely (run-detail.ts:388-390) — while a call streams, the Thinking tab is the only place its unfolding thinking/response text appears. Completed calls already show output+thinking via `thinkingByCall` (run-detail.ts:145-152, :343-384), fed by `thinkingChunks` (src/report/run.ts:326-371), which coalesces deltas per `attempt:call:kind` and marks chunks complete on `model_call_end`.
- Plumbing to remove: `thinkingScroll`/`thinkingFollow` in TuiState (src/tui/state.ts:137-138, defaults :283-284), run-detail props and frame (types.ts:53-54, :77, run-detail.ts:77-78, :683), tui.ts pass/readback (src/tui.ts:1344-1345, :1362), key branches (keys.ts:28, :42, :64, :174).
- Overview copy names the tab: "full text in Thinking" (run-detail.ts:244) and "full diffs in Thinking" (run-detail.ts:249). The module doc comment still lists thinking as a section (run-detail.ts:4).

## Behavior change

1. Remove `thinking` from `RunSection`/`RUN_SECTIONS`/`RUN_SECTION_LABEL`; the tab bar and h/l/[/] cycling (keys.ts:52-69) update automatically. No `runSection` value `"thinking"` remains under src/tui.
2. Delete the `section === "thinking"` render branch and every trace of `thinkingScroll`/`thinkingFollow` listed above.
3. Timeline takes over the streaming content: while a model call is open (no `model_call_end` yet), render its coalesced thinking/response text as it arrives, under the call's input row, with the ` live` marker the old tab used. `thinkingChunks` already provides the data; only the render site moves. This is the "show thinking as it unfolds" requirement — removing the tab must not lose live streaming.
4. Edit diffs already render inside the timeline (run-detail.ts:408-414); the Thinking tab's separate chronological interleave of edits is not carried over — the timeline is already chronological.
5. Repoint the overview copy at Timeline (lines :244 and :249), e.g. "full text in Timeline".

## Acceptance

- `script:build` passes with the section and plumbing removed.
- On a live run, the Timeline shows thinking/response text streaming under the open call; after the call ends, the completed output/thinking block remains.
- Overview snippets no longer reference a Thinking tab.
