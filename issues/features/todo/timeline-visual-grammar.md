tags: tui
depends: timeline-absorbs-thinking, timeline-call-blocks, timeline-human-results
files: src/tui/screens/run-detail/run-detail.ts, src/tui/format.ts
keywords: Timeline, zebra, background, selected, gutter
acceptance: script:build

# Run Details: timeline visual grammar — call kinds read at a glance

From ideas/on-the-run-details-page-combine-thinking-and-out: "Use encodings carefully, colored backgrounds, padding/spacing, colored text … Make it obvious which sections are actual model calls, what information tools returned, modified". Today every timeline row shares one flat style; only zebra stripes and the cursor differ.

## Current state

- Rows are flat lines with inline icons: ◉ model (run-detail.ts:342), ⚡ tool (:394, :404), ✎ edit (:404), ⊞ gates (:430), ⚠ error (:442). Zebra striping paints every other event block with ZEBRA_BG (:486-497) and the cursor row uses `selected` (:499).
- The palette already has what is needed (src/tui/format.ts:22-90): fg `B D C G Y RED M BL GR W WHITE SKY LIME AMBER ROSE VIOLET SLATE`, backgrounds `PANEL_BG SUBTAB_BG START_BG UPDATE_BG PURPLE_BG YELLOW_BG RED_BG ZEBRA_BG`, helpers `background/fit/pad/selected/dim/trunc/wrapText/printable`.

## Behavior change

1. Header bands by kind, full-width via `background(fit(...))`: model call headers PURPLE_BG with WHITE text; tool call headers PANEL_BG (or SLATE fg); gates and errors keep their PASS/FAIL and red/yellow accents. A scan of the timeline separates model calls from tool work without reading a word.
2. A two-character left gutter on every line of a block carries the block icon; body lines indent under the header; `→` marks request lines and `←` marks response lines so input and output align visually inside the block.
3. Metadata dimmed, values colored, reusing existing tones: time GR, names W, tokens G, cost Y, stop reason `statusColor`, durations D. No new palette entries unless a kind lacks a home.
4. Rhythm: exactly one blank line between blocks, none inside; the live streaming marker gets an animated accent (the dots pattern from `waitingLine`, run-detail.ts:115-127).
5. Zebra stripes stay between blocks but must not fight header bands or expanded bodies: skip zebra on header lines and inside expanded block bodies; the cursor row still wins (`selected` applied last).

## Acceptance

- `script:build` passes.
- Model call headers, tool call headers, and error rows are visually distinct at a glance; request/response alignment reads cleanly at 80 and 120 columns.
