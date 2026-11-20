files: src/availability.ts, src/availability/probe.ts, src/cli/models.ts
keywords: cooldown, cooling, availability, probe
acceptance: script:build

# Remove the cooldown feature

Cooldowns escalate 1m to 30d (`COOLDOWN_TIERS` in `src/availability.ts:48`) through `coolModel` and `coolProvider` (lines 141-157), applied by `applyClassification` (lines 327-342) and probes (`applyProbeResult` in `src/availability/probe.ts:372-398`). CLI `models` shows cooling state (`probeCoolingCandidates` in `src/cli/models.ts:455`). The request is to delete this feature. Keep auth and disabled handling. Keep probes as evidence only.

Change to:
- Delete `COOLDOWN_TIERS`, `MAX_COOLDOWN`, `coolModel`, `coolProvider`, `clearModelCooldown`, `clearProviderCooldown`, `isProviderCooling`, `isModelCooling`, and tier reset helpers that exist only for cooldowns. Delete `cooldownUntil` and `tier` fields on `ProviderHealth` and `ModelHealth`. Keep `disabled`, `needsAuth`, `lastErrorKind`, probe timestamps.
- Make `applyClassification` keep only `disableProvider` and `markNeedsAuth` effects. It must not write cooldowns. `cooldownMs` on `ClassifiedError` becomes unused; remove it or leave it set to 0 with a comment. Do not change error kinds in this issue.
- Remove cooling checks from selection gating (the `isProviderCooling` and `isModelCooling` branches). Remove cooling display and `probeCoolingModels` callers. Probes keep `ready`, `unavailable`, `auth`, `unknown` results but never block selection by time.
- Remove the `coolingTargets` and interval-jitter probe loop, or reduce it to a no-op kept for manual evidence. No automatic timer may exclude a model.

Verify: trigger two rate-limit errors in a row; availability file holds no `cooldownUntil`; selection still lists the model as eligible (retry logic in the next issue decides exclusion per attempt). Build passes.
