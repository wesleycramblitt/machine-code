# TUI

Planning features, bugs, and ideas for the machine_code TUI.

## Features

- [ ] new-run-handoff — Opening New Run should show a blank run-details page that fills in as the run starts, not bounce through the runs list.
- [ ] repo-map-view — Visualize the repo map and semantic index.
- [ ] runs-page-hierarchy — Runs page hierarchy colors, branch/orchestration visibility, cwd default, PR removal.
- [ ] run-start-handoff — Run-start handoff as an immediate run-details page with progressive fill-in.

## Bugs

- [ ] models-page-selection — The selected row is invisible when hovering a major category such as a provider (needs a hover color or indicator).

## Ideas

- [ ] spend-page-empty — Decide what the Spend page should show when there is no spending yet.

## Notes

The Runs page renders the work tree as
repository → plan file → item type → item → packet → runs.

- Everything lives under `plans/`. Each plan file is a category; its
  checklist lines are items. Type comes from the nearest
  `## Features` / `## Bugs` / `## Ideas` heading, else the line text.
- Two views: **All** (items grouped by type across files) and **By plan**
  (plan file → type). `g` cycles them.
- Done is a status badge (`[x]`), color-encoded with in-progress, blocked,
  and todo; there is no Done category.
- A linked packet (`→ packets/<slug>.md`) nests under its item. Packets with
  no item sit under "Unplanned packets"; runs with no packet under
  "Untracked".
- Enter opens a linked packet or, for a bare item, seeds a run: features and
  bugs → planner, ideas → research. `n` on a plan-file header starts a
  planner run over that file.
