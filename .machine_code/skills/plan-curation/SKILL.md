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

Plain markdown. Optional `key: value` header lines at the top (only
non-defaults), a blank line, then the prompt body. See `issues/_template.md`.

```
priority: medium
review: none
verification: direct
tags: tui
depends: other-slug
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
- **acceptance**: comma list of runner commands (`script:build`,
  `script:test`, ...). Every created issue needs one.
- **todo**: multi-line checklist; indented `- [ ]` / `- [x]` lines. 2-4
  concrete steps; the first open item becomes the next run's Next action.
- **status**: the directory. Ideas leave `ideas/` for `.researched/` when
  research finishes; features/bugs move todo → blocked ⇄ todo → done. There
  is no archived status: delete an issue you no longer want.

## What a research run produces

Exactly one run, one or more of these — never nothing:

1. **Issues.** Feature/bug files under `features/todo/` or `bugs/todo/`
   (shape above). The common case.
2. **References.** When the idea needs sourced material: `reference:search`
   the web, `reference:browser` the sources, `reference:write` the bundles
   (`<product>/<version>/manifest.yaml`, `content/*.md` with front-matter
   and stable `{#anchor}` headings, hand-authored `index.md`), then
   `reference:reindex`. See the `reference` skill. Ends with
   `Outcome: curated`.
3. **Docs.** When the idea is a question, answer it in full in the summary
   and save the answer as `docs/<slug>.md` so it survives the run. Ends with
   `Outcome: done`.

The harness merges and retires whatever you produced; your job ends at the
`Outcome:` line. If you truly produced nothing new (duplicate, already
answered), say so plainly with `Outcome: done` and do not write filler.

## Which agent does what

- **Research** takes an idea (`issues/ideas/<slug>.md`) into detailed
  features or bugs. It writes issue files under `features/todo/` or
  `bugs/todo/` and ends with an `Outcome:` line (`researched`, `curated`,
  or `done`). It never moves files — the harness retires the idea to
  `.researched/` and merges the created issues to main after gates pass.
  You have no shell, no git CLI, and no move tool; do not try.
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
3. Nobody moves files by hand inside a run: status moves (`ideas/` →
   `.researched/`, `features|bugs/todo|blocked|done`) are the harness's job
   after gates pass. Outside a run, move a file with
   `machine_code issue move <slug> <status>` (or `git mv`) and commit
   `issues/` — but never to work around a failed gate.
