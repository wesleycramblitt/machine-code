---
name: issue-curation
description: Use when creating or updating issues under .machine_code/issues/. Issue files are markdown whose text is the prompt; status is the directory.
---

# Issue curation

`.machine_code/issues/` is the single work tree (local-only, never committed). Each file is one work item:

```
.machine_code/issues/
  ideas/<slug>.md              # needs research
  ideas/.researched/<slug>.md  # researched
  features/{todo,needs-human-review,failed-gates,failed-human-review,blocked,done}/<slug>.md
  bugs/{todo,needs-human-review,failed-gates,failed-human-review,blocked,done}/<slug>.md
  references/{todo,done}/<slug>.md
```

Status is a directory: the item's status is where it lives.

## File shape

Plain markdown. Optional `key: value` header lines at the top (only non-defaults), a blank line, then the prompt body. Pass header fields as `issue:create`/`issue:update` args and the body as `prompt`.

```
priority: high
tags: tui
files: src/tui/screens/run-detail/run-detail.ts
keywords: Run Details, Timeline
acceptance: script:build

# Short title

One paragraph of detail the prompt needs.
```

- **priority**: `low` / `medium` / `high` (default medium; omitted when medium).
- **tags** / **depends** / **files**: comma lists (optional).
- **files**: repo-relative paths or globs the issue expects to touch (e.g. `src/loop.ts, src/tools/*.ts`). The runner uses this to refuse concurrent same-file work and to require a `depends:` edge when two issues overlap.
- **keywords**: comma-separated phrases naming the exact UI strings, page names, or commands involved (optional; the runner matches these exactly to find files).
- **acceptance**: comma list of runner commands (`script:build`, `script:test`, ...). Every created feature/bug issue needs one.
- **status**: the directory. Ideas leave `ideas/` for `.researched/` when research finishes; features/bugs move between `todo`, `needs-human-review`, `failed-gates`, `failed-human-review`, `blocked`, and `done` (the harness owns status moves during builds). There is no archived status: a human deletes an unwanted issue with `issue:delete`; never create filler to delete.

## Writing good issues

An issue is work for the engineer. Every issue must pass these tests:

**Features** — What behavior changes? What does it replace? How will you know it is done? The body should make the deliverable obvious. `acceptance:` names the verification commands.

**Bugs** — What fails, how to reproduce it, what is expected. Include error output or exact steps.

**Ideas** — A direction to explore. No acceptance needed — they are not implementation-ready. A sub-idea you create must still name its slice, why it splits there, and the artifact shape the next run should produce.

### Anti-patterns

These waste turns. Do not create them.

- **Mirroring.** If the idea is "add settings caching" and the issue says "add settings caching" with no delta, you added nothing. Value comes from *why* it matters, *what* changes, and *how* to verify it.
- **Implementation instead of behavior.** "Add an AppConfig class with load/save methods" tells how, not what. "Settings persist across restarts and load lazily" tells what — the engineer chooses the how.
- **Vague scope.** "Refactor the layout engine" — what is wrong with it? What does success look like? If you cannot name the files or acceptance, the idea is not triaged yet: run the deep path below, do not write.
- **Filler.** An issue that adds no behavior and fixes no bug. Omit it — `issue:delete` is human-only.
- **Non-issues.** "Add a comment explaining X." Omit it — commentary is not a work item.

## Procedure

1. Find the item with `issue:list`, then read it with `issue:show`.
2. Create with `issue:create` and change with `issue:update`. Pass the header fields as command args and the prompt as `prompt`. Never raw-write or raw-edit `.machine_code/issues/` with `write`/`edit` or `core:*` commands, and never call `issue:delete` (human-only).
3. Never update the run's own issue: the harness owns its status and body. Other issues may be created or changed, including status moves.

## Curating issues from investigation

Triage the idea in one pass, then run the matching path. Thoroughness lives in decomposition, never in repeated investigation.

**Triage.** Read the idea and run `issue:list` once for duplicates. Then decide:

- **Fast path** — the idea names the behavior and the affected area, with no open scope decisions. Go: read, anchor, write, finish. No questions. Most ideas run here.
- **Deep path** — vague (a few words, no specifics), compound (several behaviors), or multi-system (three or more file groups). Go: one investigation pass, decompose into fast-path-sized pieces, scope-check each piece, write.
- **Massive scope** — the idea is a project, not a task ("rebuild the TUI", "multi-account support"). Do not emit dozens of premature features from a shallow read. Go: split into sub-ideas below, one per slice, and finish. Other architect runs take it from there.

Zero features is a valid result on any path: if the answer already exists or nothing should change, finish with the finding. Thoroughness lives in decomposition, never in repeated investigation.

### Investigate (both paths, bounded)

1. **Read the prompt and existing issues.** If the behavior is already described in a `features/todo/` or `bugs/todo/` issue, that is the work item — do not create a duplicate.
2. **Inspect the codebase** to understand the relevant area:
   - Start with a broad `inspect` (keyword or directory listing) to find the right files.
   - Then target specific symbols, patterns, and imports to understand the current behavior.
   - Check docs and references when the prompt names external APIs or patterns.
   - Batch independent queries in one message. One concern per query.
3. **Stop rule.** One investigation pass answers one round of doubt. A doubt answerable from reads already done is decided, not open — never re-read a decided point "to be sure." When every planned piece can name files + anchors, investigation is over.

### Scope check (per piece, the requirements core)

For each candidate piece, name the decisions that can change its scope, files, or acceptance — at most three. Then:

- Never ask what the repository already answers: read first, ask only what reads cannot settle (a decision that changes scope/files/acceptance, no observable delta, overlapping pieces, or a guess you would otherwise have to make).
- Ask one question at a time, two or three options, with a recommendation. Restate each answer in one sentence and record it as a note and as a constraint in the piece.
- Re-clarify a piece at most once. The next doubt gets decided and recorded as an assumption, not re-investigated. When `ask` is unavailable, decide from evidence and conventions the same way.
- Prefer the smallest scope that meets the request.
- **Ready means ready.** Run the ready list twice: if the second pass finds nothing new, write. "Exact files" means the engineer can *start* without searching — paths or globs plus entry points — not line-perfect precision.

### Splitting massive scope (sub-ideas)

When the idea is a project, not a task, write sub-ideas — one per slice, each narrow enough for a single architect run to turn into features. Each sub-idea must:

- Name the exact slice of the parent it covers and why it splits there.
- State the artifact shape the next run should produce (features, bugs, or further splits).
- Carry the same anti-pattern bar: no mirroring the parent, no vague scope passed downstream.

Recursion guard: a sub-idea must be strictly narrower than its parent — never restate it. If your own issue was itself a split-off, prefer features over further splits. Two levels max: idea → sub-ideas → features. Sub-ideas carry no `files:`/`acceptance:` — those belong to the features the next run writes.

### Write (per piece)

1. **Map files to issues before writing anything.** List which files each issue will touch. Overlapping footprints MUST be ordered with `depends:` — narrower or foundational first — because parallel branches editing the same files cannot auto-merge. Disjoint footprints stay parallel (no `depends:`). Same rule for follow-ons: schema/record first, then the code that uses it; migration first, then callers; API first, then client. `issue-curation:verify` rejects overlapping `files:` without a `depends:` edge.
2. **Name the concrete delta.** What behavior changes? What files will the engineer touch? `"the issue screen status line needs to show the run phase"` is enough — but it must name the observable change, with file:line anchors for the current state.
3. **Create each issue** with `issue:create`. The body must let the engineer implement without re-reading the idea or re-mapping the repo: exact files, current state with anchors, the full change, and the recorded decisions. If the engineer would have to investigate to start, the piece is not ready — back to scope check, not forward to write.
4. Placeholders are rejected twice (the tool, then the gate): `slug` is required (never `untitled`), `prompt` ≥ 200 chars and never the slug restated, `files:` + `acceptance:` required. If a call is rejected, do not retry thin content — investigate or ask once, then write once it is real.

### Decomposition guidelines

- **One concern per issue.** The count follows the scope — one issue or twenty. Decompose until each piece is one behavior change in one file group, then stop. The body of each should be richer than the original idea text, not a summary of it. A single issue spanning a broad glob (e.g. `src/tools/*.ts` plus two more groups) or naming three or more file groups is not decomposed — split it until each piece names its own files and its own acceptance.
- **Name the dependency chain** with `depends:` when features build on each other. Features with no interdependencies can be built in parallel — mark them without `depends:`.
- **Same files means sequence, not parallel.** `issue-curation:verify` rejects the run on overlapping footprints without an edge, and the build/run harness refuses a dependent issue until its deps are done.
- **Copy the full context from the original prompt** into each feature body where it applies. Don't make the engineer cross-reference the idea file.
- **Each feature issue should be independently verifiable.** If you cannot describe how to verify it in one sentence, the scope is too large — split further.
- **Size for 5–10 engineer calls.** One issue = what an engineer finishes in a handful of calls: read the bodies, edit, finish. Two or more behaviors, three or more file groups, or a change you cannot anchor to exact files means split, not a bigger issue.
