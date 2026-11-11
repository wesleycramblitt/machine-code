# machine_code CLI user guide

machine_code is a Linux-first, file-based coding-agent tool. You drive it from
a terminal: run one-off research questions, turn ideas into scoped issues, and
engineer those issues in isolated worktrees. Everything is stored as plain
files you can inspect and version.

This guide is practical and example-driven. Commands are shown as
`machine_code <command> ...`; if you have not installed the global binary, use
`node dist/cli.js <command> ...` from the repo root (the two are equivalent).

---

## Quick start

### Install and build

Requires **Node 22+** and the base CLI palette (`git`, `rg`, `ast-grep`, `jq`,
`yq`, `sd`). Provider keys come from environment variables only.

```bash
git clone <your-source> machine_code
cd machine_code
npm install
npm run build            # tsc + keep dist/cli.js executable (see scripts/build.sh)
node dist/cli.js install # installs any missing base CLIs (pinned static binaries)
node dist/cli.js init    # checks CLIs, config, and repo layout
node dist/cli.js catalogue refresh
```

Optionally install a `machine_code` binary on your PATH:

```bash
npm run install:global
```

`npm run typecheck` runs `tsc --noEmit` for a fast feedback loop without writing
`dist/`.

### Configuration and environment variables

Machine keys come from environment variables only — never from files
machine_code writes. `.env` files are loaded automatically by walking up from
the current directory, then from `~/.machine_code/.env`; exported shell
variables are never overridden.

The most common keys:

| Variable              | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `OPENROUTER_API_KEY`  | Enables OpenRouter providers (```router``` ids are never auto-selected) |
| `OPENCODE_API_KEY`    | Enables the OpenCode provider                    |

`machine_code providers` lists which key supplies each configured provider,
without printing values. `machine_code policy` shows the effective model
selection floors and weights; `machine_code policy edit` opens your
`~/.machine_code/config.toml`, and `--repo` edits `.machine_code/policy.toml`.

Selection tiers live in `~/.machine_code/config.toml`:

```toml
[selection]
tier = "paid"   # free | paid

[providers.opencode-go]
cost_multiplier = 0.5
funded = true
```

`--tier free|paid` overrides the tier for one run. See the Model selection
section of the README for full details.

---

## Core workflows

### 1. Ask a read-only question

```bash
machine_code run --agent research "summarize README.md"
```

### 2. Turn an idea into issues

```bash
machine_code issue run <idea-slug>
```

This runs the Planner/research agent to break one idea into features and bug
issues.

### 3. Engineer one issue in an isolated worktree

```bash
machine_code build <slug>
```

`build` creates and checks out an `mc/<slug>` worktree, runs the agent there,
and leaves the result on that branch. `machine_code approve <slug>` merges the
worktree branch back into `main`.

### 4. Run a batch, then merge

```bash
machine_code batch --auto-approve
```

Builds outstanding todo issues by priority/dependency and merges them.

### 5. Steer a running run

```bash
machine_code respond <run-id> "use leapfrog"
machine_code pause <run-id>
machine_code fork <run-id> "instead, use RK4"
machine_code resume <run-id>
```

`respond` sends follow-up direction to a run; `pause`/`resume` suspend and
continue it; `fork` clones a run and re-runs it with new instruction.

---

## Inspecting runs and reports

Every run is stored under `~/.machine_code/runs/<run-id>/` as plain files:
`run.json` holds the summary, `events.jsonl` holds the append-only event
stream, and `context.json` holds the context manifest. The same data backs the
TUI and the CLI views (see `src/report/run.ts`, shared by `show` and the TUI).

### List runs

```bash
machine_code runs                      # kind → issue → runs, or by status
machine_code runs --json               # machine-readable rows
```

### View one run

```bash
machine_code show <run-id>             # default summary view
machine_code show <run-id> --overview
machine_code show <run-id> --context   # context manifest / usage
machine_code show <run-id> --changes   # files the run touched
machine_code show <run-id> --events    # the raw event stream
machine_code show <run-id> --full     # everything in one report
```

Typical `show` output identifies the agent, status (`complete`, `paused`,
`failed`, ...), stop reason, model used, model/tool call counts, token and cost
totals, wall time, and changed paths. `--events` prints the append-only event
log described under [Troubleshooting](#troubleshooting).

### Spend and cleanup

```bash
machine_code spend --days 30           # cost across recent runs
machine_code runs delete <run-id> --yes
```

---

## The TUI

`machine_code tui` (or `machine_code` with no subcommand, or `scripts/run.sh`)
starts the terminal interface. It has four durable pages — **runs**, **models**,
**spend**, **settings** — plus focused detail and composer screens. From the New
Run composer you can press `t` to override the selection tier for one run.

```bash
scripts/run.sh
```

The TUI shares the run-summary and context-usage rendering with
`machine_code show` (`src/report/run.ts`) and the formatting primitives in
`src/tui/format.ts`.

---

## The map and module index

`machine_code map` builds (and caches) the deterministic repository map and the
module index over it. By default it renders the repository map for the current
repo.

```bash
machine_code map                       # render the map
machine_code map --status              # cache health, counts, paths
machine_code map --refresh            # force a rebuild
machine_code map --path src/cli       # map one subtree
machine_code map --json               # machine-readable output
machine_code map --no-symbols         # omit per-file symbols
machine_code map --semantic           # include the module index
```

Typical `map --status` output:

```
map root: /path/to/repo
head: 64059c55d0269f6ac1568d37310fb8beb87a3fbe
files: 137
symbols: 1533
bytes: 1523094
cache: /path/to/repo/.machine_code/map.json
cache: fresh
modules: 24
```

The map is computed deterministically (`src/map/deterministic.ts`) and the
module index over it in `src/map/modules.ts`. The CLI handler is
`cmdMap` in `src/cli/system.ts`, delegating to `runMapCommand`
(`src/commands/map.ts`).

---

## Running scripts

`scripts/` is the command surface for the build: an executable top-level
script named `build.sh` becomes the `script:build` command, `test.sh` →
`script:test`, and any custom name becomes `script:<name>`. The script's first
comment line is its description. There is no manifest — the executable file is
the configuration (see `src/commands/scripts.ts`).

```bash
scripts/build.sh        # npm run build (tsc + chmod dist/cli.js)
npm run build           # equivalent
node dist/cli.js build  # the issue-build command — not the compiler
```

`scripts/run.sh` starts the TUI.

Earlier versions of the project also reference `scripts/check-suggest.mjs`, an
internal suggestion checker used by gates.

---

## Reference

The important commands, with a short example each. `--json` is supported by
most inspection commands. Run `machine_code help` for the full dispatch list
(`src/cli.ts` maps every subcommand to a handler in `src/cli/*.ts`).

| Command | Example | What it does |
| ------- | ------- | ------------ |
| `run` | `machine_code run --agent research "…"` | Start an agent run from a prompt. Flags: `--agent`, `--ambiguity`, `--model`, `--provider`, `--tier`, `--max-price`. |
| `issue run` / `issue list` / `issue create` | `machine_code issue create features <slug> "do the thing" --verify script:build` | Turn ideas into (and manage) YAML issues under `features/` or `bugs/`. |
| `build` | `machine_code build <slug>` | Engineer one issue in an `mc/<slug>` worktree. |
| `batch` | `machine_code batch --auto-approve` | Build todo issues by priority/dependency, then merge. |
| `approve` | `machine_code approve <slug>` | Merge `mc/<slug>` into `main`. |
| `show` | `machine_code show <run-id> --changes` | Inspect a run's summary/context/changes/events. |
| `runs` | `machine_code runs; machine_code runs delete <id> --yes` | List, filter, and delete runs. |
| `processes` | `machine_code processes <run-id>` | List spawned processes; `kill`/`logs` subcommands. |
| `map` | `machine_code map --status` | Build/render the repo map and module index. |
| `models` | `machine_code models --agent build` | Show which model selection picks, per role or axis. |
| `catalogue refresh` | `machine_code catalogue refresh` | Re-pull the model catalogue after adding provider keys. |
| `catalogue snapshot` | `machine_code catalogue snapshot` | Commit model/offer data to `data/models` + `data/offers`. |
| `policy` | `machine_code policy; machine_code policy edit` | Show or edit selection floors/weights. |
| `providers` | `machine_code providers` | Show which key supplies each provider. |
| `spend` | `machine_code spend --days 30` | Report cost across recent runs. |
| `init` / `install` | `machine_code init; machine_code install` | Check/env the base CLIs and repo layout. |
| `lsp` | `machine_code lsp list` | List/install/status language servers. |
| `tools` | `machine_code tools` | List artifacts/tools/scripts the agent can use. |
| `config` / `settings` | `machine_code config paths` | Inspect configuration paths. |
| `status` / `log` | `machine_code status` | Git + map/LSP freshness (`core:status`). |
| `respond` / `pause` / `resume` / `fork` / `cancel` | `machine_code respond <id> "use leapfrog"` | Control a running/suspended run. |
| `worktree` | `machine_code worktree list` | Manage `mc/<slug>` worktrees. |
| `context` | `machine_code context <run-id>` | Show the assembled context that fed a run. |
| `eval` | `machine_code eval` | Compare run metrics against thresholds. |
| `pack` | `machine_code pack` | Produce a run artifact bundle. |
| `prune` | `machine_code prune` | Clean up stale run state. |
| `delete` | `machine_code delete <run-id>` | Shorthand for `runs delete`. |
| `version` | `machine_code version` | Print the CLI version. |
| `help` / `-h` / `--help` | `machine_code help` | Print dispatch help. |
| `tui` | `machine_code tui` | Start the terminal UI (default with no subcommand). |

### `machine_code reference` / the reference index

There is **no top-level `reference` subcommand**. Reference lookups are driven
through the `reference` skill and its typed commands in
`src/commands/reference.ts`: web fetch, PDF extraction, bundle indexing, and
best-effort web search. The index writer may only touch
`~/.machine_code/references/` and `.machine_code/references/links.toml`. The
index layer is regenerated by `data/scripts/reference-index.py` (see the note
in [Follow-ups](#follow-up-issues)).

---

## Troubleshooting

### Common errors

- **`no eligible model`** — the selection filter (role floors, `price_caps`,
  tier) excluded every catalogue row. Loosen `policy`, raise `min_fit`/floors,
  drop a price cap, or add provider keys and `catalogue refresh`.
- **`model pin unavailable` / `model_pin_relaxed`** — the pinned
  `--model`/`--provider` was down, so selection fell back to the catalogue.
  This is logged and expected under `model pin unavailable…` on stderr. It is
  not an error.
- **Missing provider key** — export a key (or add a `.env` file) and run
  `machine_code catalogue refresh`.
- **Missing base CLI** — run `machine_code install` to fetch pinned static
  binaries, then `machine_code init` to re-check.
- **Build failures** — ensure Node 22+ and run `npm install && npm run build`
  via `scripts/build.sh`.

### Where to find logs

Run state lives under `~/.machine_code/runs/<run-id>/`:

| File | Contents |
| ---- | -------- |
| `run.json` | Summary (status, stop reason, model, usage, cost, gates). |
| `events.jsonl` | Append-only event stream, one JSON object per line. |
| `context.json` | Context manifest (chars, sources, warnings, section budgets). |

`machine_code show <run-id> --events` prints the event stream; `--context`
prints the manifest. Agent stderr for model-pin failures also goes to the
console.

### Reading run events

`events.jsonl` is the source of truth for what a run did. The event types you
will see most often (parsed by `src/report/run.ts:runMetrics` and surfaced by
`show`/the TUI):

- **`model_request`** / **`model_call_end`** — prompt density and per-call
  token usage (`input`, `cacheRead`, `output`).
- **`tool_call`** — a tool the agent invoked; the tool name is the argument.
- **`loop_blocked`** — the loop stalled; `reason` says why.
- **`gates`** — acceptance gate run: `passed`, `total`, and the list of
  `failed` commands.

Follow the pattern: model calls → tool calls → gates → final outcome. If a run
is `failed`, look at the last `gates` event's `failed` list, then the `show
--context` warnings, then the tail of `events.jsonl`.

---

## Code map for maintainers

The CLI is a thin dispatcher over per-group handlers:

- `src/cli.ts` — subcommand → handler mapping (the `switch` you see in `help`).
- `src/cli/common.ts` — shared flags, runtime, formatting, run lookup.
- `src/cli/run.ts` — run execution lifecycle and run control
  (`run`, `respond`, `pause`, `resume`, `fork`, `cancel`, `prune`, `worktree`).
- `src/cli/runs.ts` — run inspection (`runs`, `show`, `processes`, `context`,
  `eval`, `pack`, `spend`, `prompts`, `log`, `status`).
- `src/cli/issues.ts` — issue lifecycle (`issue`, `approve`, `plan`, `build`,
  `batch`, `delete`).
- `src/cli/system.ts` — env/system commands (`init`, `install`, `providers`,
  `policy`, `map`, `lsp`, `tools`, `config`).
- `src/cli/models.ts` — model/catalogue (`models`, `catalogue`, `provider`,
  `model`, `availability`).
- `src/commands/` — the typed command runtimes behind `map`, `reference`,
  `scripts` (and the `registry.ts` schema).
- `src/report/run.ts` — run scorecard shared by `show` and the TUI.
- `scripts/build.sh`, `scripts/run.sh` — build and TUI entrypoints.
- `data/scripts/reference-index.py` — regenerates the searchable reference
  index layer.

---

## Follow-up issues

- The reference feature has typed commands (`src/commands/reference.ts`) but
  no top-level `machine_code reference` subcommand in `src/cli.ts`. Consider a
  thin `machine_code reference <fetch|search|index>` wrapper so the CLI surface
  matches the skill. (Linked from this guide.)