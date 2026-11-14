priority: low
tags: models, selection, config
depends: local-model-call-timeouts
files: src/config.ts, src/select.ts, src/tui/settings.ts, src/cli/run.ts
keywords: free models, free-cloud, free_cloud_models_enabled, free-model rejection, SelectionTier
acceptance: script:build

# Free-cloud-models on/off setting

Today free (zero-price) cloud offers are disabled as a side effect of the selection tier, not a setting: `rejectReason` in src/select.ts:211-265 rejects any row with `row.free === true` or zero/zero pricing whenever `tier === "paid"` (line 222, reason `"free-model"`, comment "Free (zero-cost) offers are for the local tier only; the paid tier should never select them — they are unreliable API giveaways, not production models"). The catalogue marks rows free at src/catalogue/refresh.ts:359 (`row.free = row.pricing.input === 0 && row.pricing.output === 0`), with a comment at :356-358 that is already stale — it claims free rows are "only eligible in the explicit `free` selection mode", but no free selection mode exists in `SelectionTier` ("paid" | "local", src/config.ts:25-27). The row-type doc at src/catalogue/types.ts:39 says the opposite of the selector: "eligible in both tiers." The user's ask (issues/ideas/models.md item 2): a real setting `free cloud models enabled: false/true` that disables free cloud models across all providers, without affecting local models (ollama rows are zero-price by nature and must stay selectable). Default stays false (the current behavior), but it must be a named switch, not a tier side effect.

Deliverable:

1. New machine config field under `[selection]` in config.toml, e.g. `free_cloud_models_enabled` (boolean), parsed in `loadMachineConfig` (src/config.ts:284-292, extend the `selection` object at :287-292) into a `MachineConfig.selection.freeCloudModelsEnabled` field (interface at src/config.ts:100-104), default `false`. `false` must preserve exactly today's behavior.
2. Replace the tier-based free rejection in src/select.ts:220-222 with a gate on the new setting, read from `input.machine.selection`. Free/zero-price rows are rejected with a clear reason (keep `"free-model"`) when the setting is false, regardless of tier; when the setting is true, free cloud rows are eligible on their own merits (funding, price caps, fit floors, availability still apply — do not skip other gates). Ollama/local rows must never be rejected by this gate, even with the setting false (today they escape it only because tier is "local" — line 218 — or because paid rows are rejected before the ollama check; after the change make the exemption explicit, e.g. skip when `row.providerID === "ollama"`).
3. Surface the setting in the TUI settings screen (src/tui/settings.ts `buildSettings`, selection section, near the tier row at :41-50) with its owning file, and in the CLI places that report selection settings (`machine_code config show` in src/cli/system.ts, models dry-run help in src/cli/models.ts, run help in src/cli/run.ts if it enumerates selection fields).
4. Update the stale comments: src/catalogue/refresh.ts:356-358 (describe the setting-controlled gate) and src/catalogue/types.ts:39 ("eligible in both tiers" — now gated by the setting).
5. Check the other place free rows are special-cased: the `isMetaModel` doc at src/catalogue/refresh.ts:88-96 says ":free variants are kept... only eligible when the caller explicitly chooses the free tier" — align that text with the new setting.

Behavior after it lands: a user sets `free_cloud_models_enabled = true` in `~/.machine_code/config.toml` `[selection]` and paid-tier runs can select zero-price cloud offers (DeepInfra free, OpenRouter `:free`, NVIDIA credits rows); with it absent/false, selection behaves as today. Local ollama models are unaffected in both cases. The models browser (`machine_code models`) continues to show free rows with the `free` badge regardless (src/cli/models.ts:82, src/tui/screens/models.ts:114) — this is a selection gate, not a catalogue filter.

Verification: `script:build`; then `machine_code models --agent research --min-fit 6` style dry-run before/after flipping the setting shows free rows excluded/included; a paid-tier run with the setting false never picks a free cloud row (existing behavior); a pinned free row with the setting false fails the pin loudly with the free-model hint rather than silently rotating.
