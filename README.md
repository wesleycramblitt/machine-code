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
node dist/cli.js run --agent research "summarize README.md"

# research: turn one idea into features/bugs
node dist/cli.js issue run <idea-slug>

# engineer one issue in an isolated mc/<slug> worktree
node dist/cli.js build <slug>

# build todo issues by priority/dependency, then merge
node dist/cli.js batch --auto-approve

# agent configuration (preset + explicit overrides)
node dist/cli.js run --agent research --ambiguity strict "scope the thermal model work"

# follow-ups, pause/fork, resume after a crash
node dist/cli.js respond <run-id> "use leapfrog"
node dist/cli.js pause <run-id>
node dist/cli.js fork <run-id> "instead, use RK4"
node dist/cli.js resume <run-id>

# issues: one YAML file per idea/feature/bug, status = directory
node dist/cli.js issue list
node dist/cli.js issue create features <slug> "do the thing" --verify core:check
node dist/cli.js issue <slug>              # show the issue
node dist/cli.js approve <slug>            # merge mc/<slug> into main

# model selection: catalogue, hard floors, role weighting, dry-run
node dist/cli.js models --min-cap 7.3 --axes
node dist/cli.js models --agent build
node dist/cli.js policy                      # effective floors/weights + files
node dist/cli.js policy edit                 # edit ~/.machine_code/config.toml
node dist/cli.js policy edit --repo          # edit .machine_code/policy.toml
node dist/cli.js catalogue refresh           # after adding provider keys
node dist/cli.js catalogue snapshot          # update committed data/models + data/offers

# worktrees, inspection, run cleanup
node dist/cli.js worktree list
node dist/cli.js runs delete <run-id> --yes
node dist/cli.js runs                 # kind → issue → runs, or by status
node dist/cli.js show <run-id>        # summary/overview/context/changes/related/events
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
judged mainly on code/agentic, while the Planner and Review roles are judged mainly on
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

`paid` considers paid rows first and free rows as fallback (a free model wins
only when no paid row is eligible); paid rows from unfunded providers are
excluded. `free` only admits zero-price rows.
The New Run composer starts from this tier; press `t` there to override it for
one run. `--tier` overrides it from the CLI.

A `--model <key>` (or `--provider <id>`) pin is a preference, not a hard
constraint. If the pinned model is unavailable before start, or fails during
the run, the pin is dropped and selection falls back to the catalogue; the
fallback is logged (`model pin unavailable…` on stderr, `model_pin_relaxed`
in run events). Without this, a failed pin would filter the catalogue down to
the one model that just failed and the run would die with "no eligible model".

Price is a soft trade by default: capability has twice the weight of cost, so
roughly one point of role-weighted fit outweighs a 10x price gap. When spend
matters, set a hard ceiling instead of retuning the weights:

```toml
# ~/.machine_code/config.toml (top level, next to [selection])
price_caps = { input = 0.5, output = 2.0 }   # $ per 1M tokens, machine default
```

`machine_code run --max-price 0.5` sets both caps for one run;
`--max-input-price` / `--max-output-price` set them independently
(`--max-price 0` means free rows only). The same flags work on
`machine_code models --agent <role>` to preview what survives the cap.

Meta routers (ids or names containing `router`) are never selected: they
forward to unknown upstream models, so their catalogue scores and capabilities
are guesses. A provider call that produces no stream event within
`[selection] first_token_timeout_ms` (default 60 s) is aborted, the model is
cooled, and the run rotates to the next eligible model. Ollama waits far
longer (`[selection] ollama_first_token_timeout_ms`, default 300 s): the model
is known to exist locally but may be busy with another request. Rate limits,
free-tier usage limits, timeouts, and other retryable provider errors rotate
the same way until a model succeeds or none remain; a free-tier limit cools
only the model that answered unless the error explicitly says all free models
or offers are affected. Free-model and free-provider cooldowns are per run and are never written
to disk, so each free run loops from best fit to worst across every listed free
model instead of inheriting the previous run's 30m+ cooldowns. Paid cooldowns
persist with the 1m→5m→30m→2h→12h→1d→7d→30d tier schedule. A completed call
resets the serving provider and model tiers, so transient blips cannot ratchet
a provider toward day-long bans. Ollama is the
final selection fallback: another eligible cloud model always wins first.

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

Ollama is a first-class, keyless provider and the final fallback after eligible
cloud models. With the daemon running on its default
port, refresh once and the local chat models appear beside remote models:

```bash
node dist/cli.js catalogue refresh
node dist/cli.js models --provider ollama
node dist/cli.js run --agent research --provider ollama \
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
default `--group all` groups by repository, then issue kind (Ideas, Features,
Bugs), then issue, then runs. Runs with no issue sit under Untracked.
`--group type` adds the status directory, and `--group category` groups by the
issue's first tag. Select an issue and press Enter to open its page: prompt,
priority, tags, dependencies, review mode, and the runs attached to it.

`--group status` keeps repository headings but groups each repository's runs by
run status with no work tree. `--group overall` drops repository headings
entirely and groups every run on the machine by status, so blocked, failed, and
running work is visible at a glance. `machine_code status` is shorthand for the
overall view. In the TUI, `g` cycles All → By type → By category and `f` toggles all repos
vs the TUI cwd; `!` limits the list to work needing a human or in flight. With
the cwd scope, `n` opens the composer for the cwd.

In the work view, the highlighted row keeps its branch bright: the selected
issue or run, its ancestors, its peers at the same level, and its immediate
children (runs under an issue). Unrelated rows dim to gray. Repository and
section headings stay bright so the page structure remains readable.

`machine_code show <run-id>` exposes the same overview, summary, context,
changes, related lineage, and event stream as the run detail screen.
`machine_code context <run-id>` prints the assembled context and ledger that
the model actually received. `machine_code pack` previews the curated run
context before a run; add `--agent`, `--model`, `--context-include`,
`--context`, or `--json` to tune the view. `machine_code eval
<run-id>` scores a run's calls, tokens, cost, context, changes, and gates;
compare with `--baseline <run-id>` and fail CI with `--max-calls`,
`--max-cost`, `--max-tokens`, or `--max-context`. `machine_code spend` and
`machine_code models` cover the catalogue and cost views without the TUI.

Every terminal run records a deterministic outcome summary in
`run.json.summary` and a `run_summary` event. The summary is generated from the
event stream and run state, so it exists even when the model produced no final
message (turn cap, provider failure, interruption). It lists the stop reason,
issues touched, files changed, reads/searches/commands, retries, errors, and
the model's final response. `machine_code show`, the TUI Overview, and the
`run` command print it. A run that hits the turn cap is recorded as `blocked`,
not `completed`, and says so in the summary.

`max_turns` in `[agents.<role>]` sets an optional assistant-turn cap. The
default is `0` (no cap); set it only when a role needs a bound.
`budget_tokens` is also unset by default and is opt-in. The only loop guard is
evidence novelty: if recent actions add no new evidence and no edit, write, or
mutating command, the run is killed with a `loop_blocked` event. Provider
retries and model rotations do not refill a configured turn or token budget. A
token budget counts total tokens, including cache reads, so a cache-heavy run
can hit it sooner than its cost suggests.

In the run detail Timeline, `j`/`k` moves between timestamp events. The timeline
follows the newest event by default; `j`/`k` or `PgUp`/`PgDn` turns follow off,
and `F` turns it back on. `v` toggles between key events and all raw events.
`space` expands the selected input, output, reasoning, tool args, or tool
result; `PgUp`/`PgDn` scroll inside a long expanded block. The Overview shows
the outcome summary, a live activity tail, and the latest thinking text.

Press `f` on any run detail section to fork the run settings into a new run.
The New Run composer opens with the same agent, model setting, tier, preset,
verification, issue, ask, approval, ambiguity, min-fit, floors, and request. An
explicit parent model pin is copied; a parent that used
auto-selection stays on auto. A fork of a finished build run reuses the parent
worktree on the same branch, so one branch is not checked out twice.
Edit the request, change any setting, and start the run. The fork keeps parent
lineage. A blocked or failed parent contributes its objective, status, and
error, but not its closing summary as authoritative context. Only a completed
parent contributes a result.

The New Run **Model[m]** picker lists every model from configured providers
with a status: `✓` eligible, `⏸` cooling with the remaining time, or `✕` with
the rejection reason (paid only, below fit or axis floor, no tools, context too
small, and so on). Enter on an ineligible model reports why and keeps the
picker open. The line under **Model[m]** shows the effective floor for the
current tier and floor mode. Press `s` for settings; it explains every preset,
the role mode, the effective agent parameters, and the policy floors.

The loop detector watches evidence, not call shape. A read is one 100-line band
(or symbol/section) at a file version, a search is one scope with one result
set, a command is its output, and a failure is its message. Twenty stale
actions, or the same tool error in three turns, with no edit, write, or
mutating command kill the run with a `loop_blocked` event and a summary that
says so. New evidence resets the stale streak; memory operations do not count
as progress.

Typed commands and runner gates run through the per-run process supervisor. A
read-only command that already passed is cached until an edit, write, or
mutating command changes the tree; a repeat call returns the earlier result with
a cached note instead of running the process again. The
run detail **Processes** section shows each process, its status, pid, and output
tail; `j`/`k` selects one, `F` follows the latest, `o` or Enter opens the log,
`x` kills the selected process, and `X` kills all live processes for the run.
Kill sends SIGTERM, waits briefly, then sends SIGKILL if the process group is
still alive. The record and full logs live under the run
directory:

```bash
machine_code processes <run-id>
machine_code processes logs <run-id> p-0001
machine_code processes kill <run-id> p-0001   # or: all

# dependency-ordered waves, then parallel builds
machine_code batch --dry-run
machine_code batch --max-parallel 4
machine_code batch --auto-approve   # merge gates-gated issues; human-gated never auto-merge
```

`batch` plans priority/dependency-ordered waves over `issues/` and builds todo
issues in parallel child processes. Each build runs in an isolated
`mc/<slug>` worktree, executes the issue's `verify` gates, and — when the
issue's `review` value is `agent` — an independent Review run. `--dry-run`
prints the waves without building. `batch --auto-approve` merges only issues
that reached `done/`: `review = "none"` after gates pass, `agent` only after a
passing Review verdict. `human` issues are never auto-merged — approve them by
hand.

```bash
machine_code approve <slug>   # merge mc/<slug> into main
```

`approve` merges the `mc/<slug>` branch, moves the issue to `done/`, and
commits on main. From the TUI, open an issue and press `n` to start the run it
needs, `v` to review it in the engineer's worktree, `o` to orchestrate the
batch, `b` to build, `a` to approve, and `d` to delete.

Press `D` on a run row or run detail to delete that run record, its worktree
when unshared, and its branch when unshared. Branches shared with another run
are kept unless `--force` is used.

```bash
machine_code runs delete <run-id> --yes
machine_code delete <slug>          # remove the issue + branch (also via TUI `d`)
```

Orphaned running records are marked failed when read and during prune. Map
helper spawns are supervised, along with LSP servers, worktree
creation/commit/remove/prune git helpers, and the synchronous git-status safety
net. There is no MCP client in this build; any future MCP spawn must use the
same supervisor.

Builds run the Engineer directly: one isolated worktree, gates, independent
Review when the issue asks for it, then commit. Roles declare no orchestration
modes, and there is no delegation layer beyond `batch` spawning parallel
`build` children.

### Issue lifecycle

`batch` is the right path for a ready set of issues. The single-issue commands
are the same lifecycle one issue at a time, with a human decision between build
and merge.

```bash
machine_code issue list
machine_code issue create features <slug> "do the thing" --verify core:check
machine_code build <slug> [--review]
machine_code approve <slug>   # merge mc/<slug> into main
machine_code delete <slug>
```

- `issue list` shows the issues tree; `issue create <kind> <slug> "<prompt>"`
  scaffolds `issues/<kind>/<status>/<slug>.md`.
- `issue move <slug> <todo|blocked|done|researched>` moves it between status
  dirs; one issue = one file-level change.
- `build <slug>` creates
  the isolated `mc/<slug>` worktree, runs Engineer, executes the issue `verify` gates,
  commits, and runs an independent Review when `review = "agent"`.
  `--no-review` skips the Review agent.
- `approve <slug>` merges the branch, moves the issue to `done/`, and commits
  the planning write on main.

An issue file is plain markdown whose text is the prompt. Nothing else is
required — a file with a single sentence is a valid issue. Optional `key:
value` header lines at the very top set metadata (`priority`, `review`,
`tags`, `depends`, `acceptance`), followed by a blank line:

```markdown
priority: high
tags: tui
acceptance: core:check

# Make the thing fast

Detail the prompt needs.
```

Two different contracts live here:

- **`acceptance`** is the machine gate: named commands the runner executes.
  It proves the build/check passes; it cannot prove the change is the right
  one. Features and bugs default to `core:check` when none is named.
- **The prompt** is the semantic definition of done: observable behavior and
  constraints. `review: agent` asks an independent agent to judge that
  definition; `review: human` leaves the merge decision to a person.

Verification commands must be named registry commands
(`core:check`, `script:typecheck`, and so on), because gates dispatch
through the command registry — never shell strings.

### Composer context and reusable tools

The new-run composer previews exactly which issue, files, tools, scripts,
references, and skills the selected run will inherit before it starts. The
**Issues** subtab lists `issues/` files; `space` includes one explicitly. The
**Files** subtab lists repo files; press `space` on a file to include it
explicitly. The **Skills** subtab lists every installed skill; `space` cycles
description-only, full body, and excluded. The **Tools** subtab lists every
tool available to the selected agent, plus custom repository/machine tools.
Core tool definitions are sent with every request, so their schema tokens are
included in the estimate and cannot be
excluded as context. The **Agent Prompt** subtab lists every line of the
resolved agent system prompt being previewed; like core tools it is fixed and
cannot be switched off. Every subtab supports `/` filtering and `j/k`
scrolling.

### Model availability

`machine_code availability` shows cooling models and provider health.
`machine_code model probe <key>` checks one model. Metadata probes use free
provider endpoints and never send a paid inference request. The optional
`free-models` mode permits a capped 1-token probe for zero-price models only;
it consumes provider request quota, not money.

```toml
[availability]
probe = "metadata"          # off | metadata | free-models
interval = "5m"
timeout_ms = 5000
free_completion_max_per_hour = 2
```

Runs probe cooling models before creating the run record, then select only from
models that are ready. The TUI refreshes cooling models on a timer, coalesces
concurrent probes for one model, adds jitter when probing several at once, and
shows `probing` while a manual probe is in flight. Metadata can clear a missing-model cooldown, but not a rate-limit or timeout
cooldown; those require the opt-in free completion probe. An unknown result
leaves the cooldown in place.

Prompted runs: every run has a stable id, an append-only event log, and a
transcript checkpoint. Engineer runs get their own `mc/<slug>` worktree and
branch; Research and Review never create one. Runs can ask clarifying
questions, be paused/forked, and resume after a restart.

### Repository map, run state, and prompts

`machine_code map [path]` prints the deterministic file and symbol map. It is
cached under `.machine_code/local/cache/map.json`; `--status` shows map, module,
and LSP health; `--semantic` adds the module index; `--refresh` rebuilds the
deterministic cache.

The index has two layers:

- **Deterministic map** — file inventory, line counts, top-level symbols,
  large-file section headings, and resolved TS/JS import edges. Always
  available; no model call.
- **Module index** — module summaries, key files, search keywords, and
  dependency edges, derived entirely from the map and each file's doc header.
  Built on demand and never cached as a second artifact, so it cannot go stale
  or contradict the code.

LSP is a separate on-demand layer for exact definitions, references, hover,
diagnostics, and rename. It is never required to build the map or module index.

Deterministic symbol and documentation extraction covers TypeScript/JavaScript,
Python, Rust, Go, Shell, Java, C#, Kotlin, Swift, Ruby, PHP, Lua, C/C++, Dart,
Elixir, and Scala. Import edges resolve for TypeScript/JavaScript, Python, and
Rust; LSP provides exact references for other languages. `src/tui.ts` and
`src/tui/*` share the `src/tui` module, so an entry file and its submodules are
described together. Files over 400 lines also get a file-level entry whose
keywords include their comment section headings, so a monolithic file is
searchable by section.

Every run builds the module index from the live map and puts a query-ranked
slice in the up-front context (capped at 3 KiB). File entries appear in `map`
results. `map { "action": "semantic" }` ranks modules and large files by
keyword overlap and returns their key files and dependency edges, so an agent
can go from a concept or filename to the right file in one call.
`map { "action": "graph" }` renders the deterministic module import graph,
optionally ranked by a query.

Each run keeps its working memory outside the transcript:

```text
.machine_code/local/runs/<id>/
  state.jsonl   facts, decisions, changes, next action, read coverage
  state.md      readable snapshot
  artifacts/    content-addressed tool bodies
```

The model sees the run state, an always-on overview (issues, repo map, module
index), the full prior transcript, and no hidden task pack. The prompt is
exactly the context curated in the composer plus the always-on indexes. There
is no automatic preload, dependency expansion, inferred verification list, or hidden
note scoring: the model
reads, searches, or expands a symbol when it needs more. Context is assembled
in priority order. If it exceeds the
selected model's input budget, the run records a warning and names the omitted
or truncated sources; the pre-run composer warns at 80% and over budget. A
past-end read is an
error and never creates read coverage. The state block includes merged Read
coverage per file with its artifact ids, so the model can see what it already
knows and can recall the bytes. Exact read bytes also stay in a run ledger: an
unchanged re-read returns the cached bytes, a changed file drops its entries,
and the prompt includes acquired bytes not already in the curated context. An
edit invalidates only the read ranges that overlap the change. A next action older than six turns expires and is shown as
unset. The `context` tool records decisions, focuses ranges, recalls artifacts,
and resolves facts. A prompt near the selected model's input budget records a
warning; an over-budget prompt names the omitted or truncated sources instead
of silently changing the context.

`machine_code prompts [role]` prints the rendered agent prompt with its size.
Prompts share `data/prompts/base.md`; role files carry only short deltas.
Every rendered prompt ends with generated `Config:` and `Tools:` lines. The
config line names the preset, verification, ask
availability, and approval mode. The tools line is the exact post-filter list,
so a role never sees a tool it cannot call. When `ask` is unavailable, the
ambiguity policy says to stop and report the question instead of asking.

Research holds only `context`, `read`, `map`, `glob`, `grep`, `ask`,
`skill`, and `write`. It reads one idea, asks until the scope is precise, and
writes concrete features/bugs as issue files under
`issues/features/todo/` or `issues/bugs/todo/`. Engineer holds `context`,
`read`, `write`, `edit`, `map`, `glob`, `grep`, `command`, `ask`,
`artifact`, and `skill`; it plans and builds in one run in a `mc/<slug>`
worktree. Review is read-only and judges the same worktree and commit the
Engineer used.

The file tools are deliberately split, close to Claude Code's model:

- `read { "path": "src/tui.ts" }` returns numbered lines. It reads one page of
  at most 25k tokens; whole files over 256 KB need `offset`/`limit` or
  `allow_large: true`. Use `offset`/`limit` to page.
- `glob { "pattern": "src/**/*.ts" }` lists paths.
- `grep { "pattern": "GRAY", "ignoreCase": true }` is plain ripgrep.
- `map` is code-structure search: `overview`, `outline`, `symbols`, `locate`,
  `references`, `definition`, `info`, `semantic`, `graph`, `sections`, and
  `structural`. Use it for where code lives and how it connects, not raw text.
- Basic filesystem work is typed commands, not a shell: `core:mkdir`,
  `core:move`, `core:copy`, and `core:delete`. `write` already creates parent
  directories; directory copies/deletes require `recursive: true`.
When an Engineer run has an issue in a worktree, the runner owns the finish:
it runs the issue's `verify` gates, commits the branch, moves the issue to
`done/` (or `blocked/`), and starts a Review run when `review = "agent"`, even
if the model stops early. A review that does not approve moves the issue back
to `blocked/`, so `approve` cannot merge rejected work.

An issue is one deliverable: one file-level change and at most **three**
verify commands in `issues/<kind>/todo/<slug>.md`. Split anything bigger into
several issues joined by `depends`. Set `review = "agent"` for consequential
work and `review = "human"` when it must not auto-merge; otherwise `none`
(gates only) applies.

There is no annotation cache and no map-side model call. After a mutating
turn, the runner rebuilds the map from the working tree; the cache key covers
git HEAD, git status, and every file's path, size, and mtime, so unchanged
trees return the cached map. The module index is rebuilt from that map in the
same pass.

Map configuration lives in `~/.machine_code/config.toml`:

```toml
[map]
enabled = true
semantic = true   # deterministic module index in the up-front context
```

### Language servers

LSP is optional and lazy. The registry covers TypeScript/JavaScript, Python,
Rust, Go, C/C++, Java, Bash, Lua, YAML, JSON, HTML, CSS, Vue, Svelte, Ruby, PHP,
C#, Kotlin, Swift, Zig, Terraform, Dockerfile, Nix, CMake, LaTeX, Markdown,
Clojure, and Dart. A missing server disables only that language; map, outline,
sections, text, and structure search still work.

`machine_code lsp list` shows every server, its file types, whether its binary
is on PATH, and the install hint. `machine_code lsp status` shows only the
servers whose languages appear in the current repo. `machine_code lsp install
[language]` prints the structured install command for common servers; add
`--run` to execute it. Without a language it lists every available installer.

Map actions:

- `map { "action": "outline", "path": "src/tui.ts" }` uses LSP document symbols
  when a server is available, then falls back to the deterministic top-level
  outline.
- `map { "action": "sections", "path": "src/tui.ts" }` lists comment headings
  inside one file. Use it for large files whose useful blocks live inside one
  giant function.
- `map { "action": "graph", "pattern": "context" }` renders the module import
  graph, with module summaries and query-ranked modules.
- `map { "action": "symbols", "path": "src/loop.ts", "pattern": "RunRecorder" }`
  uses LSP document symbols when a path is given, workspace symbols otherwise,
  then falls back to the repo map.
- `map { "action": "definition" | "references" | "info", "path": ..., "line": ..., "column": ... }`
  uses the server inferred from the path (or `language`).
- `map { "action": "locate", "pattern": "RunRecorder" }` returns definitions
  plus text references, with read anchors.
- `map { "action": "structural", "pattern": "console.log($X)" }` runs ast-grep
  structural search.
- `core:check` and `core:rename` infer the language from the path.

Language IDs are per extension, so TSX uses `typescriptreact` and SCSS uses
`scss`. The client passes the user's environment to the server so toolchains
such as Rust, Go, Java, and C/C++ find their homes.

### Repository knowledge

Repo facts come from the code itself: module doc headers plus the
deterministic map (`core:map`, `map outline/locate`, `grep`). There is no
Knowledge tab and no knowledge directory is injected — a hand-maintained
architecture note drifts from the code, and every run pays for the stale
version.

External material belongs in the reference store
(`~/.machine_code/references/`), read on demand through the `reference` skill.
A project `docs/` folder is for notes that a human or an issue attaches
explicitly; it is not injected.

Remaining work: [issues/](issues/).
