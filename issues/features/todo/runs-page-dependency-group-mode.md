tags: tui
depends: runs-page-issue-rows-dependency-markers
files: src/tui/runs.ts, src/tui/screens/runs-list-keys.ts, src/tui.ts
keywords: Group, By dependencies, --group, g
acceptance: script:build

# Runs page group mode: By dependencies

Add a third mode to the runs-page group cycle `g`: **By dependencies** — issues nest under the dependency they wait on, so the tree reads top-down: land the parents, then the children unblock. The sibling issue (dependency markers on issue rows) annotates rows; this issue makes the graph itself the structure.

Current state:
- `RunGroup` is `"all" | "category"`; `RUN_GROUPS` and `RUN_GROUP_LABELS` define the cycle and the action-hint label (src/tui/runs.ts:29-45). `g` cycles them (src/tui/screens/runs-list-keys.ts:153-159) and the hint renders `RUN_GROUP_LABELS[group]` (src/tui/screens/runs-list.ts:140).
- `pushWorkTree` in buildRunIndex holds the group branches: "all" = kind → status → issue, "category" = kind → status → tag → issue (src/tui/runs.ts:296-352). A "deps" branch belongs alongside them, reusing `pushIssue` so runs still fold under their issue row (src/tui/runs.ts:271-292).
- The issue tree is gated by `workGroup = group === "all" || group === "category"` at three sites: buildRunIndex (src/tui/runs.ts:361-367), the keys handler (src/tui/screens/runs-list-keys.ts:21), and the draw path (src/tui.ts:1063). All three must include the new mode, or the issue tree silently disappears in it.
- `parseRunGroup` accepts only "all"/"category" plus legacy aliases (src/tui/runs.ts:40-45); the `mc runs` CLI shares this parser, so new accepted values flow through automatically.

Behavior:
- `g` cycles All → By category → By dependencies; the Group action hint shows the new label. `parseRunGroup` accepts "deps" and "dependencies" so `mc runs --group deps` works too.
- Inside each repo's work tree this mode has no kind or status headers. Rationale: dependency chains cross kinds (a feature may depend on an idea), and duplicating a row into two kind sections would break fold row-ids. Kind stays visible from the row glyph/colors (issue rows already tone by kind).
- Issues with no unmet dependencies sit under a "Ready" section, sorted by the existing `sortIssues` RANK order (src/tui/runs.ts:264-270). An issue with unmet dependencies nests under its first unmet dependency's issue row (parent row id, the same mechanism run rows use), one indent level per hop.
- Done issues and researched ideas are satisfied dependencies and do not appear in this view: it shows outstanding work only, with no dead parents. Satisfaction semantics must match `unmetDepends` (src/tasks/issue.ts:63-75).
- A depends slug naming no issue cannot nest; its dependent stays in Ready and keeps the unknown-dep marker from the sibling issue.
- Cycles: an issue whose unmet-dependency chain loops back to itself cannot nest under its dependency. Place it under a "Cyclic" section with its marker. The view must render with cyclic `depends:` data — no hang, no dropped rows. (Self-dependency is already ignored by the runner, src/tasks/issue.ts:74.)
- Folding (`space`), j/k navigation, Enter-to-open, `n`, `I`, `D`, `!` attention filter, and `/` search keep working unchanged — the mode only changes row order, depth, and section labels.

Verify: press `g` until the hint reads "By dependencies": unmet-dep issues appear indented under the issue they wait on, Ready holds the rest, and test data containing a `depends:` cycle still renders.
