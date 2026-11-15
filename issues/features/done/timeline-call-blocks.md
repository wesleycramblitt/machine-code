commit: 03ab3fc5ec56bb0b422a7b848f2953daeadfb685
depends: timeline-absorbs-thinking
files: src/tui/screens/run-detail/run-detail.ts, src/tui/timeline.ts
tags: tui
acceptance: script:build
keywords: Timeline, tool_call_start, tool_call, model_call_end, space to expand

# Run Details: one timestamped block per call — request and response together

From ideas/on-the-run-details-page-combine-thinking-and-out: "Display each tool request and response together under one timestamp". Today the timeline is a flat per-event list, so a tool call appears twice and a model call spreads over three unrelated rows.

## Current state

- The timeline renders one row per event (run-detail.ts:277-507). `tool_call_start` (:391-398) and its `tool_call` completion (:399-427) are two separate rows at two timestamps; a model call renders `model_select` (:297-308), `model_request` (:309-339), and `model_call_end` (:340-387) rows with nothing tying them together.
- Tool starts and completions share `toolCallId`; the matching pattern (including the no-id fallback) already exists in `waitingForRun` (src/tui/timeline.ts:265-294).
- Attempt counting for pairing is already computed at run-detail.ts:286 (`timelineAttempt`) and used for `thinkingByCall` keys (:343-346).
- Expansion is per event index: `expanded.has(`${s.id}:${i}`)` (:294); the cursor maps cursor line → event index (:471-485); zebra runs over event blocks (:486-499).

## Behavior change

1. A pre-render pass groups events into call blocks:
   - model block = a `model_select`/`model_request` plus the `model_call_end` with the same (attempt, call); reuse the attempt counter.
   - tool block = a `tool_call_start` plus the `tool_call` sharing its `toolCallId`; a start with no completion renders as an open (running) block; a completion with no start (resumed logs) renders as a completed block.
2. Each block carries exactly one timestamp header naming the call: model blocks show ◉ provider/model, stop reason, tokens, cost (from `model_call_end`); tool blocks show the tool name, ok/ERR, duration. The request renders inside the block as the "→ request" body (human args for tools; msg/chars stats plus prompt tail or full prompt file for models — keep the lazy `fullPromptLines` behavior from :314-339), the response as the "← response" body (output/thinking/result/diff).
3. Block ids for `expanded` use the block's first event index (`${runId}:${firstEventIndex}`), so existing expanded sets and the space/enter toggle (keys.ts:70-77, :150-151) keep working; `eventCursor` becomes the block's representative event index.
4. The zebra and cursor post-pass (run-detail.ts:486-499) runs over blocks instead of single events.
5. `v` verbose mode keeps showing raw internals as separate rows (`isTimelineEvent` already gates this); blocks are the default presentation.

## Acceptance

- `script:build` passes.
- A finished run's Timeline shows one timestamped row per tool call with request and response together, and one header per model call with its request and response nested inside.
