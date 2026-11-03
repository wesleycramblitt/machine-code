# Architecture

## Purpose

machine_code runs one bounded agent loop per role. It is file-based, Linux-first,
and optimized for correctness per dollar. The harness owns context, tools,
state, selection, and verification; the model owns decisions and edits.

## Run lifecycle

1. `src/cli.ts` loads config, policy, catalogue, and providers.
2. `src/loop.ts` assembles context, builds the repo map and semantic index,
   selects a model, and starts the tool loop.
3. Each turn renders a fresh prompt from run state, the last step, and the
   bounded context bundle. Earlier tool output is not replayed.
4. Tools act on the worktree: `read`, `search`, `edit`, `write`, `command`,
   `context`, `issue`, `artifact`, `pr`, `ask`.
5. `src/state/runs.ts` records events, usage, changes, and the final summary.
6. `src/state/outcome.ts` derives a deterministic summary and stop reason.

## Layers

- **CLI** (`src/cli.ts`): commands, flags, TUI, run/report entry points.
- **Run loop** (`src/loop.ts`): turn budget, token budget, guards, retries,
  final-answer fallback, semantic refresh scheduling.
- **Context** (`src/context/`): issue hierarchy, packets, knowledge files,
  plans, skills, tool index, run-state rendering, manifest/provenance.
- **Selection** (`src/select.ts`, `src/catalogue/`): capability floors, cost,
  availability, provider multipliers, free/paid tiers.
- **Tools** (`src/tools/`): read/search/edit/write, typed commands, issues,
  artifacts, PRs, ask. There is no shell tool.
- **State** (`src/state/`, `src/context/state.ts`): run schema, events,
  transcript, facts, changes, issue memory, outcomes.
- **Map/semantic/LSP** (`src/map/`, `src/lsp/`): deterministic file/symbol
  inventory, module index, optional LLM annotations, language servers.
- **Orchestrator** (`src/orchestrate.ts`, `src/orchestrator/`): issue-backed
  scheduling, worktrees, gates, review, commit, PR.

## Retrieval stack

1. **Git** gives the file set, head, and dirty paths.
2. **Repo map** gives paths, line counts, languages, and top-level symbols.
3. **Semantic/module index** routes a concept or filename to modules and key
   files. It is deterministic and always fresh; LLM annotations are optional.
4. **LSP** gives exact definition, references, hover, diagnostics, and rename
   for a file position. It is lazy and language-specific.

## Invariants

- Context is bounded; every block has provenance in `context.json`.
- Run state is the memory; the transcript is not replayed.
- One logical change per tool call; read the smallest unit that justifies it.
- Every terminal run has a summary, a stop reason, and a typed outcome.
- Prompts use ASD-STE100 and end with the role's typed terminal line.

## Configuration

- `~/.machine_code/config.toml`: machine-level selection, providers, map,
  context, issues, theme.
- `.machine_code/policy.toml`: committed per-role floors, turns, budgets.
- `data/`: shipped prompts, agent deltas, models, offers, defaults.
- `knowledge/`: English-language repository knowledge. `knowledge/index.md` is
  included in context by default when present.

## Testing

- `npm run build` type-checks and emits `dist/`.
- `npm test` builds, then runs `node --test`.
- Prefer small, deterministic tests with temp repos and fake providers.
- Live checks use real models, real GitHub issues, and disposable worktrees.
