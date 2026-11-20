files: src/cli/run.ts, src/cli/common.ts, src/tui.ts, src/tui/screens/orchestrate.ts, src/tui/screens/orchestrate-keys.ts
keywords: tier flag, new run, orchestration, free tier
acceptance: script:build

# Expose Free tier in CLI, TUI, and orchestrator

Tiers are paid and local only in user surfaces: `--tier` cast in `src/cli/run.ts:102,461,1082,1126,1643,1860`, TUI default and cycle in `src/tui.ts:302,566,1709-1710,1722`, orchestration tier toggle in `src/tui/screens/orchestrate-keys.ts:63` and label in `src/tui/screens/orchestrate.ts:32`, preview contexts in `src/tui.ts:681-692,1767-1793`. After the tier-type issue adds `free`, these surfaces must offer it.

Change to:
- CLI `run --tier` accepts `paid`, `free`, `local`. Pass the flag into preflight, loop input, and child re-dispatch as the existing code does for paid and local. Reject other values with the current error style.
- TUI new-run page cycles `paid`, `free`, `local`. Keep `paid` default. Keep model preview (`resolveSelectionContext` plus `pickWithContext`) enforcing the shown tier, and keep funded and availability inputs unchanged.
- Orchestration settings cycle `paid`, `free`, `local` on the same key. Label `free` as `free` (`paid` stays `cloud`, `local` stays `local`). Persist through the existing orchestrator store update path. No store-shape change here.
- `src/cli/common.ts` selection-context builder passes `free` through like paid and local. No new flags. No paid fallback when tier is free.

Verify: `run --tier free` starts a free-tier run; TUI cycles three tiers and preview updates per tier; orchestrator tier cycles three values and persists. Build passes.
