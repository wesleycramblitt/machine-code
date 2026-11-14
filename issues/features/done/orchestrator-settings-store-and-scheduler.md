commit: 8230896237b58f58e7030344f942906724c8dc74
files: src/orchestration/store.ts, src/orchestration/scheduler.ts
tags: orchestration
acceptance: script:build
keywords: orchestration, orchestrator, minFit, processes, runnableIssues

# Orchestrator settings store and issue scheduler

Repo-level orchestration (the other two orchestration issues build on this) needs a headless core the TUI can drive. This issue adds that core with no UI and no run spawning — build-only, `tsc` passes.

Add `src/orchestration/store.ts`: persisted orchestrator state per repo at `.machine_code/local/orchestrator.json` (that is `layout(repoRoot).localDir`, gitignored — see `src/paths.ts:31-46`). Shape:

- `settings`: `{ processes: 1 | 2 | 4 | 8, tier: "paid" | "local", engineerMinFit: number, researchMinFit: number }`. MinFit values ride the 4–8.5 ladder in 0.25 steps (exactly `NEW_RUN_MIN_FITS`, `src/tui.ts:116-119`). The TUI displays the paid tier as "cloud"; store the run-system values `"paid" | "local"` (the only tiers `run --tier` and the composer accept, `src/tui.ts:490`) so spawned args stay valid.
- `active: boolean` — whether the orchestrator is running for this repo.
- `startedRunIds: string[]` — a ledger of run ids the orchestrator started for this repo, so counters and slot math only count orchestrator-started runs.

Read/write helpers with merge-on-write: partial updates (settings change, flag change, ledger append) must not clobber other fields. Missing or corrupt file degrades to defaults (`processes: 1, tier: "paid", engineerMinFit: 6, researchMinFit: 6, active: false`) — never throw on read.

Add `src/orchestration/scheduler.ts`: pure functions over data the caller loads (issues + runs). No fs access — this keeps them testable and reusable by the loop issue:

- `orchestratorCounters(runs)`: `{ running, awaiting, failed }` over orchestrator-started runs. running = active non-awaiting states (created/running/paused/interrupted per `isActiveStatus`, `src/state/run-schema.ts:61-71`); awaiting = `"awaiting_input"`; failed = terminal failures (`"failed"` or `"blocked"`).
- `runnableIssues(issues, runs, startedSlugs)`: the ordered queue of next issues. A feature/bug qualifies when its status is in `ENGINEER_WORK_STATUSES` (`src/plan/issues.ts:56-61`); an idea only when status is `"researched"`. A dependency counts as satisfied exactly like `unmetDepends` (`done`, or a researched idea — `src/tasks/issue.ts:63-75`). Exclude any issue that already has an active run attached (`isActiveStatus` + `runItemId`, `src/plan/lifecycle.ts:24-45`) and any issue whose `files:` footprint overlaps a currently-running orchestrator issue via `overlapFootprints` (`src/plan/overlap.ts:66`) — the runner refuses concurrent overlapping work. Order: bugs, then features, then ideas (the orchestrator's priority order); priority then slug within a kind.
- `freeSlots(settings, runs, startedRunIds)`: `processes` minus active orchestrator-started runs for the repo, clamped at 0.

The hard-fail distinction lives in the run schema and needs no new state: acceptance-gate failures do not end a run (the run keeps working; the issue collects gate-failure notes via `appendIssueGateFailure`, `src/plan/issues.ts:354-381`), so only `isTerminalStatus` (`failed`/`blocked`, `src/state/run-schema.ts:74-78`) counts as a hard failure that frees a slot.

Leave `src/orchestrate.ts` (the old wrapper with the TODO at `:8`) untouched — this module replaces its intent, not its callers.
