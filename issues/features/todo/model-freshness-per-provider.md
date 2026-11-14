priority: low
tags: models, catalogue, freshness
files: src/catalogue/reconcile.ts, src/catalogue/refresh.ts, src/models.ts, src/availability.ts, src/cli/system.ts, src/tui/screens/models.ts
keywords: catalogue refresh, reconcile, stale model, model id changed, temporary model, freshness, missing-model, permanent veto, data freshness
acceptance: script:build

# Keep per-provider model listings fresh; retire stale/renamed ids

The user's ask (issues/ideas/models.md item 1): model ids change or vanish (temp models, renames, EOL) and suddenly calls fail. Today freshness is partial and mostly manual. Map of what exists and where it falls short:

Current machinery:

- The catalogue (~/.machine_code/catalogue/models.json) is the selector's source of truth. Full rebuild: `refreshCatalogue` (src/catalogue/refresh.ts:469-576), triggered by `machine_code catalogue refresh` or automatically when no catalogue exists (src/cli/common.ts:93-100).
- Live drift handling: `reconcileCatalogue` (src/catalogue/reconcile.ts:79-294) runs on every `run`/`resume` via `loadRuntime` (src/cli/common.ts:101-117). It prunes rows for vanished ids only when the provider's listing is *trusted fresh*: dynamic providers (discovery openai-compatible/ollama, reconcile.ts:108-113) need `isFresh(id) === true` (:158 — `providerFetchOk` from src/models/providers.ts:104-106, true only after a fetch that actually reached the provider this process); `live_listings` providers get verified against a fresh `/models` fetch (:173-194); OpenRouter's keyless public catalog is authoritative when fetched (:115-128, :195-198).
- Static/builtin pi-ai rows are never reconciled (reconcile.ts:14-15: "Static builtin rows are also untouched — they change only with releases, via refresh"). A renamed/retired id in a static row stays selectable until the next pi-ai release or a manual `catalogue refresh`.
- Unreachable or non-fresh providers keep their rows silently (reconcile.ts:159-163) — deliberate (offline must not delete rows), but it means a dead id behind a flaky endpoint persists indefinitely.
- Error-side knowledge exists but is discarded: `classifyError` sets `permanent: true` for 410/EOL (src/availability.ts:250-263) and 404/"model not found"/"deprecated" (:278-282), and `ClassifiedError.permanent` is documented as "Callers may persist this as a catalogue veto" (src/availability.ts:39-45) — but `applyClassification` (:320-335) never persists it. Only config `vetoes` (src/config.ts:110-111, selection-time filter) and curation.toml vetoes (src/catalogue/refresh.ts:311-318) persist exclusions today.
- Model discovery: pi-ai `builtinModels()` merged with TOML provider overrides (src/models.ts:18-40); dynamic providers fetch live lists (`fetchModels`, src/models/providers.ts:113-192; `providerFetchOk` :104 distinguishes "emptied" from "unreachable").

Deliverable — three scoped behaviors, one issue:

1. **Auto-prune stale static rows.** Extend `reconcileCatalogue` so builtin/static rows whose provider can be listed live (dynamic discovery or live_listings) are membership-checked like dynamic rows, instead of being exempt (:14-15). Keep the conservative rule: only prune when a fresh listing was actually obtained (same `isFresh`/trusted-listing gate); unreachable providers still keep rows. A static id that vanished upstream disappears from the catalogue instead of failing every call until the next release.
2. **Persist permanent missing-model failures.** When a run classifies an error with `permanent: true` (410/404/EOL/deprecated — src/availability.ts:252-282), record it so the row stops being selected: either write a veto into the machine config vetoes path or (preferred, file-based like curation) append to the curation file the catalogue already reads (src/catalogue/refresh.ts:311-318 veto shape with source/date). The row should vanish from selection (and show in the models browser's "Vetoed" section, src/tui/screens/models.ts:129-140, which already renders curation vetoes) instead of burning a call every cooldown cycle. Guard against transient misclassification (a proxy 404ing the whole endpoint would veto every model — scope persistence to model-targeted errors, `target === "model"` or provider-scoped 404s on the model path).
3. **Make staleness visible.** The models browser and/or `machine_code providers`/`system` output should show per-provider listing freshness: when the catalog was last refreshed, which providers reconciled live this run vs. served static rows, and a warning when a provider has not been reachable for N refreshes (so "suddenly don't work" is diagnosable). Reuse the reconcile warnings path (reconcile.ts:85-106) and the availability state if useful.

Behavior after it lands: a provider renames or retires a model; the next run reconciles the fresh listing and the stale row is pruned (dynamic and static alike) or, when the failure surfaces as a call error, the permanent-missing path vetoes it — the selector stops offering it within one run instead of after a manual refresh. The user can see, per provider, whether the listing they are looking at is live-verified or static.

Verification: `script:build`; with a stubbed provider listing missing an id, `machine_code run` prunes the row and logs `catalogue: -<key>` (the reconcile logging at src/cli/common.ts:109-111 already prints added/removed); a forced 404 model error during a run results in the row being vetoed (visible in `machine_code models` "Vetoed" section) and rejected as `vetoed` by `pick` (src/select.ts:173-175, :298-300); an offline provider keeps all rows (no pruning).
