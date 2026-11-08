---
status = "todo"
deps = ["ctx-section-budgets"]
review = "gates"
---
# ctx-ordering-cache

## Deliverable
Lost-in-the-middle ordering + cache-stable layout: fixed XML/Markdown section order (system, plan/packet, retrieved files by relevance, tools/skills, volatile last), critical plan recap at end, highest-relevance first/last with dedupe. Keep prefixes byte-stable for prompt caching.

## Files
- src/context/assemble.ts
- src/context/render.ts
- src/loop.ts
- test/context.test.js

## Acceptance
- section order is fixed and documented; volatile content (working context, ledger tail) renders last
- plan/packet recap block present at end when plan sources exist
- near-duplicate blocks deduped (exact sha1 today -> normalized whitespace/hash threshold)
- prompt-cache prefix stability covered by a test (reordered volatile tail doesn't shift stable prefix)

## Verify
typescript:test
