priority: low
tags: tui
files: src/tui/format.ts
keywords: PURPLE_BG, KIND_RGB, model call, timeline band
acceptance: script:build

# Mute the purple model-call band for better color harmony

The full-width background behind each model call header in the run-detail timeline is a loud purple — `PURPLE_BG` from `KIND_RGB.purple` = `139;124;170` at `src/tui/format.ts:56,62`. It is used both for the model-call band in `renderModelCallBlock` (`src/tui/screens/run-detail/run-detail.ts:203-223`) and for the idea-kind badges on the runs page (`KIND_BG.idea`, `src/tui/screens/tones.ts:28`). On dark terminals the band sits too hot against the muted green/charcoal palette and dominates a scan of the timeline.

What changes: the purple is brought down to a muted, low-saturation violet that still reads as "model call" on a scan but does not shout over the surrounding rows. The change is a single value in the shared `KIND_RGB.purple` source so the model-call band and the idea-kind badges move together and cannot drift — do not introduce a second purple constant for one usage.

You know it is done when: the model-call band is a soft lavender that separates from the body surface and the yellow/red kind bands without glowing, and the idea badge on the runs page uses the same muted value. White and gray text on the band stays legible.

Bounds: edit only `src/tui/format.ts`. Choose a value with lower saturation and a touch more lightness than `139;124;170`, and confirm `WHITE` and `D` text on it still pass contrast. No structural changes — the band stays full-width behind the header line.