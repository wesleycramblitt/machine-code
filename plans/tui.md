# TUI

Planning features, bugs, and ideas for the machine_code TUI.

## Features

- [ ] new-run-handoff — Opening New Run should show a blank run-details page that fills in as the run starts, not bounce through the runs list.
- [ ] repo-map-view — Visualize the repo map and semantic index.
- [ ] runs-page-hierarchy — Runs page hierarchy colors, branch/orchestration visibility, cwd default, PR removal.
- [ ] run-start-handoff — Run-start handoff as an immediate run-details page with progressive fill-in.
- [ ] encodings - Feature that are [Done] should be gray instead of green. Also, leave slug as normal text color, only encode status for all encodings on runs page (Features, Bugs, Ideas)
- [ ] plans-to-issues - Change the folder plans/ to be issues/ and update references in TUI. Makes more sense for ideas, features, bugs. Also move packets/ into issues/ as issues/packets/ 

## Bugs

- [ ] models-page-selection — The selected row is invisible when hovering a major category such as a provider (needs a hover color or indicator).

## Ideas

- [ ] spend-page-empty — Decide what the Spend page should show when there is no spending yet.

## Notes

The Runs page renders one row per work item, grouped All (by type) or By plan.

- Ideas are `Needs Research` → `Researched`; features and bugs are
  `Needs Planning` → `Ready to Build` → `In Progress` → `Done`. `[x]` is done;
  `[~]` is archived; blocked is a flag with a reason.
- A packet is the item's contract, opened from the item page (background,
  contract, runs), not a second row. The page starts a run or a batch.
- Contracts with no matching item surface under "Orphaned contracts"; runs
  with no item or contract under "Untracked runs".
