commit: b7b3c7fe21fd24e38dbeff1a58df9c1377c35f29
priority: high
files: src/tools/index.ts, src/tools/run-data.ts
tags: tools, agents
acceptance: script:build
keywords: readRun, listRuns, Run Summary, past runs, run data

# Give research and engineer agents a dedicated tool to read past runs

Research and engineer agents cannot currently read past run information from inside a run. The run data readers (`listRuns` and `readRun`, `src/state/runs.ts:519-557`) are not exposed as in-run tools — `run:list` and `run:show` are CLI commands only (`src/cli/runs.ts`, `src/commands/runs.ts`), not available to an agent mid-run. We will be analyzing past runs (see the periodic-review idea), so agents need a controlled, read-only window into them.

What changes: a new in-run tool that lists and reads past runs for the research and engineer agents, without giving them wildcard filesystem access to the run directory. The tool is intentionally narrow: it offers exactly (a) a list of runs with their summaries (id, agent, status, item, startedAt — the shape already used by the TUI runs page) and (b) a single run's record (summary + events) given its id. Both operations reuse the existing `listRuns`/`readRun` readers; nothing new about run data itself.

You know it is done when: a research or engineer agent can (in one tool call) list recent runs and (in another) read one run's summary and events, with the run directory otherwise opaque to it. Read-only by construction — no create/update/delete against historical runs.

Bounds:
- A new `src/tools/run-data.ts` implementing the tool, registered in the tool index at `src/tools/index.ts`.
- Scope the tool to the agents named in the issue ("research:verify" and engineer equivalent) via the registered agent capabilities; do not expose it to unrelated agents.
- Work across projects: `listRuns`/`readRun` take a `Layout`; resolve it the same way the TUI resolves repos so the agent can read runs from its own project and, when given a repo root, another.
- Follow the plan/note conventions: reading history is read-only and must not perturb the current run's state.

The periodic-review idea depends on this tool (it needs agents to aggregate 50-100 runs); land this so that review becomes possible.
