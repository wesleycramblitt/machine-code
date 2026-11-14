priority: high
tags: orchestration, tui
depends: orchestrator-settings-store-and-scheduler, orchestration-page
files: src/orchestration/loop.ts, src/tui.ts, src/tui/runs.ts, src/tui/screens/runs-list.ts
keywords: Orchestrating, setInterval, launch, run --item, purple badge
acceptance: script:build

# Orchestrator keeps runs moving

Turn the orchestration page's Start flag into a live scheduler inside the TUI process — the answer to "what does running mean": the orchestrator keeps N processes busy on the repo's unblocked issues without human input.

Scheduling loop (tick logic in a new `src/orchestration/loop.ts` kept narrow; wiring in `src/tui.ts` next to the existing setInterval probes at `:1708-1717` — a faster tick, ~5s, only while active):

- Each tick: re-read the store (so live setting edits apply), list the repo's issues (`listIssues`) and runs (`listRuns`/`listAllRuns`), compute `freeSlots` and the queue via `runnableIssues` (both from the store/scheduler issue).
- For each free slot, take the next issue and spawn a run attached to it with the existing detached-child pattern `launch()` (`src/tui.ts:225-241`): `["run", "--agent", agentForIssue(issue), "--tier", settings.tier, "--min-fit", <minFit for that role>, "--item", issue.slug]` — mirroring `buildNewRunArgs` (`src/tui.ts:683-713`). The run picks its own model from `--tier`/`--min-fit`; the orchestrator never passes `--model`. Append the run id to the store's `startedRunIds` ledger once the run record exists.
- Keep moving: when a run hard-fails (`isTerminalStatus` failed/blocked) or sits `awaiting_input`, its slot frees and the next unblocked issue starts. Awaiting runs are left running — the human can answer them through the normal answer flow; the orchestrator simply starts other work in the freed slot. Acceptance-gate retries never end a run, so they never trigger this. Completed runs just free their slot too.
- Nothing runnable (all remaining issues blocked by unsatisfied `depends` — `done` or a researched idea satisfies, `src/tasks/issue.ts:63-75`) — the orchestrator idles at its tick, starting nothing until dependencies satisfy or slots free.
- Stop at any point: clear the store's `active` flag and stop ticking. Running children are NOT killed — they finish on their own as normal tracked `run` processes; the orchestrator just stops scheduling. Reopening the page and pressing Start resumes scheduling with the persisted settings.
- Setting edits (processes, tier, minFits) take effect on the next run the orchestrator starts — the tick re-reads the store every pass, so no restart is needed.

Indicator: while the orchestrator is active for a repo, the runs page shows an `Orchestrating…` badge with a purple background (`PURPLE_BG` + `WHITE`, `src/tui/format.ts:61,68`) to the right of that repo's name so it stands out. Render it on the repo row — `pushRepo` builds the label at `src/tui/runs.ts:239-253`, `renderRunsList` draws it at `src/tui/screens/runs-list.ts:42-157`; the active flag comes from the store keyed by `repoRoot`. Repos without orchestration are unchanged.
