# Models

Planning features for providers, models, and associated algorithms in machine_code.

## Bugs

- [ ] cooldown-fallback — Free-model cooldowns often try three models before Ollama; make Ollama the final fallback.
- [ ] cooldown-refresh — Cooldowns should reset each run: probe a model cheaply instead of waiting out stale state.

## Features

- [ ] local-model-tier — Add a tier for local models and remove them from the free (free cloud) tier.
- [ ] vram-aware-context — Size local-model context to available VRAM (24GB should not request 262k with a 27b model).
