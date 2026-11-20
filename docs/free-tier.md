# Free tier routing

Tiers are `paid`, `free`, `local` (`src/orchestration/store.ts:30`, `src/config.ts:26`).
Free selects only zero-price rows on providers with `freeSupported` (`src/select.ts:220`).
It sorts by fit descending because all costs are zero.
No cooldowns: `COOLDOWN_TIERS` in `src/availability.ts:48` is removed.
Free retry keeps an in-attempt exclusion set.
Per-model limit excludes one model and retries same provider.
Provider-wide hard limit excludes the provider and switches provider.
Timeout and network errors exclude one model only.
No eligible free model blocks the run with exhaustion message.
OpenRouter free models work here. Opencode free models work only on its own platform.
