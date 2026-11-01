# machine_code data

Shipped defaults. Anything here can be overridden per machine by placing the
same relative path under `~/.machine_code/data/`; repo prompt overrides live
under `.machine_code/agents/<role>.md`.

| Path | Purpose |
|---|---|
| `providers/<id>.toml` | One provider: env keys, endpoint, discovery mode, funding, billing. |
| `providers/ollama.toml` | Local keyless Ollama provider (`discovery = "ollama"`). |
| `agents/<role>.toml` | One role: inline prompt, tools, permissions, weights, and its orchestration `modes`; empty modes means single-agent. |
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

The runtime selection file remains `~/.machine_code/catalogue/models.json`. TUI chrome colors are
machine-configurable under `[theme]` in `~/.machine_code/config.toml`; see the README
for the full key list.

## Modes and reusable artifacts

Modes are role data, not a global enum. The Architect ships
`modes = ["direct", "verified", "redundant"]`, `default_mode = "verified"`, and
`[mode.<name>]` tables that set Build verification and whether Review runs.
General, Build, Review, and Sudo ship with `modes = []`; they run alone.

Issues can point at cascading repo artifacts in a single block. The nearest
Task wins, then its Feature, then its Epic:

```markdown
<!-- mc:context
{"files":["src/parser.ts"],"knowledge":["knowledge/parser.md"],
 "skills":["reference"],"tools":["bench"],"scripts":["release-check"]}
-->
```

Tools live in `.machine_code/tools/<name>.toml`; plain scripts under
`.machine_code/scripts/` are discovered too. Scaffold one with
`machine_code tools new <name>` or add a manifest with `machine_code tools add`.
