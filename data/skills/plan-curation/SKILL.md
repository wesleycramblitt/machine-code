---
name: issue-curation
description: Use when creating or updating issues under issues/. Issue files are markdown whose text is the prompt; status is the directory.
---

# Issue curation

`issues/` is the single work tree. Each file is one work item:

```
issues/
  ideas/<slug>.md              # needs research
  ideas/.researched/<slug>.md  # researched
  features/{todo,blocked,done}/<slug>.md
  bugs/{todo,blocked,done}/<slug>.md
```

Status is a directory: the item's status is where it lives. 

## File shape

Plain markdown. Optional `key: value` header lines at the top (only
non-defaults), a blank line, then the prompt body. See `issues/_template.md`.

```
priority: medium
tags: tui
keywords: Run Details, Timeline
acceptance: script:build

# Short title

One paragraph of detail the prompt needs.
```

- **priority**: `low` / `medium` / `high` (default medium; omitted when medium).
- **tags** / **depends**: comma lists (optional).
- **keywords**: comma-separated phrases naming the exact UI strings, page
  names, or commands involved (optional; the runner matches these exactly
  to find files).
- **acceptance**: comma list of runner commands (`script:build`,
  `script:test`, ...). Every created issue needs one.
- **status**: the directory. Ideas leave `ideas/` for `.researched/` when
  research finishes; features/bugs move todo → blocked ⇄ todo → done. There
  is no archived status: delete an issue you no longer want.

## Writing good issues

The issue prompt is the goal. The agent reads the body text as the
deliverable. Make the scope and acceptance criteria obvious from the
text alone:

- **Ideas**: Describe the question or direction to explore. What should
  research produce — feature/bug issues, curated references, or docs?
- **Features**: Say what to build, what it replaces, and how it should
  work. One paragraph is enough.
- **Bugs**: Describe the failure, how to reproduce it, and the expected
  behavior. Include error output or screenshots when relevant.

Keep the prompt tight. A clear deliverable removes the need for a
checklist or plan section.

## Procedure

1. Read `issues/` (or `machine_code plan`) to find the item.
2. Edit the file text directly — the text is the prompt. Optional `key:
   value` header lines at the top set priority, tags, depends, keywords,
   or acceptance. Keep the prompt tight; put narrative in the body.
   `acceptance` is the machine gate (named commands); the prompt is the
   semantic definition of done.
3. Nobody moves files by hand inside a run: status moves (`ideas/` →
   `.researched/`, `features|bugs/todo|blocked|done`) are the harness's job
   after gates pass. Outside a run, move a file with
   `machine_code issue move <slug> <status>` (or `git mv`) and commit
   `issues/` — but never to work around a failed gate.
