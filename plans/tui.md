# Overview
This file details upgrades or issues to be planned for the TUI

# New Run Page
- When a run is started, we should go to a blank run details page with partial information filled in until the run starts (then fill the rest in). Currently it goes to the runs page for a moment, confusing.
- Probably need somewhere we can see the repo map and semantic index visually?

- [ ] Feature #164: Runs page hierarchy colors, branch/orchestration visibility, cwd default, PR removal

# Runs page hierarchy
Repository → plan categories → plan line → packet → runs.

- Categories come from `plans/index.md` headings. Each checklist line is a
  plan line; a linked packet (`→ packets/<slug>.md`) nests under it, so the
  intent and its build contract are one item.
- Packets with no plan line sit under "Unplanned packets".
- A collapsible "Plans" section lists plan files. Enter/`n` on a plan or plan
  line opens the composer seeded for a planner run with that plan attached.
- Runs with no packet stay under "Untracked".

# Orchestration


# Run details Page
- [ ] Feature #167: Run-start handoff: immediate run-details page with progressive fill-in

# Models page
- Can't see the selected item (hover color or indicator) when hovering a major category (like a provider)

# Spend Page


