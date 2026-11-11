priority: high
tags: tui,runs,logging
acceptance: script:build
keywords: New Run, Run Details, waiting on the run to start, starting
todo:
  - [x] Emit start_requested / worktree_failed / start_failed / run_started events + RUN slug log line in src/cli/run.ts
  - [x] Surface start_failed + timeout/retry/cancel affordance in TUI timeline + run-detail waiting page
  - [x] Finish

todo:
  - [ ] Reproduce and collect 2-3 sample stuck runs (events.jsonl + run.json)
  - [ ] Implement server-side instrumentation to log run start attempts and failures, and ensure timeline events are flushed for the TUI
  - [ ] Update the TUI "waiting"/New Run flow to surface errors, timeline events, and show a timeout + retry/abort affordance
  - [ ] Finish

# New runs in the TUI sometimes hang on the "waiting" screen without errors

Problem

On some repositories the TUI's New Run / waiting page remains stuck showing that the run is "waiting on the run to start" (or similar) but the run never actually proceeds. There are no visible errors in the UI and no clear diagnostic logs exposed to the user. This makes debugging and triage very difficult — the run may have failed to start (worktree, processes, or orchestrator) or been dropped without any observable signal.

Why this matters

- Users cannot tell whether the run is queued, failed to start, or is actively stuck.
- The lack of diagnostics hides systematic errors (worktree creation, process supervisor, orchestration handoff).
- The same bug can affect reproduction of the bug report itself.

What to do

This bug requests adding both server-side instrumentation and UI improvements so a stuck run is diagnosable and actionable.

Implementation suggestions

1. Server-side instrumentation
   - Emit clear run start attempts and failures to the run's event stream and logs. Candidate places: src/cli/run.ts, src/orchestrate.ts, src/processes/supervisor.ts, src/worktree.ts, and any code paths that create/run worktrees or spawn processes.
   - Ensure the run's state and timeline (events.jsonl) always receives an event for: start_requested, start_failed (with error), worktree_created, worktree_failed, process_spawned, process_failed, and run_started. Include error messages and stack traces when available.
   - Where appropriate, record a per-run debug flag or enlarged event detail when a run is created with a debug/verbose option.

2. TUI surface changes
   - The New Run waiting page and run-details timeline should surface any start_failed events and display their message and a hint to view per-run logs.
   - Detect prolonged "starting"/"waiting" states (configurable timeout, e.g. 30s-2m) and show an actionable UI: "Run didn't start — view logs / retry / cancel".
   - Make timeline rendering more prominent on the waiting page so the first events (start_requested, worktree_created, run_started) are visible.
   - Candidate TUI files: src/tui/screens/run-detail/*, src/tui/timeline.ts, src/tui/screens/composer/composer.ts (if composer-new-run uses same component).

3. Developer tooling and debugging
   - Add a non-verbose default log entry when a run is created with a link/slug to open run details (e.g. "RUN {slug}").
   - Provide a developer-only switch to enable per-run debug logs (writes more detailed events into events.jsonl).

Acceptance criteria

- When a run fails to hand off into execution there is a recorded event in the run's events.jsonl and an explanatory message visible in the TUI waiting page or run details timeline.
- The TUI shows a clear timeout + retry/abort UI after a configurable delay if the run remains in "starting/waiting" without progress.
- Tests/build succeed (script:build) and the feature is wired so maintainers can reproduce the issue and observe the added events in sample runs.

Notes

- This item focuses on diagnostics and user-visible behavior; fixing the root cause(s) that prevent runs from starting is likely a follow-up once actionable logs reveal the common failure modes.
- If a single root cause is found (e.g. worktree creation race), open a more targeted bug to fix it and link that issue from this one.
