# TUI
This file details upgrades or issues to be planned for the TUI

# New Run Page
- When a run is started, we should go to a blank run details page with partial information filled in until the run starts (then fill the rest in). Currently it goes to the runs page for a moment, confusing.
- Probably need somewhere we can see the repo map and semantic index visually?

- [ ] Feature #164: Runs page hierarchy colors, branch/orchestration visibility, cwd default, PR removal

# Runs page hierarchy
Repository → plan file → item type → item → packet → runs.

- Everything is under `plans/`. Each plan file is a category; its checklist
  lines (`- [ ] slug — title`) are items. Type comes from the nearest
  `## Features` / `## Bugs` / `## Ideas` heading, else the line text.
- Two views: **All** (items grouped by type across files) and **By plan**
  (plan file → type). `g` cycles them.
- Done is a status badge (`[x]`), color-encoded with in-progress/blocked/
  todo; there is no Done category.
- A linked packet (`→ packets/<slug>.md`) nests under its item. Packets with
  no item sit under "Unplanned packets"; runs with no packet under
  "Untracked".
- Enter opens a linked packet or, for a bare item, seeds a run: features/bugs
  → planner (materialize into a packet), ideas → research (propose features
  or bugs). `n` on a plan-file header starts a planner run over that file.

# Orchestration


# Run details Page
- [ ] Feature #167: Run-start handoff: immediate run-details page with progressive fill-in

# Models page
- Can't see the selected item (hover color or indicator) when hovering a major category (like a provider)

# Spend Page


