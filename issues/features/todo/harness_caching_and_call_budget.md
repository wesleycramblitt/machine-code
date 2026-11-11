priority: medium
review: agent
tags: runs, harness, caching
keywords: call budget, run cache, speculative reads
acceptance: script:build

todo:
  - [ ] Design call-budget policy and run-level cache semantics
  - [ ] Implement monitoring and adaptive throttling
  - [ ] Finish

# Harness-level improvements: caching, call budgets, and adaptive retrieval

Problem

Current harness behavior can amplify inefficient agent behavior rather than mitigate it. We need harness-side policies that limit waste, provide efficient defaults, and allow models to plan confidently.

Proposal

1. Call budgets: each run receives a soft call budget based on task size (small/medium/large) and model capability. The harness exposes remaining budget in the context so agents can prioritize.

2. Adaptive throttling: when a run approaches its budget, the harness encourages the agent to produce a more constrained plan (e.g. ask for fewer files or a summary). Forcing a hard cap only when necessary.

3. Run-level cache: cache prior reads and summaries; expose cache hit/miss stats. Invalidate entries when the run edits a file.

4. Speculative/staged edits: support a two-step commit workflow where the agent submits staged edits and a separate explicit commit tool-call applies them, enabling dry-run checks and larger atomic changes.

5. Telemetry and gates: add metrics for calls-per-run, average call latency, and an optional gate that warns when runs exceed expected call-counts for their task size.

Acceptance criteria

- Call budget is implemented and surfaced to agent prompts.
- Run cache exists with documented invalidation semantics and observable metrics.
- Staged edits + commit flow implemented and used by at least one template.
