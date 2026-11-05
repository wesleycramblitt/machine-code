# machine_code — repository knowledge

machine_code is a Linux-first coding-agent harness. One run is one role
(general, planner, build, review, architect) with a bounded tool loop, a
file-based run directory, and explicit outcome/verdict lines. It optimizes
correctness per dollar, not maximum autonomy.

## Start here
- README.md — user-facing behavior and config.
- knowledge/architecture.md — runtime flow, module map, invariants.
- knowledge/model-tool-calling.md — native calls, markup and argument repair.
- knowledge/run-failures-2026-11-05.md — four-run incident and fixes.
- plans/plan.md — remaining work and open validation.
- src/ — TypeScript source. test/ — node:test suites. data/ — prompts,
  agents, models, offers. .machine_code/ — repo policy and skills.

## Runtime flow
CLI (`src/cli.ts`) → run loop (`src/loop.ts`) → context assembly
(`src/context/assemble.ts`) → model selection (`src/select.ts`) → tools
(`src/tools/index.ts`) → run recorder (`src/state/runs.ts`) → TUI/report.

## Where to look
- Prompts/roles: `data/prompts/base.md`, `data/agents/*.toml`, `src/agents/config.ts`
- Tools: `src/tools/index.ts`; issues: `src/tools/issues.ts`, `src/issues/`
- Repo map/semantic: `src/map/`; LSP: `src/lsp/`
- State/outcomes: `src/context/state.ts`, `src/state/`
- Tool-call validation: `src/state/tool-call-text.ts`, `src/loop.ts`,
  `src/catalogue/openrouter.ts`
- Orchestrator/PR: `src/orchestrate.ts`, `src/orchestrator/`, `src/pr/`
- Tests: `npm test` (builds first), `npm run build`

## Invariants
- No shell tool; commands are typed specs (`src/commands/registry.ts`).
- Context is bounded and provenance is recorded in `context.json`.
- Run state is the memory; earlier tool output is not replayed.
- Tool calls are structured. Text tool-call markup is a malformed response;
  the loop cools the model and rotates, or fails. It never completes.
- Every terminal run has a deterministic summary and a typed outcome.
- Prompts use ASD-STE100: short, active, one idea per sentence.
