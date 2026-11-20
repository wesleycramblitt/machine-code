files: src/config.ts, src/orchestration/store.ts
keywords: SelectionTier, OrchestratorTier, selection tier
acceptance: script:build

# Add Free to tier types and machine config

Add a third selection tier named `Free`. Today tiers are paid and local only (`SelectionTier` in `src/config.ts:26`, `SELECTION_TIERS`, `OrchestratorTier` in `src/orchestration/store.ts:30`, machine `selection.tier` parsing in `src/config.ts:250-256`).

Change to:
- `SelectionTier = "paid" | "free" | "local"`.
- `SELECTION_TIERS = ["paid", "free", "local"]`.
- `OrchestratorTier = "paid" | "free" | "local"` with the same `isTier` guard update.
- Machine config accepts `selection.tier = "free"`. Reject other strings as today.
- Keep default `paid`. Keep TUI label rule: display `paid` as `cloud` where it already does; display `free` as `free`.
- No selector or retry change in this issue. Other issues build on this type.

Verify: set `selection.tier = "free"` in machine config and start a run preflight; config loads and tier value flows through. Build passes.
