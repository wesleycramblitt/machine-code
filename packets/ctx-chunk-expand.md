---
status = "todo"
deps = ["ctx-section-budgets"]
review = "gates"
---
# ctx-chunk-expand

## Deliverable
Add snippet includes with `path:lines` parent fallback: allow `--context-include` files entries like `src/loop.ts:120-180`, assemble only those ranges with file path + line provenance headers, and let the agent expand via existing read tooling. Whole-file include keeps working as today.

## Files
- src/context/assemble.ts
- src/context/preview.ts
- src/tui/screens/composer/composer.ts
- src/tui/screens/composer/keys.ts
- test/context.test.js

## Acceptance
- `path:lines` range assembles only that range with `[source: path:lines]` header
- missing/out-of-range lines produce a warning source, not a silent empty body
- composer preview counts range chars, submit forwards ranges end to end
- whole-file includes unchanged

## Verify
typescript:test
