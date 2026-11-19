commit: 6c99dde5a5efc0457eed2e4013ea016dbaf3b64e
depends: timeline-readable-collapse, timeline-human-readable-mode
files: src/tui/screens/run-detail/run-detail.ts, src/tui/timeline.ts, src/tui/format.ts
acceptance: script:build
keywords: timeline, input, context, edit, diff, tool args, human readable, inspect

# Per-event-type readable rendering: inputs show caller-unique content, edits show diffs

In human-readable mode the timeline still renders many events in a generic or
raw way, so the user cannot read what actually happened:

- **Model input** is meaningless flat text. Big models receive a large
  assembled context (repository map, symbol docs, recently-touched code, the
  current plan, the prompt). The timeline shows the whole prompt blob as one
  run-on wall (`renderModelCallBlock` fills the expanded body from the full
  prompt file, `run-detail.ts:277-299`) or else the generic repeating system
  prefix. The user cannot separate "what was unique to this call" from "the
  boilerplate that is on every call".
- **Expanded tool args** are raw `JSON.stringify` (`run-detail.ts:918-919`).
  For an `inspect` or `edit` with many files the JSON is unreadable; the user
  said "I can see a snippet of it in the json, but I can't read it all."
- **Edits in expanded view** do not show the per-file diffs the way the
  changes panel does. The collapsed diff is capped at 5 lines
  (`editSummaryLines(…, 5)`, `run-detail.ts:515,923`).

## What changes

Human-readable mode renders each event cleverly by type:

1. **Model input → the call-unique input, not the blob.** The prompt body
   splits into its context sections (system prompt, repo map, symbols,
   evidence, plan — whatever the assembled structure produces; see
   `resultText`/`contextUsage` and how the README/`changes` panel label
   them). The collapsed input preview shows the **tail** — the unique send
   for this call (`inputLines.slice(-4)` already exists, `run-detail.ts:291`) —
   followed by one dim line per context section with its label and size
   ("system 12k · map 40k · symbols 8k · …"), each expandable when the block
   is expanded. The repeating system prefix no longer floods the preview.
2. **Expanded tool input → shaped per tool, not JSON.** Replace the raw
   `JSON.stringify(callArgs)` at `run-detail.ts:918-919` with the existing
   `describeToolBody`-style key/value lines (`timeline.ts:167-255`, already
   used for requests). Multi-file `inspect`/`edit` args list the file names
   first, then the per-file payloads — mirroring how the changes panel shows
   files.
3. **Edits → file names plus diffs.** In expanded view an edit call shows each
   changed file's name and its `-`/`+` diff lines (the changes panel shape,
   `editSummaryLines`), not a 5-line cap. The diff is colored and wrapped as
   it is today; the hard `maxLines = 5` cap is lifted in expanded mode.
4. **Unknown tools** fall back to the current flat result body — this change
   is about the common readable types, not every tool.

Keep the raw-mode path intact: `timeline-human-readable-mode`'s raw toggle
continues to show the exact JSON. This issue only shapes the readable-mode
rendering.

## Verification

Open a finished run in the TUI, human-readable mode on, timeline section:

1. A collapsed model-call input shows the unique tail plus one line per context
   section with a size; expanding shows per-section content, not a single
   wall of text.
2. Expanding an `inspect` or `edit` call shows the file names and per-file
   contents/diffs instead of one JSON string; the edit diff is no longer cut
   at 5 lines in expanded view.
3. Toggling to raw mode still shows the exact JSON args.
