---
status = "todo"
deps = []
review = "gates"
---
# ctx-parent-index

## Deliverable
Parent chain becomes an index, not inline transcript. Each parent contributes one line (depth label, run id, objective one-liner, status) plus a named pull path for the full detail. The agent pulls as little or as much as it needs via existing tooling; nothing compacts or summarizes eagerly.

## Files
- src/context/assemble.ts
- src/context/preview.ts
- src/tools/context.ts
- test/context.test.js

## Acceptance
- parent chain renders as one line per parent: label, id, objective (truncated one-liner), status
- full parent detail (request + result + error) available on demand through a documented pull path (context-tool action or equivalent already available to the agent)
- blocked/failed parents still suppress result text, in both index line and pulled detail
- depth cap (4) kept; over-cap chain warns naming the dropped ancestors
- composer preview shows the same index lines with real chars (parity kept)

## Verify
typescript:test
