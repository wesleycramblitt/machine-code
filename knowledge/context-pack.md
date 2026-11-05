# Task context pack

The context window is a resource. The harness maximizes **useful** context, not
the number of tokens and not a fixed character cap.

## Rule

```
inputBudget = model.contextWindow - outputReserve - providerReserve
```

Price is a soft limit. Record the cost and warn when a run is unusual; never
drop a task-critical byte to save a few cents. One large cached call is cheaper
than many small calls that re-acquire the same bytes.

## Layers

Every turn has two layers.

### Always-on overview

- task/packet, goal, constraints, acceptance, gate commands
- plan and current stage
- repo map: paths, languages, line counts, top-level symbols
- semantic index: module summaries, key files, deps, edit hints
- knowledge index; full knowledge only when referenced or selected
- tools, commands, scripts, inputs/outputs
- current run state and recent steps

The overview is assembled up to 64k characters, then trimmed to the selected
model's budget in priority order. The lowest-priority blocks are named as
omitted. A large model gets the whole overview; a small model gets the packet,
task, and other high-priority blocks first.

### Task-specific pack

`src/context/pack.ts` builds this from the task, active plan, and repo map.

Priority:

1. task-named files and inferred tests, whole when they fit
2. plan-named files
3. relevant knowledge notes (keyword-scored; the index is already in the overview)
4. one-hop imports and reverse dependencies
5. for a large file: outline, named section, and bodies of symbols the task or
   plan names (at most six)
6. test tail for append-heavy test files
7. command and artifact inventory
8. acceptance gates
9. tool-selection guide

It does not include all dependencies whole. A small dependency (under 8k
characters) is included whole; a larger one gets its outline. The model reads a
named symbol only when it needs the body.

## Rendering

The renderer sorts by priority and fits the pack to the selected model. It
keeps a stable order so the provider cache can reuse the prefix. It reports
what it omitted and why. A task-named file is never silently clipped: if it
does not fit, its outline and edit regions are kept and the omission is named.

## Tool selection

The pack carries a short policy: use the most direct tool first.

| Job | First choice | Then |
|---|---|---|
| Locate a symbol | `search auto` (symbols) / outline | `rg` text |
| Read code | symbol | full file if small |
| Read non-code | section | full file if small |
| Read a huge unindexed file | offset page | — |
| Search text | `rg` / `git grep` | — |
| Search structure | `ast-grep` | LSP references |
| Edit | exact-match edit | `write` for a new file |
| Verify | packet acceptance command | profile command |
| Repeat work | artifact script | — |

Offset paging is a fallback for a large file the index cannot address. It is
not the default reading tool.

## Current status

Implemented:

- `src/context/budget.ts` — model-derived input budget.
- `src/context/pack.ts` — task/symbol-aware pack and budget-aware renderer.
- `src/context/render.ts` — overview + pack + state + recent steps; trims the
  overview to the selected model's budget in priority order.
- `src/loop.ts` — build/rebuild the pack for Build, Sudo, Review, and Planner;
  fit it to the selected model; record pack size and input budget in
  `context_state`.
- `read { symbols: [...] }` and `read { sections: [...] }` for a targeted sweep
  in one call; `read { section }` supports Markdown headings and comment
  banners. `read` prefers symbol/section and treats a past-end page as an error.
- `edit { symbol|section, edits: [...] }` scopes exact matches and applies
  several hunks atomically in one call.
- `src/tools/policy.ts` — the always-in-context tool-selection guide.
- Evidence ledger in `src/context/state.ts`: exact read bytes are kept for the
  run, unchanged re-reads return from cache, an edit drops the file's entries,
  and the renderer includes acquired bytes not already in the task pack.
- Evidence-novelty loop detector in `src/state/progress.ts`: repeated reads of
  one band at the same file version, repeated search result sets, or repeated
  command output kill the run after twenty stale actions. It is the only loop
  guard.

Next:

- a routing layer that auto-selects the best tool for a request;
- planner staging: overview pack, then per-stage detail.
