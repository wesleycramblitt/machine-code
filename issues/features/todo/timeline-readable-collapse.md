files: src/tui/screens/run-detail/run-detail.ts
keywords: timeline, collapse, tail, output, thinking, run detail
acceptance: script:build

# Timeline collapse shows a readable tail, not one line

On the run detail timeline, a collapsed (non-active) call block currently
renders only its header plus a single ok/ERR line. The final model output and
thinking are elided entirely — the second the model finishes, its answer
vanishes to `ok` and the user cannot read what it said without expanding every
block. Collapse is jarring: live output streams in, then jumps away to one
line instead of scrolling up out of view.

Change collapse so a collapsed past block shows the **tail** of the event —
roughly the last 10-20 lines of the final output, thinking, or tool result —
with a one-line note when earlier lines were cut. The existing `tailLines`
helper (`run-detail.ts:398`) already produces exactly this shape ("… N earlier
lines" prefix + the last N lines); it is currently used only for command
output, not for the model-call/tool-call collapse policy.

```ts
function tailLines(lines: string[], cap: number): string[] {
  if (lines.length <= cap) return lines;
  return [`… ${lines.length - cap} earlier lines`, ...lines.slice(lines.length - cap)];
}
```

## What changes

When a past call block collapses (compact, not the live tail, not expanded):

- A **model call** shows the header, then a dim `··· N earlier lines` note, then
  the last ~15 lines of its final output (or thinking when there is no text
  output), in place of the current single `ok` + first-line preview at
  `run-detail.ts:250-256`.
- A **tool call** shows the header, then the last ~10-15 lines of its result
  body (shaped per tool), replacing the current single-line ok/ERR at
  `run-detail.ts:487-497`. The request/`→` and response/`←` labels stay so the
  collapsed block still reads as a block, not a floating line.
- The per-event `model_call_end` (870-879), `model_request` input preview
  (827), and `tool_call` (921-927, 936-938) collapsed branches use the same
  tail-first policy instead of head-first `slice(0, 3)` / `slice(0, 4)`.
- Expanded behavior is unchanged.

The goal is that finishing output scrolls up 15 lines and stays readable in
place, so the timeline reads top-to-bottom. Picking a cap per body is a
judgment call; 10-20 lines is the target the prompt names.

## Verification

Open a finished run in the TUI (timeline section). Confirm:

1. An old model call that is not expanded shows the last several output lines
   and a "… N earlier lines" note — not a single `ok` line with no body.
2. Finishing output no longer vanishes to one line; it visibly truncates to
   its last ~15 lines and stays visible.
3. `space` on that block still expands to the full body and collapses back to
   the tail.
4. Expanded blocks and the live tail are unchanged.