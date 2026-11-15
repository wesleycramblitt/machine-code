# Periodic review of 50-100 runs for continuous improvement

After the dedicated run-data tool lands (see features/todo/dedicated-past-run-data-tool-for-agents.md), set up a planned, recurring review process: analyze a batch of 50-100 past runs to learn what improves the loop — where agents waste turns, which instruction patterns produce clean merges, which commands fail repeatedly, how long runs take per concern type, and how often acceptance gates fail. The review should be a planned feature, not ad hoc note-taking.

Direction to explore:
- A review run that agents run over a fixed window (e.g. the latest 50-100 runs of a repo) using the run-data tool, producing a findings report back into the issue tracker as concrete, scoped feature/bug ideas.
- A cadence (periodic, on a schedule or after N completed runs) and a trigger, so it actually happens instead of being remembered.
- What a useful report looks like: per-phase turn counts, gate-failure rates, tool-call patterns, and the specific next issue each finding becomes — so the review closes its own loop.
- Guardrails: read-only over history, no edits to past runs, bounded size so the review itself does not become a runaway run.

This is explicitly NOT implementation-ready — the boundary between "read historical runs and summarize" and "decide what to change" needs design. The run-data tool is the dependency; nothing else blocks it. Keep it as an idea until the tool exists and the review's output shape is agreed.