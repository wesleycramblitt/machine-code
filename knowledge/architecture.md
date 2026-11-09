# Architecture

## Purpose

machine_code runs one bounded agent loop per role. It is file-based, Linux-first,
and optimized for correctness per dollar. The harness owns context, tools,
state, selection, and gates; the model owns decisions and edits.

## Run lifecycle

1. `src/cli/run.ts` loads config, policy, catalogue, and providers, then
   creates or reuses a worktree and branch (`mc/<slug>`) for the issue.
2. `src/loop.ts` assembles context, builds the repo map, selects a model, and
   starts the tool loop.
3. Each turn renders the system prompt, assembled context, run state, and the
   **full transcript**. Nothing is pruned or summarized: a model keeps every
   result it fetched.
4. Tools act on the worktree: `context`, `read`, `write`, `edit`, `map`,
   `glob`, `grep`, `command`, `ask`, `artifact`, `skill`.
5. Gates run, the change is committed, and the issue moves to done/blocked.
   A human merges (`machine_code approve`, or `m` in the TUI).

## Layers

- **CLI** (`src/cli/`): commands, flags, run lifecycle, TUI.
- **Run loop** (`src/loop.ts`): turn and token budgets, evidence-novelty loop
  detector, retries, final-answer fallback. A retry that switches models
  carries the whole conversation into the new model.
- **Context** (`src/context/`): issue/knowledge/plan/skill assembly, run-state
  rendering, the durable ledger, and prompt rendering.
- **Tools** (`src/tools/`): read/write/edit, map/glob/grep, typed commands,
  context memory, ask, artifacts, skills. There is no shell tool.
- **Map** (`src/map/`): deterministic file/symbol inventory, semantic module
  index, and heading sections. LSP supplies exact positions when available.
- **Selection** (`src/select.ts`, `src/catalogue/`): capability floors, cost,
  availability, provider multipliers, free/paid tiers. Ollama is the final
  fallback. One model's 429 cools only that model, not the provider.
- **State** (`src/state/`): run schema, events, transcript, facts, changes.
- **Worktrees** (`src/worktree.ts`): one branch `mc/<slug>` per issue.

## Issues

- `issues/ideas/<slug>.md` (needs research) or `issues/ideas/.researched/`.
- `issues/features/{todo,blocked,done}/` and `issues/bugs/{todo,blocked,done}/`.
- A file is plain markdown whose text is the prompt. Optional `key: value`
  header lines (`priority`, `review`, `tags`, `depends`, `acceptance`) then a
  blank line. Status is the directory; delete an issue to remove it.

## Reading code

- A bare read of a file over 200 lines returns its outline, not content;
  follow with `symbol` or `around` for one block.
- `read { line_start, line_end }` (or `offset`/`limit`) pages a range.
- `allow_large: true` reads a whole file deliberately.
- `map`/`glob`/`grep` locate; `read` returns contents.

## Invariants

- The transcript is replayed whole; no compaction and no tombstoning.
- Every context block carries provenance in `context.json`.
- Gates are the issue's `acceptance` commands, or the repo's own build/check.
- The loop detector stops a run after repeated identical evidence with no
  edit/write/mutating command.
- Tools never act outside the worktree; secret and binary files are rejected.
