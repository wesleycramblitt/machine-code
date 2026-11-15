commit: 5517b7602ab78c59cf99c3f469b7b9d8b6a7b4f0
files: src/tui/runs.ts, src/tui/screens/runs-list.ts
tags: tui
acceptance: script:build
keywords: By dependencies, deps, grouped, RunGroup

# More spacing for dependent issues in the By-dependencies view

The "By dependencies" group nests each blocked issue one indent under the dependency it waits on, so a chain is a column of rows with the same spacing as every other issue row. Long chains read as a flat list — the gap between one dependency group and the next is hard to see.

What changes: rows in the "By dependencies" group gain clear visual separation so each dependency chain reads as one unit. Nested (blocked) issues are indented distinctly from the parent that satisfies them, and the boundary between one chain and the next is visibly larger than the gap between two siblings inside the same chain.

You know it is done when: with the "By dependencies" group open, a dependency and the issues blocked on it look like one connected block, and the next independent chain clearly starts a new block — not a uniform vertical list.

Build the spacing in the deps branch of `buildRunIndex` (`src/tui/runs.ts:385-443`) and render it in `src/tui/screens/runs-list.ts`. The renderer has a `dim()` helper for focus and the rows carry a `depth` that already encodes nesting; use those to express the gap rather than adding new text.
