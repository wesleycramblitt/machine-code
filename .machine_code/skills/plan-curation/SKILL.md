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
review: none
verification: direct
tags: tui
depends: other-slug
keywords: Run Details, Timeline
acceptance: script:build
todo:
  - [ ] Step 1
  - [ ] Step 2
  - [ ] Finish

# Short title

One paragraph of detail the prompt needs.
```

- **priority**: `low` / `medium` / `high` (default medium; omitted when medium).
- **review**: `none` (gates only) / `agent` (gates + independent review) /
  `human` (gates only, never auto-merged). Default `none`.
- **verification**: `direct` / `verified` (default direct; only written when
  verified — verified requires `scripts/test.sh` and adds the testing skill).
- **tags** / **depends**: comma lists (optional).
- **keywords**: comma-separated phrases naming the exact UI strings, page
  names, or commands involved (optional; the runner matches these exactly
  to find files).
- **acceptance**: comma list of runner commands (`script:build`,
  `script:test`, ...). Every created issue needs one.
- **todo**: multi-line checklist; indented `- [ ]` / `- [x]` lines. 2-4
  concrete steps; the first open item becomes the next run's Next action.
- **status**: the directory. Ideas leave `ideas/` for `.researched/` when
  research finishes; features/bugs move todo → blocked ⇄ todo → done. There
  is no archived status: delete an issue you no longer want.

## Procedure

1. Read `issues/` (or `machine_code plan`) to find the item.
2. Edit the file text directly — the text is the prompt. Optional `key:
   value` header lines at the top set priority, review, tags, depends,
   keywords, or acceptance. Keep the prompt tight; put narrative in the body.
   `acceptance` is the machine gate (named commands); the prompt is the
   semantic definition of done. A review mode decides who judges it.
3. Nobody moves files by hand inside a run: status moves (`ideas/` →
   `.researched/`, `features|bugs/todo|blocked|done`) are the harness's job
   after gates pass. Outside a run, move a file with
   `machine_code issue move <slug> <status>` (or `git mv`) and commit
   `issues/` — but never to work around a failed gate.
