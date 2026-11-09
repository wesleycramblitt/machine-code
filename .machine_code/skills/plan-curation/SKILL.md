---
name: plan-curation
description: Use when creating or updating issues under issues/. Issue files are markdown whose text is the prompt; status is the directory.
---

# Plan curation

`issues/` is the single work tree. Each file is one work item:

```
issues/
  ideas/<slug>.md              # needs research
  ideas/.researched/<slug>.md  # researched
  features/{todo,blocked,done}/<slug>.md
  bugs/{todo,blocked,done}/<slug>.md
```

Status is a directory: the item's status is where it lives. Move work with
`git mv` or `machine_code issue move <slug> <status>`.

## File shape

```toml
---
priority = "medium"
prompt = "Make the thing fast."
depends = ["other-slug"]
tags = ["tui"]
review = "none"
---

# Short title

One paragraph of detail the prompt needs.
```

- **priority**: `low` / `medium` / `high`.
- **prompt**: what the agent should do, one or two sentences.
- **depends**: other issue slugs that must finish first (optional).
- **tags**: area tags (optional).
- **review**: `none` (gates only) / `agent` (gates + independent review) /
  `human` (gates only, never auto-merged). Default `none`.
- **status**: the directory. Ideas leave `ideas/` for `.researched/` when
  research finishes; features/bugs move todo → blocked ⇄ todo → done. There
  is no archived status: delete an issue you no longer want.

## Which agent does what

- **Research** takes an idea (`issues/ideas/<slug>.md`) into detailed
  features or bugs. It writes issue files under `features/todo/` or
  `bugs/todo/`, then moves the idea to `.researched/`.
- **Engineer** takes a feature or bug in one run: plan + build with a fast
  keyword/semantic context lookup, commit, then move it to done/ (or blocked
  with a reason in the body). Ideas never carry a review mode of their own;
  the feature/bug they produce does.

## Procedure

1. Read `issues/` (or `machine_code plan`) to find the item.
2. Edit the file text directly — the text is the prompt. Optional `key:
   value` header lines at the top set priority, review, tags, depends, or
   acceptance. Keep the prompt tight; put narrative in the body.
   `acceptance` is the machine gate (named commands); the prompt is the
   semantic definition of done. A review mode decides who judges it.
3. Move the file with `machine_code issue move` or `git mv` when its status
   changes: `ideas/.researched/`, `features/todo|blocked|done/`.
