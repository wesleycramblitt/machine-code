# machine_code
A simple, Linux-first coding-agent tool.

## Requirements
Node 22+ and the six-CLI base palette (`git`, `rg`, `ast-grep`, `jq`, `yq`, `sd`).
Provider keys come from environment variables only (e.g. `OPENROUTER_API_KEY`,
`OPENCODE_API_KEY`) — never from files machine_code writes.

## Setup
```
npm install && npm run build
node dist/cli.js install   # installs any missing base CLIs (pinned static binaries)
node dist/cli.js init      # checks CLIs, config, and repo layout
node dist/cli.js catalogue refresh
```

## Usage
```
# read-only question
node dist/cli.js run --mode solo --agent general "summarize README.md"

# implementation run in an isolated worktree on a Task branch
node dist/cli.js run --mode verified --issue 31 "implement the thermal model"

# agent configuration (preset + explicit overrides)
node dist/cli.js run --mode solo --agent architect --preset orchestrate \
  --delegate true --verify verified --ambiguity precise "plan the release"

# follow-ups, pause/fork, resume after a crash
node dist/cli.js respond <run-id> "use leapfrog"
node dist/cli.js pause <run-id>
node dist/cli.js fork <run-id> "instead, use RK4"
node dist/cli.js resume <run-id>

# issues (reserved Feature 0 / Task 0 enforced by the harness)
node dist/cli.js issue tree 10
node dist/cli.js issue ensure 10
node dist/cli.js accept 31
node dist/cli.js approve 31

# pull requests (runner-owned: Task→Feature, Feature→main)
node dist/cli.js pr feature 20 --gates typescript:test,typescript:typecheck
node dist/cli.js pr list

# model selection: catalogue, hard floors, role weighting, dry-run
node dist/cli.js models --min-cap 7.3 --axes
node dist/cli.js models --agent build
node dist/cli.js models --agent sudo --tier free
node dist/cli.js policy                      # effective floors/weights + files
node dist/cli.js policy edit                 # edit ~/.machine_code/config.toml
node dist/cli.js policy edit --repo          # edit .machine_code/policy.toml
node dist/cli.js catalogue refresh           # after adding provider keys
node dist/cli.js catalogue snapshot          # update committed data/models + data/offers

# worktrees, inspection
node dist/cli.js worktree list
node dist/cli.js status
node dist/cli.js log <run-id>
node dist/cli.js tui                  # default when run with no command
```

Selection is per call and multi-dimensional: each catalogue row carries
`reasoning`, `code`, `agentic`, and `general` scores. Role weights live in
`data/agents/<role>.toml`; `.machine_code/policy.toml` sets a hard composite
floor, optional per-axis floors, and can override weights. The selector
hard-filters, then trades weighted capability against cost, speed, and context
headroom. `machine_code models --agent <role>` shows exactly what would be
chosen.

Selection has two tiers in `~/.machine_code/config.toml`:

```toml
[selection]
tier = "paid"              # free | paid

[providers.opencode-go]
cost_multiplier = 0.5
funded = true
```

`paid` considers free and paid rows (a free model can win); paid rows from
unfunded providers are excluded. `free` only admits zero-price rows.
`--tier` overrides it per run.

Data lives in folders under `data/`: providers in `data/providers/<id>.toml`,
agent roles (with prompts) in `data/agents/<role>.toml`, presets in
`data/presets.toml`, and benchmark seeds in `data/benchmarks.json`.
`machine_code catalogue refresh` regenerates
`~/.machine_code/catalogue/models.json`, which contains providers (env keys,
funding, billing modes, price ranges) and every model's capabilities, kind,
supported modes, pricing, capability axes, and per-axis provenance.
Hand-authored capability/pricing corrections go in `data/model-overrides.toml`.
The committed catalogue snapshot is split into canonical model files
(`data/models/<owner>.toml`) and provider offer files
(`data/offers/<provider>/<owner>.toml`); refresh it with
`machine_code catalogue snapshot`. Capabilities and scores live once per
canonical model; offers carry pricing, free status, and differing
context/max-output limits. `kind`/`coding` marks chat models versus
image/video/audio/guard models, which the selector rejects as coding
candidates. Minimums are layered in `~/.machine_code/config.toml` and
`.machine_code/policy.toml`; see `machine_code policy [role]` and
`machine_code policy edit`.

Prompted runs: every run has a stable id, an append-only event log, a
transcript checkpoint, and (when it mutates code) its own worktree and branch.
Runs can ask clarifying questions, be paused/forked, and resume after a
restart.

Design: [plan.md](plan.md) and the upgrade architecture in
[upgrade-plan.md](upgrade-plan.md).
