# machine_code data

Shipped defaults. Anything here can be overridden per machine by placing the
same relative path under `~/.machine_code/data/`; repo prompt overrides live
under `.machine_code/agents/<role>.md`.

| Path | Purpose |
|---|---|
| `providers/<id>.toml` | One provider: env keys, endpoint, funding, billing. |
| `agents/<role>.toml` | One role: inline prompt, tools, permissions, weights. |
| `presets.toml` | Behavior presets (`plan`, `orchestrate`, `implement`, ...). |
| `defaults.toml` | Built-in selector defaults. |
| `benchmarks.json` | Curated benchmark seed. |
| `model-overrides.toml` | Hand-authored capability/pricing corrections. |
| `models/<owner>.toml` | Generated canonical model snapshot. |
| `offers/<provider>/<owner>.toml` | Generated provider offers for those models. |

`models/` and `offers/` are regenerated; do not hand-edit them.

```bash
machine_code catalogue refresh --snapshot   # refresh runtime catalogue + snapshot
machine_code catalogue snapshot             # snapshot an existing catalogue
```

The runtime selection file remains `~/.machine_code/catalogue/models.json`.
