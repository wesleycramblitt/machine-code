commit: 76a57e12773267764593fa4d0bf5a944c54e57cf
depends: deps-view-spacing
files: src/tui/screens/runs-list.ts, src/tui/screens/tones.ts
tags: tui
acceptance: script:build
keywords: priority, blocked, gray, runs list, PRIORITY_TONE

# Color-encode priority and gray out blocked issues on the runs list

Today every issue row on the runs page encodes its priority identically and its blocked state in a loud non-red tone. `PRIORITY_TONE` at `src/tui/screens/runs-list.ts:35` maps high, medium, and low all to the same gray `D`, so a high-priority issue cannot be told apart from a low-priority one at a glance. And a `blocked` issue renders the same bright row as anything else — its only cue is the `· blocked by …` text suffix — with the blocked glyph at `ROSE` in `src/tui/screens/tones.ts:22` rather than red, and no dimming.

What changes:

1. **Priority is encoded by color.** High-priority issues get a distinct, attention-drawing tone (a warm or strong accent) instead of plain gray; medium keeps the neutral tone; low-priority issues use a dimmer tone so they recede. Avoid the brand colors already used for kinds (purple/yellow/red fills) and the palette used for run states. Pick a small, harmonious set — e.g. `RED` for high, `D` for medium, `DIM`/`GR` for low — so priority reads as one extra axis and does not fight the kind badge next to it.

2. **Blocked issues are grayed out with a red marker.** A `blocked` issue row renders dimmer than a live one (the existing `dim()` helper at `src/tui/format.ts:538` reuses the `DIM` tone and keeps background fills), and its blocked cue reads as red — low-saturation so it sits with the muted palette — replacing the coral `ROSE`. The `blocked` status tone in `ISSUE_STATUS_STYLE` should move to red too, so the issue detail page and the runs page agree.

3. **Unknown-dep and blocked-by suffixes keep their current wording** (`· unknown dep …`, `· blocked by …`) — only the color changes.

You know it is done when: a scan of the runs list separates a high-priority todo from a low-priority one by color alone, and a blocked issue is visibly the dimmed, red-marked outlier instead of a third bright row.

Bounds: the engineer changes `PRIORITY_TONE` in `src/tui/screens/runs-list.ts:35` and the blocked tone in `ISSUE_STATUS_STYLE` in `src/tui/screens/tones.ts:14-24`, plus the gray-out of blocked issue rows in the issue branch of `renderRunsList` (`src/tui/screens/runs-list.ts:68-91`). Keep the rows readable against the body surface (#0a0a0a) and the `sectionBg` panels.
