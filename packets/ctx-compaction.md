---
status = "todo"
deps = ["ctx-section-budgets"]
review = "gates"
---
# ctx-compaction

## Deliverable
Rolling compaction for parent-chain history: replace unbounded transcript carry-forward with summarized `key facts + decisions + open todos` per parent, keep plan-state file as ground truth. Cap parent band chars with summarizer fallback and warning when truncated.

## Files
- src/context/assemble.ts
- src/context/render.ts
- src/loop.ts
- test/context.test.js

## Acceptance
- parent chains over the cap compact to facts/decisions/todos instead of raw transcript
- blocked/failed parents still suppress finalText (existing behavior kept)
- compaction is provenance-labelled (which parent, what was dropped)
- deep chain (3+ parents) stays under parent-band cap in test

## Verify
typescript:test
