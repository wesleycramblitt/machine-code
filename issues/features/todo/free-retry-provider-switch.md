files: src/loop.ts
keywords: rate limit, retry, provider switch, blocked run
acceptance: script:build

# Free-mode retry: switch provider on hard limits, block when empty

Free mode has no cooldowns after the remove-cooldown issue. The loop must still make progress: try the best free models, switch provider when one provider hits a hard limit on all models, block the run when none remain. Today the loop records `applyErrorState` in `src/loop.ts:1546-1575` and bounded retry picks another model. Error kinds come from `classifyError` in `src/availability.ts:188-320`: `rate-limit-model` versus `rate-limit-provider` (lines 247-255), `funds`, `quota`, `timeout`, `auth`.

Change to (free tier only; paid and local retry unchanged):
- Keep an in-attempt exclusion set, not persisted. A failed free model is excluded for the rest of the run attempt. A provider-wide hard error excludes every tried model on that provider for the rest of the run.
- Switch provider only on provider-wide hard limits: kind `rate-limit-provider`, or kind `funds`/`quota` when the message names the provider account or quota (organization, account, quota, monthly, plan limit, workspace, provider-wide). Then pick the next best free model on a different free-supported provider.
- Stay on the same provider for per-model limits: kind `rate-limit-model` excludes only that model and retries the next free model on the same provider.
- Never switch provider on `timeout`, network, or bandwidth errors (`timed out`, `timeout`, `no stream event`, 5xx, fetch failure). Exclude only the failing model and retry. These are route noise, not provider bans.
- `auth` and `missing-model` with `permanent` exclude the model or mark the provider needs-auth as today, then continue selection.
- When no eligible free model remains on any free-supported provider, stop retrying and block the run with a message naming the exhausted providers and the last error kind. Do not loop forever. Do not fall back to paid models.

Verify: with two free providers, a provider-wide 429 on all models of provider A moves the next call to provider B; per-model 429 stays on A with the next model; timeouts stay per-model; with all free models excluded the run blocks with the exhaustion message. Build passes.
