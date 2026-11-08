---
status = "todo"
deps = []
review = "gates"
---
# ctx-preview-parity

## Deliverable
Unify previewContext (src/context/preview.ts) and assembleContext (src/context/assemble.ts) so measurements are valid: same skill-body caps, same secret/missing/outside-repo checks, forward `file:*` includes from composer submit (currently dropped in src/tui.ts buildNewRunArgs), same depth/provenance semantics.

## Files
- src/context/preview.ts
- src/context/assemble.ts
- src/tui.ts
- src/cli/run.ts
- test/context.test.js

## Acceptance
- preview and assemble agree on skill-body cap behavior for identical inputs
- `file:*` composer includes reach `run` via --context-include and appear as explicit file sources
- secret files warned (not inlined) in both paths
- existing planner-only plan inheritance unchanged

## Verify
typescript:test
