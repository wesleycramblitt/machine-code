priority: medium
tags: tui
acceptance: script:build
todo:
  - [ ] Read renderHeader in src/tui/screens/chrome.ts and handleIssueKeys in src/tui/screens/issue-keys.ts
  - [ ] Put the issue screen on the Back[Esc] header bar (no Runs/Models/Spend/Settings tabs), leaving runDetailHeader alone
  - [ ] Remove the footer Back badge and the build/review key bindings; keep Run, Orchestrate, Gate, Approve & Merge, Delete
  - [ ] Gate with script:build

# Issue page: red Back bar on top, fewer key commands

Two small changes so the issue detail page matches the new run page chrome.

1. **Header bar.** In `renderHeader` (`src/tui/screens/chrome.ts`), `backHeader` currently covers the run detail, new-run, answer, correct, and model screens, so the issue page (`page === "runs" && screen === "issue"`) still shows the `1:Runs 2:Models 3:Spend 4:Settings` tab row. Add the issue screen to `backHeader` and give it a `backTitle` (e.g. `Issue Details`). The bar is already the red `theme.backBg` / dark `theme.backFg` `Back[Esc]` pill the run pages use, so no new colors are needed. `runDetailHeader` must stay exactly as it is — it only selects the run page's section-bar footer path, and routing the issue page through it would drop its own action row. The issue screen keeps its normal `actions`/`secondary` footer.
2. **Key commands.** In `renderIssue` (`src/tui/screens/issue.ts`) drop the `commandBadge("Back", "esc", RED_BG, W)` token from the action list now that Back lives in the header; the remaining actions are Run `[n]`, Orchestrate `[o]`, Gate `[g]`, Approve & Merge `[a]`, Delete `[d]`. In `handleIssueKeys` (`src/tui/screens/issue-keys.ts`) delete the `b` (build) and `v` (review) branches and the `spawnCli`/`activeRun` helpers if nothing else uses them, and update that file's header doc comment so it no longer advertises build/review. Keep `esc`/`q` returning to the list, and keep `e` (edit), `j`/`k`, `n`, `o`, `g`, `a`, `x`, `d` as they behave today.
