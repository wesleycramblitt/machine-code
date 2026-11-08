---
status = "todo"
deps = ["ctx-section-budgets"]
review = "gates"
---
# ctx-tier-descriptions

## Deliverable
Hot/cold tiering: tools, skills, and references load description-only by default with on-demand body fetch (existing skill tool pattern extended to tools/references). Keep include-override to force full bodies. Measure token saving in preview chars.

## Files
- src/context/assemble.ts
- src/context/references.ts
- src/context/preview.ts
- src/agents.ts
- test/context.test.js

## Acceptance
- default run carries one-line descriptions, not full bodies, for non-included skills/tools/references
- explicit include or skill-mode include still inlines the full body
- preview chars drop measurably vs today for a default build run
- on-demand fetch path documented in block text (how to pull body)

## Verify
typescript:test
