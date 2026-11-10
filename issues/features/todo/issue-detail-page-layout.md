priority: medium
tags: tui
acceptance: script:build
todo:
  - [ ] Read renderIssue in src/tui/screens/issue.ts and the runs-page tone tables (KIND_BG / KIND_FG / ISSUE_STATUS_STYLE in src/tui/screens/runs-list.ts, badges in src/tui/format.ts)
  - [ ] Share the runs-page kind/status tones instead of re-declaring them, and use them for the kind badge, slug, and [Status] on line 1
  - [ ] Rebuild the body: Branch/Worktree line, Priority/Review line, bold "Prompt" plus the full wrapped prompt, then Acceptance / Todo / Tags / Depends / Verification sections, then the unchanged Runs rows
  - [ ] Gate with script:build and eyeball the layout at ~100 cols and narrow

# Redesign the issue detail page body

Rewrite `renderIssue` in `src/tui/screens/issue.ts` so the page reads, top to bottom:

```
 Bug  my-slug  [Done]
 Branch: mc/feature/12-my-slug    Worktree: .machine_code/local/worktrees/ab12cd34
 Priority: high    Review: agent
 Prompt:
 <the whole prompt, wrapped to the terminal width, as many lines as it needs>
 Acceptance: script:build, script:test
 Todo:
   [x] Step one
   [ ] Step two
 Tags: tui    Depends: other-slug    Verification: verified
 Runs
   ● a1b2c3d4 engineer RUNNING ...      (exactly as today)
```

Details:

- **Line 1** — the kind label first, far left, no leading indent beyond the current single space: `Bug` / `Feature` / `Idea` on the runs-page background (bugs red, features yellow, ideas purple) with the same dark bold foreground the runs list uses for those badges (black bold on the red background). Then the slug, then `[Status]` in brackets. Slug and status take the runs-page colors: `todo` / `needs-research` slugs use the kind's foreground (features yellow, bugs red, ideas magenta), every other status uses the status tone from `ISSUE_STATUS_STYLE` — so a done issue's slug and `[Done]` are gray. Drop the trailing `issues/...` path from this line; it already lives in the footer `secondary` line.
- **Line 2** — `Branch:` and `Worktree:` on one line. Labels bright white and bold (`WHITE` + `B` from `src/tui/format.ts`), values the normal gray (`D`). Neither field exists on `IssueHeader`: derive them from the runs already passed in as `props.runs` for this slug (newest attached run's `branch` / `worktree` — both are optional fields on `RunSummary`). When no run has them, show `mc/<slug>` for the branch and `—` for the worktree. No new plumbing through `src/tui.ts` and no new git calls; the render function stays pure.
- **Line 3** — `Priority:` and `Review:` with the same bright-white-bold label / gray value style. Show the review mode even when it is `none`.
- **Prompt** — the word `Prompt:` in bold, then the full `issue.prompt` body below it. Remove the current `body.slice(0, 20)` cap and the `trunc(line, 110)`; wrap each line to `props.cols` with `wrapText` from `format.ts`, preserve blank lines, and render markdown heading lines (`#`/`##`) in bold white so the prompt's own sections stay readable. Skip only the leading `# Title` heading line, since the kind/slug line already carries the identity.
- **Sections after the prompt** — the rest of the issue's data, each with the white bold label style: `Acceptance:` (`issue.acceptance`, or `defaults` when empty), `Todo:` (`issue.todo`, one line per item with `[x]`/`[ ]`), and `Tags:` / `Depends:` / `Verification:` on one line, omitting any that are empty. The prompt body itself already contains the narrative context, so do not invent extra sections beyond what `Issue` carries.
- **Runs** — this page keeps its own `Runs` section label above the attached-run rows (that is not the thing being removed; the nav-tab "Runs" is a separate issue), and the rows themselves stay exactly as they render today (icon, id, agent, status, error, cost, tokens). Keep the `windowedBody` scroll behavior and `j`/`k` scrolling working over the now-longer line list.

Keep the existing footer actions untouched in this change (Run / Orchestrate / Gate / Approve & Merge / Delete); the header and key-command changes are a separate issue.

Note: the branch already has the kind background and the `Approve & Merge` label. Match the runs page rather than duplicating its tone tables — export or reuse the shared constants so both pages cannot drift.
