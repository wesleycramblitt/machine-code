priority: high
review: agent
tags: runs, agents, prompts
keywords: base prompts, agent prompt, system prompt
acceptance: script:build

todo:
  - [ ] Draft prompt templates and examples
  - [ ] Update agent config to use templates
  - [ ] Finish

# Efficiency: Consolidated base & agent prompts

Problem

Runs often spend many calls re-reading files and iterating because the agent's injected prompts (base/system/instruction) are either too loose, missing structure, or fail to require a single concise "what I need" planning step. We should standardize and tighten the prompts so models reliably ask for exactly what they need in one planning tool-call and then perform edits.

Proposal

1. Provide a small set of canonical prompt templates (system + assistant + user roles) that enforce a 3-phase interaction: Plan, Request, Execute.
   - Plan: model returns a brief plan (1-3 bullets) describing what it will do and the exact information or tools it needs, structured as a JSON or YAML list of tool calls.
   - Request: model issues exactly one tool-call (batched) with required reads, searches, and parameters.
   - Execute: once the requested materials are provided, model performs edits and returns a final summary.

2. Require template fields: token budget, max read file count, preferred file anchors, and an explicit "final edit" confirmation step to avoid multiple small edit-call loops.

3. Encode a short, machine-parseable checklist the model must follow before calling edits: e.g. [PlanCreated, Needs: [files...], EditsReady].

Why

Better prompts reduce model hallucination about what it needs, focus retrieval, and make multi-step tool traffic predictable. They also enable the harness to accept a single smart tool-call from the model and satisfy it, reducing round trips.

Acceptance criteria

- New prompt templates live under agents configuration and are referenced by name.
- At least three example-run templates (small/medium/large tasks) demonstrating the Plan/Request/Execute shape.
- Integration tests or runner checks that validate an agent's plan output conforms to the required structure (JSON schema) and can be parsed by the orchestrator.
