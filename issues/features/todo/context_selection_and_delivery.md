priority: high
review: agent
tags: runs, context, retrieval
depends: vram-aware-context
keywords: context selection, context hints, token budget
acceptance: script:build

todo:
  - [ ] Design context selection algorithm and APIs
  - [ ] Implement context summarization and hint delivery
  - [ ] Finish

# Context selection & delivery: give the model exactly what it needs

Problem

Large numbers of tool calls come from agents repeatedly re-reading whole files or requesting broad context. We need deterministic, token-efficient context delivery that matches the agent's plan and model constraints (including VRAM/token limits).

Proposal

1. Context budgeting: compute a per-run/per-call token/byte budget derived from the chosen model and available VRAM; expose this budget to the agent prompt (e.g. "context_budget: 64k tokens").

2. Precise selectors: let the agent specify exact file anchors, symbol names, or section headings in the Plan response. Support exact-match anchors, line ranges, and named symbol extraction.

3. Summaries and hints:
   - If a requested file exceeds the budget, return an extractive summary (first NKB + top matches) and a pointer to the full file artifact.
   - Provide small developer hints (via withKeywordTerms-like fields) so the map/suggester prioritizes matching symbols and code snippets.

4. Sticky run-state cache: maintain a transient per-run cache of previously-read files and summaries so subsequent calls can avoid re-reading unchanged files. Include cache invalidation semantics when the run edits files.

5. VRAM-aware behavior: defer to the vram-aware-context issue to size contexts conservatively for large local models; fall back to model token budgets for remote APIs.

Acceptance criteria

- New context API that accepts a structured list of anchors (file:symbol|section|range) and a token budget.
- Summarizer component that returns extractive summaries plus anchor matches when full files exceed the budget.
- Transient run-level cache with invalidation on edits and observable metrics (reads avoided).
