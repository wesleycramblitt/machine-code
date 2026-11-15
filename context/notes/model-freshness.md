# model-freshness-per-provider — what these reads established

## Already implemented (do NOT redo)
1. `src/availability.ts:340-343` — `applyClassification(..., persistVeto)` persists
   `classified.permanent && target === "model"` via `persistVeto?.(modelKey,
   "runtime: ...")` and returns true.
2. `src/loop.ts:334-350` — `applyErrorState` writes a curation veto via
   `addCurationVeto(layout.curation, ...)` and records a `model_vetoed` event.
3. `src/catalogue/reconcile.ts:136-243` — static/builtin rows are membership-checked
   against `listedIds` + the `isFresh` gate (dynamic discovery or live_listings).
   Unreachable providers keep rows.
4. `src/cli/common.ts:107-116` — `reconcileCatalogue(l, models, id => providerFetchOk(id))`,
   logs `catalogue: +/-<key>`.
5. `src/catalogue/reconcile.ts:38-71` — `ReconcileResult.freshness` Map +
   `trackFreshness` already track per-provider listing mode/refresh count.

## Remaining work (this turn)
- Show per-provider listing freshness in `machine_code providers` (cmdProviders)
  and in the models browser (`renderModelsList`), reusing the reconcile freshness map.
- Verify `script:build`.

## Files touched so far (from the run)
- `src/availability.ts` — added `listingMode`/`lastListingAt`/`refreshCount` to
  `ProviderHealth` (lines 51-65).
- `src/catalogue/reconcile.ts` — added `ReconcileResult.freshness` + `trackFreshness`
  (lines 38-71).
- `src/loop.ts` — added `applyErrorState` fallback that writes a curation veto when
  `persistVeto` returns null (lines 339-351).

## Key facts
- `layout()` (src/paths.ts:31) has `home`, `curation`, `catalogueFile`.
- `addCurationVeto(layout.curation, key, source)` (src/catalogue/refresh.ts:311-318).
- `providerStatuses(models)` (src/models.ts:56) returns `{ id, name, envKeys,
  configured, source, funded, modelCount }`.
- `cmdProviders` (src/cli/system.ts:164) prints status/model count/funding/modes/price.
- `renderModelsList` (src/tui/screens/models.ts:77) renders "Vetoed" section.