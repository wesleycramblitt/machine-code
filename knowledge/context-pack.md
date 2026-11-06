# Curated context

The context window is a resource. The harness maximizes **useful** context
without guessing which files the task needs.

## Rule

```
inputBudget = model.contextWindow - outputReserve - providerReserve
```

Price is a soft limit. Record the cost and warn when a run is unusual; never
drop a task-critical byte to save a few cents. One large cached call is cheaper
than many small calls that re-acquire the same bytes.

## Layers

### Curated sources

The TUI composer is the curation surface. It selects:

- the issue hierarchy and each issue's explicit `mc:context` files
- knowledge files
- references
- skill descriptions and bodies
- tools and scripts
- plans
- the prompt/task packet

The composer has a few defaults: plans, `knowledge/index.md`, skill
descriptions, commands, the repo map, and the semantic index. Everything else
is an explicit choice.

### Always-on indexes

- repo map: paths, languages, line counts, top-level symbols
- semantic index: module summaries, key files, deps, edit hints
- knowledge index
- commands and tool schemas
- current run state and recent steps

The model reads, searches, or expands a symbol when it needs more. The harness
does not preload files, infer tests, expand imports, add reverse dependencies,
or score knowledge notes behind the scenes.

### Planning runs

A Planner researches first, then chooses specific issue context files and
passes them with `context_files`. The issue tool records that explicit list in
`mc:context`. Build receives exactly that list plus the curated composer
context. Nothing is inferred from issue prose.

## Budget and warnings

Context is ordered by priority. It is not clipped by per-file caps.

- At 80% of the selected model's input budget, the composer shows a warning.
- At 100%, it shows an over-budget warning.
- The runner records `context_warning` and names any omitted or truncated
  source in `context.json`.
- A single huge curated file is a warning, not an automatic outline swap.

The only hard ceiling is the model's input window. The user decides what to
remove.

## Tool selection

The prompt carries a short policy: use the most direct tool first.

| Job | First choice | Then |
|---|---|---|
| Locate a symbol | `search auto` (symbols) / outline | `rg` text |
| Expand a symbol | `context expand path#symbol` | read symbol + imports + callers + tests |
| Read code | symbol | full file if small |
| Read non-code | section | full file if small |
| Read a huge unindexed file | offset page | — |
| Search text | `rg` / `git grep` | — |
| Search structure | `ast-grep` | LSP references |
| Edit | exact-match edit | `write` for a new file |
| Verify | packet acceptance command | profile command |
| Repeat work | `artifact` create/run (build/sudo) | rerun command |

Offset paging is a fallback for a large file the index cannot address. It is
not the default reading tool.

## Current status

Implemented:

- `src/context/assemble.ts` — single source of truth for the prompt context;
  no task pack, no automatic file assignment.
- `src/context/budget.ts` — model-derived input budget.
- `src/context/preview.ts` — TUI preview of curated sources and real file sizes.
- `src/context/render.ts` — context + ledger + state + recent steps.
- `src/loop.ts` — records the actual prompt size, model budget, ledger size,
  and `context_warning` when curated context does not fit.
- `machine_code context <run-id>` prints the assembled context and ledger.
- `machine_code pack` previews the curated run context before a run.
- `issues` `context_files` parameter — Planner-selected files go into
  `mc:context`; no inference.
- `read { symbols: [...] }` and `read { sections: [...] }` for a targeted sweep
  in one call; `read { section }` supports Markdown headings and comment
  banners. `read` treats a past-end page as an error.
- `edit { symbol|section, edits: [...] }` scopes exact matches and applies
  several hunks atomically in one call.
- `src/tools/policy.ts` — the always-in-context tool-selection guide.
- Evidence ledger in `src/context/state.ts`: exact read bytes are kept for the
  run, unchanged re-reads return from cache, and an edit drops the file's
  entries.
- Evidence-novelty loop detector in `src/state/progress.ts`: repeated reads of
  one band at the same file version, repeated search result sets, repeated
  command output, or repeated failures kill the run after twenty stale actions or the same tool error in three turns.
  It is the only loop guard.
- Build and sudo have the `artifact` tool with `artifact:provision`; the
  implement and unrestricted presets set `artifact_scripts = true`, so a
  repeated probe or gate can become a reusable script in the run.

## Measurement

`machine_code eval <run-id>` prints the scorecard: model/tool calls, tokens by
kind, cost, peak context, ledger size, wall time, changed paths, gates, and
loop reason. Use `--baseline <run-id>` for deltas and `--max-calls`,
`--max-cost`, `--max-tokens`, or `--max-context` as CI limits. The same metrics
come from `src/report/run.ts` (`runMetrics`).

Next:

- a routing layer that auto-selects the best tool for a request;
- planner staging: curated overview, then per-stage detail.
