---
status = "todo"
deps = []
review = "gates"

---

# ctx-section-budgets

## Deliverable
Replace blind tail-trim with explicit per-section token budgets in assemble + render: `budget = limit - response_reserve`, caps per section (system/plan/files/tools/skills/parents), drop/trim lowest-priority bands first. Record per-section chars in context.json and preview sources so the composer shows real costs.

## Files
- src/context/assemble.ts
- src/context/budget.ts
- src/context/render.ts
- src/context/preview.ts
- src/report/run.ts
- test/context.test.js

## Acceptance
- over-budget context drops lowest band first with named omission, never silent middle-cut
- context.json carries per-section chars (system/plan/files/tools/skills/parents)
- composer preview chars match assembled chars within rounding for same inputs
- planner index + explicit packet survive when files are trimmed

## Verify
typescript:test
