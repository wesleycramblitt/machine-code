files: src/select.ts, src/catalogue/query.ts
keywords: free tier, free model, pick, minFit
acceptance: script:build

# Strict Free-mode model selection

Free mode must try the best free models for the job. Today the selector in `src/select.ts:211-271` knows only paid and local: `tier paid` drops ollama rows, `tier local` drops non-ollama rows, and free cloud rows are gated by `machine.selection.freeCloudModelsEnabled` (lines 224-228). Funded-provider gate is at line 254. Cost sort is cheapest-first in `pick` (lines 318-322).

Change to:
- When `tier` is `free`, select only rows that are free (`isFreeModel` in `src/catalogue/query.ts:74-76`: `free` flag or zero input and output price). Reject paid rows with reason `paid-model`.
- When `tier` is `free`, require the provider free-capability flag from the provider-free-capability issue. Reject rows on providers without free support with reason `provider-free-unsupported`.
- When `tier` is `free`, ignore `fundedProviders` and price caps. Free calls have no spend. Keep all capability gates: `minFit`, `minCapability`, per-axis floors, tool-call, context, router, coding.
- Keep paid and local behavior unchanged. Paid keeps the current free-cloud gate. Local keeps ollama-only.
- Sort free candidates by fit descending (best model first), not by cost. All candidates cost zero, so cheapest-first is noise.

Verify: with tier free and two free models of different fit, pick returns the higher-fit free model on a free-supported provider, and rejects paid and unsupported-provider rows with the new reasons. Build passes.
