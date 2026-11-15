commit: 842b12556b2be7c43a457367040b8ba4f679be25
depends: timeline-absorbs-thinking, timeline-call-blocks
files: src/tui/timeline.ts, src/tui/screens/run-detail/run-detail.ts
tags: tui
acceptance: script:build
keywords: Timeline, describeToolArgs, ERR, ok, space to expand

# Run Details: human-readable tool args and results in Timeline

From ideas/on-the-run-details-page-combine-thinking-and-out: "with human readable output … what information tools returned, modified … beautify or make text completely human readable where possible". Expanding a tool block today prints raw JSON.

## Current state

- Expanded tool bodies dump JSON: `tool_call_start` args via `JSON.stringify(event.args)` (run-detail.ts:395-397), `tool_call` args (:405-406), result stringified (:415-427) with a green `→` prefix; collapsed shows a 3-line preview (:423-425).
- A human one-liner exists: `describeToolArgs` (src/tui/timeline.ts:60-127) covers read/write/edit/map/search/command/context/ask/artifact/skill/pr with a generic fallback.
- Edits already render as -/+ diffs via `editSummaryLines` (src/tui/format.ts:583-637) when collapsed (run-detail.ts:408-414).
- Results are ANSI-stripped (run-detail.ts:417); args are not.

## Behavior change

1. Args bodies: replace the JSON dumps with a multi-line `key: value` rendering — add a `describeToolBody(tool, args)` next to `describeToolArgs` in src/tui/timeline.ts (reuse its per-tool knowledge), long values truncated with a "(N chars)" note, unknown tools get a compact pretty-print. Never a single-line `JSON.stringify` blob.
2. Result bodies per tool: command → exit/status + output tail; read/inspect → the returned excerpt; search/map/context/skill → the text body; write/edit → what changed (path plus the diff lines already rendered, and "wrote N lines" when available); unknown → the first lines of the text.
3. Sanitize and shape: strip ANSI from args too, drop control chars (`printable`, format.ts:545-553), wrap to width with `wrapText`/`trunc` (format.ts:238-299), humanize numbers via `fmtTokens`.
4. Errors read as errors: when `isError`, the response body is the error message in red (today only an "ERR" badge at run-detail.ts:404 and the raw dump remain).
5. Collapsed blocks keep short previews (≤4 lines) and the "space to expand" copy (:361, :425) stays accurate; expanded blocks show the full body.

## Acceptance

- `script:build` passes.
- Expanding a tool block shows readable `key: value` args and a readable result or error message — no raw JSON strings, no ANSI leakage.
