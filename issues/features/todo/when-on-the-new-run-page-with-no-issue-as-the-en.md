---
priority = "medium"
prompt = "When on the new run page with no issue as the engineer agent, we should be able to specify bug vs feature and priority and tag"
review = "none"
---

# when-on-the-new-run-page-with-no-issue-as-the-en

Auto-created from run.

When on the new run page with no issue as the engineer agent, we should be able to specify bug vs feature and priority and tag

## Context

Relevant files:
  - src/issues/work.ts (16 symbols)
  - src/tui.ts (98 symbols)
  - src/tui/status.ts (31 symbols)
  - src/agents/config.ts (26 symbols)
  - src/cli.ts (78 symbols)

## Architecture

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
   `context`, `issue`, `issue_graph`, `artifact`, `pr`, `ask`.
5. `src/state/runs.ts` records events, usage, changes, and the final summary.
6. `src/state/outcome.ts` derives a deterministic summary and stop reason.

## Layers

- **CLI** (`src/cli.ts`): commands, flags, TUI, run/report entry points.
- **Run loop** (`src/loop.ts`): turn budget, token budget, evidence-novelty
  loop detector, retries, final-answer fallback, semantic refresh scheduling.
- **Context** (`src/context/`): issue hierarchy, packets, knowledge files,
  plans, skills, tool index, run-state rendering, model-derived budgets
  (`budget.ts`), and manifest/provenance.
- **Selection** (`src/select.ts`, `src/catalogue/`): capability floors, cost,
  availability, provider multipliers, free/paid tiers. Free cloud offers and

## Skills

  - clean-code: Use when writing, refactoring, or reviewing code. Apply by default when producing or changing code.
  - knowledge-curation: Use when curating repository knowledge files. Create and maintain index.md and topic files in knowledge/ directories.
  - plan-curation: Use when creating or updating issues under issues/. Items are YAML issue files whose status is the directory.
  - reference: Use when asked to gather, index, or read attributed reference bundles from the central store.
  - requirements: Use when a request is large or ambiguous. Clarify one decision at a time, then choose one scope.
  - safe-refactor: Use when restructuring code without changing behavior. Keep gates green on every step, one small move at a time.
  - systematic-debugging: Use when a test, gate, or bug fails. Reproduce, find the cause, fix the cause, and prove it.
  - verified-testing: Use when verification is verified or higher. Encode each acceptance criterion as a failing test first, then implement.
