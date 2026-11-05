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

# plan an Epic/Feature/Task graph
node dist/cli.js run --agent planner "plan the thermal model work"

# implementation run through the orchestrator (isolated Task worktree)
node dist/cli.js orchestrate start --scope feature --feature 20

# agent configuration (preset + explicit overrides)
node dist/cli.js run --agent planner --preset plan --ambiguity precise "plan the release"

# follow-ups, pause/fork, resume after a crash
node dist/cli.js respond <run-id> "use leapfrog"
node dist/cli.js pause <run-id>
node dist/cli.js fork <run-id> "instead, use RK4"
node dist/cli.js resume <run-id>

# issues (reserved Feature 0 / Task 0 enforced by the harness)
node dist/cli.js issue tree 10
node dist/cli.js issue ensure 10
node dist/cli.js issue delete 31 --yes
node dist/cli.js issue delete 98 --cascade --yes
node dist/cli.js accept 31
node dist/cli.js approve 31

# one task at a time, without the scheduler
node dist/cli.js task status 31
node dist/cli.js task start 31
node dist/cli.js task start 31 --retry
node dist/cli.js task review 31
node dist/cli.js task approve 31

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

# worktrees, inspection, run cleanup
node dist/cli.js worktree list
node dist/cli.js runs delete <run-id> --yes
node dist/cli.js runs                 # Epic → Feature → Task → runs + untracked
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

`paid` considers free and paid rows (a free model can win); paid rows from
unfunded providers are excluded. `free` only admits zero-price rows.
The New Run composer starts from this tier; press `t` there to override it for
one run. `--tier` overrides it from the CLI.

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
whose cached issue is missing under Orphaned issue. Select an Epic, Feature, or
Task and press `p` to open a Pipeline view scoped to that issue.

Runs attach to Tasks only. Selecting an Epic or Feature for a planner/review
run resolves to that scope's reserved Planning & Review Task 0. Selecting a
deliverable Task resolves a Planner run to its parent Feature's Planning &
Review Task 0; a Task under reserved Feature 0 uses the Epic's Planning &
Review Task 0. Review runs stay on the deliverable Task. A planner/review run
derives its objective from the selected Epic, Feature, or Task, not from the
anchor Task. A build or sudo run with issue-create access auto-creates the
missing Task. A planner run that
starts before the Epic or Feature exists links itself to the new scope's
reserved Task 0 when it creates the first issue. A Task can own multiple runs;
they appear as children of the Task row, while Epic and Feature rows show
rollup counts. There are no direct Epic/Feature run rows.

`--group status` keeps repository headings but groups each repository's runs by
run status with no issue tree. `--group overall` drops repository headings
entirely and groups every run on the machine by status, so blocked, failed, and
running work is visible at a glance. `machine_code status` is shorthand for the
overall view. In the TUI, `g` cycles GH issue → Status → Overall status.

In the GH issue view, the highlighted row keeps its branch bright: the selected
issue or run, its parent issues, its peers at the same level, and its immediate
children (features under an epic, tasks under a feature, runs under a task).
Unrelated rows dim to gray. Repository and section headings stay bright so the
page structure remains readable.

`machine_code show <run-id>` exposes the same overview, summary, context,
changes, related lineage, and event stream as the run detail screen.
`machine_code spend` and `machine_code models` cover the catalogue and cost
views without the TUI.

Every terminal run records a deterministic outcome summary in
`run.json.summary` and a `run_summary` event. The summary is generated from the
event stream and run state, so it exists even when the model produced no final
message (turn cap, provider failure, interruption). It lists the stop reason,
issues created, files changed, reads/searches/commands, retries, errors, and
the model's final response. `machine_code show`, the TUI Overview, and the
`run` command print it. A run that hits the turn cap is recorded as `blocked`,
not `completed`, and says so in the summary.

`max_turns` in `[agents.<role>]` sets an optional assistant-turn cap. The
default is `0` (no cap); set it only when a role needs a bound.
`budget_tokens` is also unset by default and is opt-in. The only loop guard is
an exact repeat: the same tool call with the same arguments three times in a
row. Provider retries and model rotations do not refill a configured turn or
token budget. A token budget counts total tokens, including cache reads, so a
cache-heavy run can hit it sooner than its cost suggests.

In the run detail Timeline, `j`/`k` moves between timestamp events. The timeline
follows the newest event by default; `j`/`k` or `PgUp`/`PgDn` turns follow off,
and `F` turns it back on. `v` toggles between key events and all raw events.
`space` expands the selected input, output, reasoning, tool args, or tool
result; `PgUp`/`PgDn` scroll inside a long expanded block. The Overview shows
the outcome summary, a live activity tail, and the latest thinking text.

Press `f` on any run detail section to fork the run settings into a new run.
The New Run composer opens with the same agent, model setting, tier, preset,
verification, issue tracking, ask, approval, ambiguity, min-fit, floors, issue,
and request. An explicit parent model pin is copied; a parent that used
auto-selection stays on auto. A fork of a finished build run reuses the parent
worktree on the same issue branch, so one branch is not checked out twice.
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

The harness blocks a third identical tool call with the same arguments and
returns a corrective message; three blocked repeats end the run with a
`loop_blocked` event and a summary that says so. That is the only research
guard: different ranges, new files, and new search scopes are left to the
model and the prompt. `command describe issue` returns a direct hint that
`issue` is a tool, not a command.

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

# readiness preview, then one sequential execution pass
machine_code orchestrate status --scope project
machine_code orchestrate status --all
machine_code orchestrate start --scope epic --epic 42
machine_code orchestrate approve --orchestration <id> --task 31
machine_code orchestrate approve --orchestration <id> --task 31 --result
# --result merges the Task PR, records human acceptance, and closes the Task.
# Parent Features/Epics close when their policy is agent; otherwise the next
# approval/acceptance command is printed.
machine_code orchestrate tick --orchestration <id> --dry-run
machine_code orchestrate start --scope epic --epic 42 --checkpoint after-task
```

`start` and `tick` execute ready tasks up to `--max-parallel` at a time through
Build, gates, commit, Review, and PR; tasks sharing a Feature are serialized.
`--max-minutes` and `--max-spend-usd` stop new dispatch when the invocation
budget is exhausted. Build ends with a typed `Outcome:` and Review with a
typed `Verdict:`; both are recorded as events. Completion failures retry with
evidence up to the task's `retries_before_replan`, then stop at
`needs_planning`. `--dry-run` only prints the schedule.

`orchestrate status` shows the selected scope's lease: `RUNNING` with owner and
pid, or `idle`. `orchestrate status --all` lists every orchestration with its
scope, checkpoint, lease, and stop reason. `start` reuses the existing ledger
for a scope, and a lease plus scope-start lock prevents two processes from
running the same scope. The lease renews every 30 seconds while execution is
live.

The TUI Runs tab includes the pipeline. Select an Epic, Feature, or Task in
the Runs list and press `p` to open a Pipeline view scoped to that issue.
`P` does the same from an issue or run detail screen. `r` refreshes the issue
cache, `x` starts execution for the selected scope, `a` approves the selected
packet, `A` finishes the selected task, and Enter opens the selected issue. The
header shows the active orchestration id, checkpoint, and approval counts.
Agent result review closes the Task only after the Task PR is merged; human
result review or a human merge gate waits for `task approve` or
`orchestrate approve --result`. Parent closure cascades only where the parent's
approval policy is `agent`.

In the TUI, `p` on a Task or task run runs `task approve`: commit any remaining
changes, open or merge the Task PR, record acceptance, close the Task, and
remove the worktree. `A` in the Pipeline view does the same for the selected
task and updates the orchestration ledger.

Press `D` on a Runs-list issue or an issue detail to open the issue delete
confirmation. Confirming deletes the issue, its terminal run records, open
PRs, worktrees, and associated local and remote branches. Deleting a Feature
or Epic requires the cascade confirmation and removes the whole subtree.
Use `--keep-runs` on the CLI to preserve run evidence.

Press `D` on a run row or run detail to delete that run record, its worktree
when unshared, and its branch when unshared. Open PR branches are kept unless
`--force` is used.

```bash
machine_code issue delete <issue> --yes
machine_code issue delete <feature-or-epic> --cascade --yes
machine_code issue delete <issue> --yes --keep-runs
machine_code runs delete <run-id> --yes
```

After every Task PR is merged, `machine_code pr feature <n>` runs a final
Feature Review over `main...mc/feature/<n>`, runs integration gates, and opens
the Feature PR to main. The Feature's `mc:approval` decides whether that PR
merges automatically or waits for a human. After the Feature PR merges, record
Feature acceptance and close it with `machine_code accept <feature>` and
`machine_code issue close <feature>`; the same applies to the Epic.

Orphaned running records are marked failed when read and during prune. Detached
delegated runs are tracked as `orchestrator` processes. Map helper spawns are
also supervised, along with LSP servers, worktree creation/commit/remove/prune
git helpers, and the synchronous git-status safety net. There is no MCP client
in this build; any future MCP spawn must use the same supervisor.

The Orchestrator schedules issue-backed work directly: it freezes a packet,
runs Build in an isolated worktree, executes gates, runs an independent Review,
then commits and publishes. Roles no longer declare orchestration modes, and
there is no Architect delegation layer. `queue` remains a compatibility path
for committed packets; new work should use `orchestrate` for a graph or
`task start` for one Task.

### Manual Task lifecycle

The Orchestrator is the right path for a ready graph. The `task` commands are
the same lifecycle for one Task at a time, with a human decision between Build
and closure. They work on both direct Build runs and Orchestrator runs.

```bash
machine_code task status 31
machine_code task start 31
machine_code task review 31
machine_code task approve 31
machine_code task cleanup 31
```

- `task status` shows the plan, latest Build/Review run, worktree, branch,
  commit, PR, acceptance evidence, review checks, the current stage, and the
  exact next command. It never mutates state.
- `task start` requires a ready `mc:plan`. It creates the isolated Task
  worktree and `mc/task/<n>` branch, runs Build, gates, commit, and an
  independent Review of that commit, then opens the Task PR. It honors
  `result_review`: `agent` approves the result, but closure still waits for the
  issue merge policy; `human` stops for review. `--review` overrides the plan
  and `--no-review` skips the Review agent. `--retry` reuses the blocked/failed
  worktree for another Build.
- `task review` shows the same state, then runs the Task's `## Verification`
  commands in the worktree. Use `--check <command>` or
  `--checks a,b` to run exact commands. Named commands (`typescript:test`) go
  through the command registry; other strings run in a shell inside the
  worktree. Checks are recorded on the run. A failed check blocks
  `task approve` unless `--force` is used.
- `task approve` is the human finish step. If the worktree has uncommitted
  changes it commits them, then opens the Task PR if needed, merges it, records
  acceptance, closes the Task, and removes the worktree. Use `--no-commit`,
  `--no-merge`, `--keep-worktree`, or `--keep-branch` to narrow it.
- `task cleanup` removes a worktree without closing the Task. It refuses an
  open Task unless `--force` is used.

A Task body can keep acceptance in prose. Runtime gates come from a
`## Verification` section:

````markdown
## Verification

```
npm run typecheck
npm test
```
````

The runner maps common npm commands to the typed registry
(`typescript:typecheck`, `typescript:test`, and so on). Acceptance lines that
are named commands remain supported.

### Issue context and reusable tools

An issue can declare a compact context block; the harness merges Task →
Feature → Epic, nearest first:

```markdown
<!-- mc:context
{"files":["src/parser.ts"],"knowledge":["knowledge/parser.md"],
 "references":["glsl/4.60.8/content/glsl-8-3-common-functions.md#8-3-common-functions"],
 "skills":["reference"],"tools":["bench"],"scripts":["release-check"]}
-->
```

`references` cites exact files and anchors in the central
`~/.machine_code/references/` store. The store keeps archival bundles and a
generated index layer; use `reference:find`, `reference:read`,
`reference:write`, and `reference:reindex` rather than reading bundle content
or `raw/` directly. `reference:reindex` regenerates the catalog, topic map,
and per-bundle symbol index from `manifest.yaml` and content front-matter.

Tools live in `.machine_code/tools/<name>.toml`, scripts under
`.machine_code/scripts/`. `machine_code tools new <name>` scaffolds both.
Planner can inspect them and provision tool manifests with the `artifact` tool
(`list`, `show`, `usage`, `create`, `update`). Executable scripts require the
explicit `--allow-artifact-scripts` run flag. Planner writes task policy with the issue
`plan` action, which inserts or replaces the `mc:plan` marker. The new-run
composer previews exactly which files, tools, scripts, and issues the selected
run will inherit before it starts. The **Issues** subtab nests each issue's
`mc:context` files under that issue; there is no separate Files subtab. An
issue with no marker shows `no mc:context files`, because files enter the
prompt only when the issue body declares them. The **Tools** subtab lists every tool
available to the selected agent, including `issue` with its access level, plus
custom repository/machine tools. Core tool definitions are sent with every
request, so their schema tokens are included in the estimate and cannot be
excluded as context.

Skill descriptions are always visible and appear as one row per skill in the
**Skills** subtab even when no issue references a skill body. **Knowledge** and
**Scripts** also list available files and manifests, marked `·`. Their rows
show the content-size estimate with an `avail` suffix, but available entries
are not counted in the section or footer token totals until they are part of
the assembled context. Press `space` on an available knowledge file to include
it; the composer passes it through `--context-include`. Files and knowledge
enter the prompt otherwise only when an issue's `mc:context` block, or the
configured knowledge index, references them.

Each skill description can be switched off independently with `space`; that
writes the `skill:<name>` exclusion, which removes both the description line
and any referenced skill body. Turning off the whole Skills section still
works as before.

Skills live in `.machine_code/skills/<name>/SKILL.md`. Only descriptions are
always visible; the body loads when an issue references the skill. The curation
policy and the kept set are in
[knowledge/skills-curation.md](knowledge/skills-curation.md).

### Issue access and model availability

Each role declares one `issue_access` level: `none`, `read`, `plan`, or
`create`. The harness derives `issue:read`, `issue:plan`, and `issue:create`
from it and removes the `issue` tool when access is `none`. Planner has
`create`; Build, Review, and Sudo have `read`; General has `none`.
Sudo and other roles may opt in per run with `--allow-issue-create`. The
new-run agent picker and run Overview show an `issues:*` badge, and
`machine_code policy` prints the effective level. Create access is required for
new Epic, Feature, or Task issues.

```toml
# data/agents/<role>.toml
issue_access = "read"   # none | read | plan | create
```

Creating an Epic also creates reserved **Feature 0: Planning & Review** and
**Task 0: Planning & Review** beneath it. Creating a Feature also creates a
reserved **Task 0: Planning & Review**. These are coordination anchors, not
deliverables. The Planner is told to ignore them; the issue tool marks them
`[reserved]` in run state and rejects a Task created under reserved Feature 0.

Every issue body must carry its context when it is created or edited. All
issues need `## Context`: why the issue exists, the parent scope, relevant
files/symbols, and constraints. Epic and Feature bodies also need `## Goal` and
`## Scope`; Features need `## Success measures`; Tasks need `## Deliverable` and
acceptance criteria. The `issue` tool rejects a create, graph, or body edit that
misses these sections. This keeps context at creation time instead of requiring
a later review. When the body names files, the issue tool also infers an
`mc:context` file list from those paths and the semantic map. That list is what
the context cascade shows and what Build preloads. Legacy issues can be repaired
with `issue action=edit`.

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
transcript checkpoint. Build and orchestrated runs get their own worktree and
branch; Sudo edits the main tree by default (`--worktree` opts into isolation);
General and Review never create one. Runs can ask clarifying questions, be
paused/forked, and resume after a restart.

### Repository map, run state, and prompts

`machine_code map [path]` prints the deterministic file and symbol map. It is
cached under `.machine_code/local/cache/map.json`; `--status` shows map, semantic,
and LSP health; `--semantic` adds module annotations; `--refresh` rebuilds the
deterministic cache.

The index has three layers:

- **Deterministic map** — file inventory, line counts, top-level symbols,
  large-file section headings, and resolved TS/JS import edges. Always
  available; no model call.
- **Semantic index** — module summaries, key files, search keywords, and
  dependency edges. Deterministic by default; LLM annotations are an optional
  overlay. It is persisted as `semantic.json` and powers the TUI `SEM` token.
- **LSP** — exact symbol definitions, references, hover, diagnostics, and
  rename for the current language server. On demand; never required for the
  deterministic or semantic layers.

Deterministic symbol and documentation extraction covers TypeScript/JavaScript,
Python, Rust, Go, Shell, Java, C#, Kotlin, Swift, Ruby, PHP, Lua, C/C++, Dart,
Elixir, and Scala. Import edges resolve for TypeScript/JavaScript, Python, and
Rust; LSP provides exact references for other languages. Module summaries prefer
file headers and doc comments, so a documented codebase gets a conceptual
semantic overview without an LLM call.

Semantic annotations are module-level summaries with key files, edit hints, and
search keywords. Files over 400 lines also get a file-level entry whose
keywords include their comment section headings, so a monolithic file such as
`src/tui.ts` is searchable by section. Every run builds a deterministic module
index immediately from the repo map, so the semantic index is always fresh and
costs no model call. The deterministic index is persisted to
`semantic.json` when no fresh annotation overlay exists, so the TUI `SEM` token
and `search semantic` see it without an LLM call. Module entries also carry
deterministic `deps` from TS/JS imports. LLM annotations are optional: they
refresh only when `map.semantic_model` is pinned or `map.refresh = "always"`;
otherwise the deterministic index is used. Generate them on demand with
`machine_code map --semantic --refresh`. The startup semantic map is
module-level and capped at 3 KiB; file entries appear in `search` results.
`search { mode: "semantic" }` ranks modules and large files by keyword overlap
and returns their key files and dependency edges, so an agent can go from a
concept or filename to the right file in one call. `search { mode: "graph" }`
renders the deterministic module import graph, optionally ranked by a query.

Each run keeps its working memory outside the transcript:

```text
.machine_code/local/runs/<id>/
  state.jsonl   facts, decisions, changes, next action, read coverage
  state.md      readable snapshot
  artifacts/    content-addressed tool bodies
```

The model sees the run state, a bounded working context of current files, and
the last two complete tool steps, not the full tool history. The state block includes merged Read
coverage per file with its artifact ids, so the model can see what it already
knows and can recall the bytes. An edit invalidates only the read ranges that
overlap the change. Build and sudo runs seed the files named by the task and
their inferred tests into the working context before the first turn; the
working context is capped and re-read from disk after edits, so it stays
current. A next action older than six turns expires and is shown as unset. A
back-to-back re-read of the same 100-line band returns a nudge with the artifact
id instead of the same bytes; a later re-read after other work is allowed. The
`context` tool records decisions, focuses ranges, recalls artifacts, and
resolves facts. A prompt that exceeds the run envelope or 90% of the selected model's
window blocks and writes a split report instead of truncating.

`machine_code prompts [role]` prints the rendered agent prompt with its size.
Prompts share `data/prompts/base.md`; role files carry only short deltas.
Every rendered prompt ends with generated `Config:` and `Tools:` lines. The
config line names the preset, issue tracking, issue access, verification, ask
availability, and approval mode. The tools line is the exact post-filter list,
so a role never sees a tool it cannot call. When `ask` is unavailable, the
ambiguity policy says to stop and report the question instead of asking.

The Planner holds only `context`, `read`, `search`, `ask`, and `issue`. It
inspects the issue list/tree, reuses a suitable Epic or Feature, creates the
missing level with body context, adds acceptance criteria and dependencies, and
applies `mc:plan` to Tasks. It does not hold `command`, `artifact`, or `pr`, so the
`command describe issue` detour is impossible. Build and Review say `ask off`
and report blockers; their ambiguity policy matches.

A Task is one deliverable: one file-level change and at most **three**
acceptance criteria, with a body under 4,000 chars. Its body carries
`## Context`, `## Deliverable`, and acceptance criteria. The harness enforces
size when a Task is created, edited, or planned as ready, including graph
creation. It enforces body context on create, graph, and body edit. An
oversized Task fails before it exists. A build run refuses an existing
oversized Task and tells the operator to run the Planner. The Planner splits
an oversized Task by editing it to one slice and creating sibling Tasks under
the same Feature.

LLM annotations are optional. An `edit`/`write` appends its path to
`semantic.dirty` and a bounded entry to `changes.jsonl` with the turn, changing
agent/model, tool result, line delta, and one-line intent. After any mutating
tool, a git-status delta also catches deletes, renames, formatters, and
command-side writes; it stores status codes and fingerprints, never file
content. The semantic call reads the deterministic map slice, dirty modules,
existing annotations, and that digest, never the transcript. At most one refresh
is in flight; further changed turns queue one follow-up, so edits never become
per-edit model calls. Spend groups the calls as `map (semantic)`. Automatic
annotation refresh happens only when `map.semantic_model` is pinned or
`map.refresh = "always"`; otherwise the deterministic index is used and no
annotation call is made.

Map configuration lives in `~/.machine_code/config.toml`:

```toml
[map]
enabled = true
semantic = true
semantic_model = ""    # pin a model, or leave empty for automatic selection
refresh = "on-change"  # on-change | manual | always
```

### Language servers

LSP is optional and lazy. The registry covers TypeScript/JavaScript, Python,
Rust, Go, C/C++, Java, Bash, Lua, YAML, JSON, HTML, CSS, Vue, Svelte, Ruby, PHP,
C#, Kotlin, Swift, Zig, Terraform, Dockerfile, Nix, CMake, LaTeX, Markdown,
Clojure, and Dart. A missing server disables only that language; map, outline,
sections, text, and structure search still work.

`machine_code lsp list` shows every server, its file types, whether its binary
is on PATH, and the install hint. `machine_code lsp status` shows only the
servers whose languages appear in the current repo.

Tool modes:

- `search { mode: "outline", path: "src/tui.ts" }` uses LSP document symbols
  when a server is available, then falls back to the deterministic top-level
  outline.
- `search { mode: "sections", path: "src/tui.ts" }` lists comment headings
  inside one file. Use it for large files whose useful blocks live inside one
  giant function.
- `search { mode: "graph", pattern: "context" }` renders the module import
  graph, with semantic summaries and query-ranked modules.
- `search { mode: "symbols", path: "src/loop.ts", pattern: "RunRecorder" }`
  uses LSP document symbols when a path is given, workspace symbols otherwise,
  then falls back to the repo map.
- `search { mode: "definition" | "references" | "info", path, line, column }`
  uses the server inferred from the path (or `language`).
- `core:check` and `core:rename` infer the language from the path.

Language IDs are per extension, so TSX uses `typescriptreact` and SCSS uses
`scss`. The client passes the user's environment to the server so toolchains
such as Rust, Go, Java, and C/C++ find their homes.

### Repository knowledge

`knowledge/index.md` is the English-language entry point. When it exists,
`loadMachineConfig` includes it in the context bundle by default; set
`[context] knowledge_index = "..."` to choose another file, or `""` to disable.
The index links to deeper notes such as `knowledge/architecture.md`. The
deterministic module index handles "where is this code"; the knowledge files
handle "why is this code shaped this way".

Design and remaining work: [plans/plan.md](plans/plan.md).
