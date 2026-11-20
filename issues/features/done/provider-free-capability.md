commit: 60f8bdf22e2886d1719451e26fb6d42464c66372
files: data/providers/openrouter.toml, data/providers/opencode.toml, src/data.ts, src/catalogue/refresh.ts
acceptance: script:build
keywords: assumeFree, free models, provider definition

# Mark which providers support free mode

Not all providers allow free calls through this setup. OpenRouter works. Opencode allows free use only on its own platform, not here. The provider definition has no flag for this, only `assumeFree` in `src/data.ts:88-92` and `applyAssumedFree` in `src/catalogue/refresh.ts:276-291`.

Change to:
- Add a provider flag, for example `free_supported = true|false` in each `data/providers/*.toml`. Set `true` for `openrouter`, `false` for `opencode` and `opencode-go`. Default missing flag to `false` (safe: no free use unless stated).
- Extend `ProviderDefinition` in `src/data.ts:74-99` with the new flag. Keep file loading unchanged.
- Keep `assumeFree` as the machine-local escape hatch. It must not override `free_supported = false`. A machine cannot enable free use on a provider that forbids it.
- Keep catalogue refresh behavior for `assume_free` rows. Add the flag to the assembled provider entry where `funded` and `modes` are copied in `src/catalogue/refresh.ts:208-241` if that entry shape carries provider facts.
- Document the flag in one comment at the TOML field.

Verify: refresh catalogue, check provider entries show openrouter free-supported and opencode not. Build passes.
