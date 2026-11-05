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
- **Run loop** (`src/loop.ts`): turn budget, token budget, evidence-novelty
  loop detector, retries, final-answer fallback, semantic refresh scheduling.
- **Context** (`src/context/`): issue hierarchy, packets, knowledge files,
  plans, skills, tool index, run-state rendering, model-derived budgets
  (`budget.ts`), the task context pack (`pack.ts`), and manifest/provenance.
- **Selection** (`src/select.ts`, `src/catalogue/`): capability floors, cost,
  availability, provider multipliers, free/paid tiers.
- **Tools** (`src/tools/`): read/search/edit/write, typed commands, issues,
  artifacts, PRs, ask. There is no shell tool.
- **State** (`src/state/`, `src/context/state.ts`): run schema, events,
  transcript, facts, changes, issue memory, outcomes.
- **Map/semantic/LSP** (`src/map/`, `src/lsp/`): deterministic file/symbol
  inventory, module index, optional LLM annotations, language servers.
- **Orchestrator** (`src/orchestrate.ts`, `src/orchestrator/`): issue-backed
  scheduling, worktrees, gates, commit, review, PR.
- **Task lifecycle** (`src/tasks/lifecycle.ts`): one-task status, review
  checks, approval, closure, and worktree cleanup for both direct Build runs
  and Orchestrator runs. A Task closes only after its PR merges.
- **Feature publish** (`src/pr/feature.ts`): aggregate Feature Review, gates,
  Feature PR to main, and the Feature merge policy.

## Tool-call protocol

Tool-using roles use native structured tool calls from the provider API. The
provider returns `toolCall` blocks (or the provider-equivalent); the loop
executes them and returns tool results in the next request.

A text-only response that contains tool-call markup, or a tool call with
provider markup inside its arguments, is malformed. The loop records
`malformed_tool_call`, cools the model, and rotates to another model. If no
model remains, the run fails. It never marks that response completed.

Catalogue `toolCall` flags are metadata, not proof. OpenRouter rows infer the
flag from endpoint parameters. A model can accept `tools` and still return text
markup. See `knowledge/model-tool-calling.md` for the failure, the guard, and
the remaining probe work.

## Retrieval stack

1. **Git** gives the file set, head, and dirty paths.
2. **Repo map** gives paths, line counts, languages, and top-level symbols.
3. **Semantic/module index** routes a concept or filename to modules and key
   files. Large files get a file-level entry with keywords from their comment
   section headings. It is deterministic and always fresh; LLM annotations are
   optional.
4. **LSP** gives exact definition, references, hover, diagnostics, and rename
   for a file position. It backs `outline` with document symbols when a run's
   process supervisor is available. It is lazy and language-specific.
5. **Sections** lists comment headings inside one file for blocks that live
   inside one giant function and cannot appear in a top-level outline.

## Invariants

- Context is model-budgeted; every block has provenance in `context.json`.
- The prompt is the curated composer context plus the always-on indexes. There
  is no hidden task pack, semantic preload, inferred test list, dependency
  expansion, or knowledge-note scoring. The model reads/searchs for more.
- The Planner chooses issue context files after reading and records them with
  `context_files`; the issue tool writes `mc:context` from that explicit list.
- One logical change per tool call; read the smallest unit that justifies it.
- Tool calls are structured. Text tool-call markup is malformed; rotate models
  or fail, never complete.
- A Task is one deliverable: one file-level change, at most three acceptance
  criteria, and a body under 4,000 chars. Task bodies carry `## Context`,
  `## Deliverable`, and acceptance; runtime gates come from named acceptance
  commands or a `## Verification` section. Epic/Feature bodies carry
  `## Context`, `## Goal`, and `## Scope` (Feature also `## Success measures`). The issue tool
  rejects create/graph/body-edit requests that miss these sections. Context
  files come only from the explicit `context_files` parameter. Oversized Tasks
  are rejected before creation or build.
- Every terminal run has a summary, a stop reason, and a typed outcome.
- The only loop stop is evidence novelty: repeated reads of one band at the
  same file version, repeated search result sets, or repeated command output
  kill the run after twenty stale actions.
- A completed run stays completed even when a recoverable plan checkpoint fired.
- An edit invalidates only overlapping read ranges; read coverage carries
  artifact ids for recall.
- Exact read bytes stay in a run ledger. An unchanged re-read returns the
  cached bytes; an edit drops that file's entries; the prompt includes acquired
  bytes not already in the curated context.
- A read that returns only an outline or a past-end note never becomes read
  coverage.
- The deterministic semantic index persists to `semantic.json`; module edges
  come from resolved TS/JS imports. LSP remains the exact symbol layer.
- Read-only commands are cached until the next edit, write, or mutating command.
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
