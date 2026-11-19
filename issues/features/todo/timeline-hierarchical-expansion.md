files: src/tui/screens/run-detail/run-detail.ts
depends: timeline-readable-collapse, timeline-human-readable-mode, timeline-event-type-rendering
keywords: timeline, expandable, nested, sub-section, inspect, edit, many files, hierarchical
acceptance: script:build

# Expanded long events segment into expandable sub-sections

When a truly large event — a model input with many context sections, or an
`inspect`/`edit` tool call touching a dozen files — is expanded, it renders as
one flat wall. The prompt calls for "more expandable sections, like the input
… or an inspect or edit tool call with a ton of files and results", so a user
can open only the part they care about instead of scrolling one giant body.

Today expansion is all-or-nothing per call block: `expandedEvent` is a single
boolean per block (`run-detail.ts:779`), and the block renderers dump the full
body (full prompt file, all tool args, full result). There is no sub-level.

## What changes

In **expanded** human-readable view, long events that naturally segment
categorically or hierarchically render **collapsed sub-sections**, each with a
one-line label and a per-sub-section expand toggle:

- **Model input**: one sub-section per context section, labeled with the
  section name and size ("system", "map", "symbols", "evidence", "plan");
  each independently expandable. The whole-input header shows `N sections`
  and total size.
- **Inspect / edit tool call**: one sub-section per **file** touched, labeled
  with the path ("diff" for edits), each independently expandable to show that
  file's payload/diff. The whole call header shows `N files`.
- **Tool results with many results**: one sub-section per result where the
  shape is categorical (e.g. a search/write that returns many rows).

The collapse policy from `timeline-readable-collapse` still applies at the
block level (a collapsed block shows its tail; these sub-sections only exist
inside an expanded block). Block-level expansion opens the block; sub-level
expansion opens individual segments. Give sub-sections their own expansion
state keyed alongside the block id so `space` on a sub-section toggles only
it.

## Verification

Open a finished run with a long model input and a multi-file inspect/edit call
in the TUI, expanded:

1. The expanded input shows a list of section headers, not a flat dump; each
   opens independently and the others stay closed.
2. A multi-file tool call shows the file paths first; expanding one shows only
   that file's content/diff.
3. Collapsed (block-level) events still show their readable tail from the
   earlier issue — sub-sections do not leak outside an expanded block.