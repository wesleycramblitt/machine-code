commit: 9ea8c6b6172d57e9d955f0a7d0d09213cd9a3124
priority: high
files: src/tasks/issue.ts, src/state/outcome.ts, src/plan/issues.ts, src/orchestration/scheduler.ts
tags: orchestrator, lifecycle
acceptance: script:build
keywords: blocked, Blocked, ENGINEER_WORK_STATUSES, outcome, blocked run

# Stop re-dispatching an issue whose run ends blocked

## Problem

When the orchestrator runs an issue and the run ends with outcome `blocked`
(a hard failure — `src/state/outcome.ts:20` maps run status `blocked` to
outcome `blocked`), the issue stays in `todo/` and is re-dispatched on the
next orchestrator tick. This spams runs on the same issue forever.

Today nothing moves an issue into `blocked/`. `blocked` is a legal engineer
status directory (`src/plan/issues.ts:44-51`) and the TUI already renders it
(`src/tui/screens/tones.ts:29`), but `ENGINEER_WORK_STATUSES`
(`src/plan/issues.ts:56-61`) still lists `blocked`, so the orchestrator's
`runnableIssues` (`src/orchestration/scheduler.ts:105`) treats a blocked
issue as dispatchable. The runs page never shows these issues as blocked.

## Behavior change

1. When a run on a feature or bug issue ends with outcome `blocked`, move
   that issue from its current status into `blocked/` automatically. The
   transition primitive already exists: `moveIssue` (`src/plan/issues.ts:656`).
2. A feature/bug issue whose status is `blocked` must never be picked up by
   the orchestrator until a human unblocks it. Remove `blocked` from
   `ENGINEER_WORK_STATUSES` so `runnableIssues` no longer includes it.
3. Unblock is human-only. Nothing should auto-move a blocked issue back to
   `todo/` when dependencies complete — that is a separate concern (manual
   unblock).

## Where to wire it

- Locate where a run result drives issue status transitions. This is the
  lifecycle area in `src/tasks/issue.ts` and `src/plan/issues.ts`. Hook the
  blocked outcome there: on blocked run end, call `moveIssue(layout, slug,
  "blocked")`.
- Remove `blocked` from `ENGINEER_WORK_STATUSES` in `src/plan/issues.ts`.
  Confirm `runnableIssues` in `src/orchestration/scheduler.ts` (which reads
  that constant) then excludes blocked issues.

## Verification

- A feature/bug issue whose latest run ends `blocked` is moved into
  `features/blocked/` or `bugs/blocked/`.
- The orchestrator does not start a new run for that issue on subsequent
  ticks.
- A manually `todo`-status issue is unaffected.
