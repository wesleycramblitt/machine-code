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
node dist/cli.js run --agent general "summarize README.md"

# implementation run in an isolated worktree on a Task branch
node dist/cli.js run --agent architect --mode verified --issue 31 "implement the thermal model"

# agent configuration (preset + explicit overrides)
node dist/cli.js run --agent architect --mode verified --preset orchestrate \
  --delegate true --ambiguity precise "plan the release"

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
node dist/cli.js runs                 # Epic → Feature → Task → runs + untracked
node dist/cli.js show <run-id>        # overview/context/changes/children/events
node dist/cli.js spend --days 30
node dist/cli.js tools
node dist/cli.js tui                  # default when run with no command
```

Provider keys are loaded automatically from `.env` files found by walking up
from the current directory, then from `~/.machine_code/.env`; exported shell
variables are never overridden. `machine_code providers` shows which key supplied
each configured provider, without printing values.

Selection is per call and multi-dimensional: each catalogue row carries
`reasoning`, `code`, `agentic`, and `general` scores. Role weights live in
`data/agents/<role>.toml`; `.machine_code/policy.toml` sets a role-weighted
`min_fit`, explicit per-axis floors, and can override weights. The selector
hard-filters, then trades weighted capability against cost, speed, and context
headroom. Rows whose scores are metadata-only priors carry a confidence
penalty, so they stay eligible (especially in the free tier) but do not outrank
benchmark-backed rows by a hair. Free offers are judged by a looser
`[agents.<role>.free]` floor (built-in `min_fit 5.5`, axes 5/5/5/3) in both
tiers; paid offers keep the paid floors above. A build agent is therefore
judged mainly on code/agentic, while an architect is judged mainly on
reasoning/agentic. `machine_code models --agent
<role>` shows exactly what would be chosen.

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

Meta routers (ids or names containing `router`) are never selected: they
forward to unknown upstream models, so their catalogue scores and capabilities
are guesses. A provider call that produces no stream event within
`[selection] first_token_timeout_ms` (default 60 s) is aborted, the model is
cooled, and the run rotates to the next eligible model. Rate limits, free-tier
usage limits, timeouts, and other retryable provider errors rotate the same
way until a model succeeds or none remain; a free-tier limit cools every free
offer on that provider rather than only the model that answered first.

The TUI palette is machine-configurable with hex colors. Header and footer share
a surface, subpage chrome uses a contrasting accent, and inner section tabs get
their own darker strip:

```toml
[theme]
header_bg = "#161616"
header_fg = "#d9d9d9"
footer_bg = "#161616"
footer_fg = "#d9d9d9"
body_bg = "#0a0a0a"
sub_header_bg = "#1f6feb"
sub_header_fg = "#ffffff"
back_bg = "#ff5858"
back_fg = "#0d1117"
section_bg = "#090909"
section_fg = "#8b949e"
section_active_bg = "#d29922"
section_active_fg = "#111111"
tab_active_bg = "#58a658"
tab_active_fg = "#0d1117"
```

### Local models

Ollama is a first-class, keyless provider. With the daemon running on its default
port, refresh once and the local chat models appear beside remote models:

```bash
node dist/cli.js catalogue refresh
node dist/cli.js models --provider ollama
node dist/cli.js run --agent general --provider ollama \
  --model ollama/qwen3.5:9b "summarize the README"
```

Local models are zero-price rows in the catalogue. Embedding-only Ollama models
are excluded, while completion/vision/tool/reasoning capabilities come from
Ollama's `/api/show` metadata.

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

### Runs pages and modes

`machine_code runs` is the scriptable version of the TUI's Runs page. The
default `--group gh-issue` groups by repository, then by the Epic → Feature →
Task issue hierarchy, with runs that have no issue under Untracked and runs
whose cached issue is missing under Orphaned issue.

`--group status` keeps repository headings but groups each repository's runs by
run status with no issue tree. `--group overall` drops repository headings
entirely and groups every run on the machine by status, so blocked, failed, and
running work is visible at a glance. `machine_code status` is shorthand for the
overall view. In the TUI, `g` cycles GH issue → Status → Overall status.

`machine_code show <run-id>` exposes the same overview, context, changes,
children, and event stream as the run detail screen. `machine_code spend` and
`machine_code models` cover the catalogue and cost views without the TUI.

Run modes belong to the selected agent. The Architect declares `direct`,
`verified`, and `redundant` (default `verified`) plus the per-mode
`verification`/`review` behavior in `data/agents/architect.toml`. A role with
no modes runs alone, so `solo` is never passed. This keeps the
coordinator/subagent chain data-driven instead of hardcoding a global mode
enum.

### Issue context and reusable tools

An issue can declare a compact context block; the harness merges Task →
Feature → Epic, nearest first:

```markdown
<!-- mc:context
{"files":["src/parser.ts"],"knowledge":["knowledge/parser.md"],
 "skills":["reference"],"tools":["bench"],"scripts":["release-check"]}
-->
```

Tools live in `.machine_code/tools/<name>.toml`, scripts under
`.machine_code/scripts/`. `machine_code tools new <name>` scaffolds both.
The new-run composer previews exactly which files, tools, scripts, and issues
the selected run will inherit before it starts.

Skills live in `.machine_code/skills/<name>/SKILL.md`. Only descriptions are
always visible; the body loads when an issue references the skill. The curation
policy and the kept set are in
[knowledge/skills-curation.md](knowledge/skills-curation.md).

Prompted runs: every run has a stable id, an append-only event log, and a
transcript checkpoint. Build and orchestrated runs get their own worktree and
branch; Sudo edits the main tree by default (`--worktree` opts into isolation);
General and Review never create one. Runs can ask clarifying questions, be
paused/forked, and resume after a restart.

### Repository map, run state, and prompts

`machine_code map [path]` prints the deterministic file and symbol map. It is
cached under `.machine_code/local/cache/map.json`; `--status` shows map, semantic,
and LSP health; `--semantic` adds module annotations; `--refresh` rebuilds the
deterministic cache.

Each run keeps its working memory outside the transcript:

```text
.machine_code/local/runs/<id>/
  state.jsonl   facts, decisions, changes, next action
  state.md      readable snapshot
  artifacts/    content-addressed tool bodies
```

The model sees the run state plus the last step, not the full tool history. The
`context` tool records decisions, focuses ranges, recalls artifacts, and resolves
facts. A prompt that exceeds the run envelope or 90% of the selected model's
window blocks and writes a split report instead of truncating.

`machine_code prompts [role]` prints the rendered agent prompt with its size.
Prompts share `data/prompts/base.md`; role files carry only short deltas.

Map configuration lives in `~/.machine_code/config.toml`:

```toml
[map]
enabled = true
semantic = true
semantic_model = ""    # pin a model, or leave empty for automatic selection
refresh = "on-change"  # on-change | manual | always
```

Design: [plans/context-and-map-plan.md](plans/context-and-map-plan.md) and the
upgrade architecture in [plans/upgrade-plan.md](plans/upgrade-plan.md).
