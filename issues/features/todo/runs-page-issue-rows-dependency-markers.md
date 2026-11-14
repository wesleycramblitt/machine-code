tags: tui
files: src/tui/runs.ts, src/tui/screens/runs-list.ts
keywords: issue rows, blocked by, unknown dep, Depends, Group
acceptance: script:build

# Issue rows show what they are blocked by

On the runs page, every issue row must show its dependency state, so "what depends on what" is visible in every group mode without opening the issue page. This is the per-row affordance of the dependency-visibility design; a sibling issue adds the dedicated "By dependencies" group mode (it depends on this one).

Current state:
- Issue rows render glyph, slug, priority suffix, review suffix, title (src/tui/screens/runs-list.ts:65-77). The issue row variant carries no dependency data at all (src/tui/runs.ts:79-94).
- buildRunIndex already receives every issue per repo via `options.issuesByRepo` (src/tui/runs.ts:100-101, 255), so dependency satisfaction can be computed there with no new file IO.
- Satisfaction semantics live in `unmetDepends` (src/tasks/issue.ts:63-75): a dependency is satisfied when its target issue is `done`, or is an idea with status `researched`. Self-dependency is ignored, and `unknownDepends` (src/tasks/issue.ts:77+) is the runner's name for slugs that match no issue (typo, rename, deletion).

Behavior:
- An issue with no dependencies, or with all dependencies satisfied, renders exactly as today. Clean rows stay clean — no marker when nothing is blocked.
- An issue with unmet dependencies appends one dim suffix after the existing priority/review suffixes: `· blocked by <slug>` for a single unmet dependency; when several are unmet, a compact count form such as `· blocked by 2`. Keep the form stable and use the same dim tone as the neighboring suffixes.
- A depends slug that names no issue is shown as unknown, not blocked: e.g. `· unknown dep <slug>`. A typo must not read as waiting on a real issue.
- The suffix is display-only: it must not change folding, selection, or the `n`/`I`/`D`/Enter handling on issue rows (src/tui/screens/runs-list-keys.ts:62-151).
- Compute the satisfied/known slug sets once per `buildRunIndex` call from `options.issuesByRepo` — never per row, and never by re-listing issues from disk. The keys handler rebuilds the index on every keypress (src/tui/screens/runs-list-keys.ts:26) and the draw path calls it every draw (src/tui.ts:1068), so per-row IO or re-reads would multiply fast.

Verify: on the runs page (any group mode), an issue whose `depends:` slugs are not all done shows the blocked suffix; an issue with satisfied or empty deps shows nothing; a misspelled slug shows the unknown marker.
