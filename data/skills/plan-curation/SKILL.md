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

## Good issues have scope and acceptance

The issue prompt is the goal. The engineer reads the body text as the
deliverable. For an issue to be actionable, it must pass these tests:

**Features:** What behavior changes? What does it replace? What is the
acceptance gate? If the answer to "how do I know this is done" is not
obvious from the body, add an `acceptance:` line.

**Bugs:** What fails, how to reproduce it, what is expected. Include
error output or the exact steps. The engineer should be able to reproduce
the bug from the body alone.

**Ideas:** A question or direction to explore. Ideas do not need
acceptance — they are not implementation work yet.

### Anti-patterns

- **Mirroring the prompt.** If the research prompt is "add settings caching"
  and the issue says "add settings caching" with no delta, you added no
  value. A good issue says *what part of settings caches what data, when it
  is invalidated, and how to verify it works*.
- **Implementation instead of behavior.** "Add an AppConfig class with
  load/save methods" tells *how*, not *what*. "Settings should persist across
  restarts and load lazily" tells *what* — the engineer picks the how.
- **Vague scope.** "Refactor the layout engine" — what is wrong with it?
  What does success look like? If you cannot name the files or acceptance
  gate, make it an idea.
- **Filler.** If an issue adds no new behavior, no bug fix, and no doc
  readers would miss, delete it or leave it out.

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
