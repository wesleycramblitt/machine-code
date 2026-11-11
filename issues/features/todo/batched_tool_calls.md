priority: high
review: agent
tags: runs, tools, orchestration
keywords: batched tool calls, tool schema, multi-tool
acceptance: script:build

todo:
  - [ ] Define batched-tool schema and orchestrator behavior
  - [ ] Implement orchestrator executor and parallelism rules
  - [ ] Finish

# Batched tool calls and multi-action requests

Problem

Agents often need several pieces of information before they can make edits. Issuing separate tool calls for each (read file A, search web B, read file C) causes many round trips. We need a first-class way for an agent to request multiple tool actions in one call, and for the harness to execute them efficiently.

Proposal

1. Define a batched tool-call schema: the model returns a single tool call named e.g. "tool_batch" with an array of actions. Each action includes { type: "read"|"search"|"grep"|"edit"|"run_command", target, args }.

2. Orchestrator executes non-conflicting read/search actions in parallel, returns a single composite response with results indexed to actions so the model can consume them in-order.

3. Support dependency ordering: actions may optionally depend on the outputs of earlier actions. The orchestrator executes respecting dependencies.

4. Safety: edits or mutating actions in the batch execute only after a successful read/plan phase. Mutating actions are gated behind a final explicit confirmation flag from the model (e.g. "commit": true).

5. Telemetry: record counts and latency for batched vs individual calls to demonstrate efficiency gains.

Acceptance criteria

- New tool schema documented and accepted by the tools registry.
- Orchestrator implementation that accepts the batch schema, executes reads/searches in parallel where possible, and returns a predictable composite response.
- Tests that show a representative medium task drops from ~15 tool-calls to <=5 when using the batch API.
