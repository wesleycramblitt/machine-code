# Plans

Hand-written plan files. Each file is a category (TUI, Models, …), and its
checklist lines are work items:

- `- [ ] slug - title` — a feature, bug, or idea
- `- [ ] slug - title → packets/<slug>.md` — feature/bug linked to its build contract
- `- [x] …` — done (a status, not a category)
- `- [~] …` — archived (kept, hidden from normal attention)

Type comes from the nearest heading (`## Features`, `## Bugs`, `## Ideas`)
or, when the heading is prose, from the line text. Items can live in any plan
file; `plans/` is the single tree the Runs page renders.

Ideas never own packets: research turns an idea into features or bugs, and
those items carry the packet link. One item = one row: a packet is the
item's contract (opened from the item), never a separate tree node.

- tui.md - Features for upgrading or improving the TUI
- web-tools.md - Features for improving or building web fetch, search, and browse
- models.md - Features for providers, models, and associated algorithms.
- context.md - Context algorithm upgrades (preview parity, budgets, chunking, tiering, eval)
- work-model.md - Packet/work-model design note (historical)
