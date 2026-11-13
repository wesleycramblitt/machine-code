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

Plain markdown. Optional `key: value` header lines at the top (only non-defaults), a blank line, then the prompt body. See `issues/_template.md`.

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
- **keywords**: comma-separated phrases naming the exact UI strings, page names, or commands involved (optional; the runner matches these exactly to find files).
- **acceptance**: comma list of runner commands (`script:build`, `script:test`, ...). Every created feature/bug issue needs one.
- **status**: the directory. Ideas leave `ideas/` for `.researched/` when research finishes; features/bugs move todo → blocked ⇄ todo → done. There is no archived status: delete an issue you no longer want.

## Writing good issues

An issue is work for the engineer. Every issue must pass these tests:

**Features** — What behavior changes? What does it replace? How will you know it is done? The body should make the deliverable obvious. `acceptance:` names the verification commands.

**Bugs** — What fails, how to reproduce it, what is expected. Include error output or exact steps.

**Ideas** — A direction to explore. No acceptance needed — they are not implementation-ready.

### Anti-patterns

These waste turns. Do not create them.

- **Mirroring.** If the research prompt is "add settings caching" and the issue says "add settings caching" with no delta, you added nothing. Value comes from *why* it matters, *what* changes, and *how* to verify it.
- **Implementation instead of behavior.** "Add an AppConfig class with load/save methods" tells how, not what. "Settings persist across restarts and load lazily" tells what — the engineer chooses the how.
- **Vague scope.** "Refactor the layout engine" — what is wrong with it? What does success look like? If you cannot name the files or acceptance, make it an idea.
- **Filler.** An issue that adds no behavior, fixes no bug, and documents nothing familiar. Delete or omit it.
- **Non-issues.** "Add a comment explaining X." Docs are useful — put them in `docs/`, not in issues.

## Procedure

1. Read `issues/` to find the item.
2. Edit the file text directly — the text is the prompt. Optional `key: value` header lines set metadata. Keep the prompt tight; put narrative in the body.
3. Nobody moves files by hand inside a run: status moves are the harness's job after gates pass. Outside a run, move a file with `machine_code issue move <slug> <status>` (or `git mv`) and commit `issues/`.

## Research workflow: curating issues from investigation

When the research goal is to create a scoped feature/bug issue, the route is:

1. **Read the prompt and existing issues.** If the behavior is already described in a `features/todo/` or `bugs/todo/` issue, that is the work item — do not create a duplicate.
2. **Inspect the codebase** to understand the relevant area:
   - Start with a broad `inspect` (keyword or directory listing) to find the right files.
   - Then target specific symbols, patterns, and imports to understand the current behavior.
   - Check docs and references when the prompt names external APIs or patterns.
3. **Name the concrete delta.** What behavior changes? What files will the engineer touch? This does not need to be a precise edit list — `"the issue screen status line needs to show the run phase"` is enough — but it must name the observable change.
4. **Write the issue.** Follow the file shape above. Every feature/bug needs `acceptance:` and a body that describes the behavior change, not the implementation.
5. **If you cannot name the change** (behavior is too vague, area is too complex), record an `ideas/<slug>.md` and finish as completed. The planner can research further.