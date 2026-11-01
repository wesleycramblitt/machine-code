# machine_code — v1 plan

> A Linux-first, file-based coding-agent tool optimized for correctness per dollar.

## 1. Goals

Complete real repository tasks with fewer mistakes, tokens, and less time than general-purpose coding tools.

**Success measures:** ≥80% on a fixed 12-task suite; lower cost per completed task than `pi` and `mini-swe-agent` on the same model; p50 time within 20% of `pi`; every completed change has runner-executed evidence; interrupted work resumes explicitly without replaying unfinished calls.

**Out of scope:** arbitrary shell, permission prompts, automatic merge/PR, daemon/API, public plugin SDK, embeddings/index server, and an always-on agent scheduler. Worktrees isolate changes, not host execution; container isolation is deferred to M5 and must default to network off.

## 2. Principles

- Files are state, Git is history, and tests are truth. One loop, file-based state, and one run-event format.
- Each agent starts with a small, explicit context; load files and skills on demand. No special `AGENTS.md` loading.
- Use the fewest core tools. Add capabilities through typed manifests and profiles.
- The runner verifies work; model assertions do not complete tasks.
- Keep machine config, committed repo policy, and generated runtime state separate. Every abstraction must earn its complexity.

## 3. Design

### Runtime and dependencies

Linux only; TypeScript on Node 22+. Use exact lockfile pins for `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, behind local `Loop` and `Models` interfaces. Upgrade deliberately and run the eval suite; vendor only if upstream becomes unusable. `machine_code init` checks the six base CLIs and enabled profile dependencies.

### Models and providers

- **Credentials/catalogue:** use `pi-ai`'s standard environment variables; never store keys in files. `machine_code providers` reports configured providers and key sources. `machine_code catalogue refresh` combines provider metadata, OpenRouter benchmarks, run measurements, and dated curation into `~/.machine_code/catalogue/models.json`; retain provenance with precedence generated → benchmark → measured → curated.
- **Config:** machine `config.toml` sets rate caps, vetoes, default `max_output_tokens`, and default packet mode; it may also set project-path price overrides. Repo `policy.toml` sets per-agent requirements and may override the output ceiling. Agent override wins over machine default; the effective value is capped by the selected model's maximum. If neither config sets a value, use that model maximum. The ceiling is distinct from total `budget_tokens` and the selector's fixed expected-output estimate. Reject settings below the expected-output value. Price caps are per-million-token rates, evaluated at the context-length tier used; committed repo policy cannot set money.
- **Selection:** every call runs `pick(agent, requirements, state)`. Estimate input as current-context characters ÷ 4 and output as a fixed value per agent. Hard-filter credentials, tool support, context/output capacity, minimum context, caps, vetoes, and availability; also hard-filter the composite capability floor and any per-axis floors. Then score the role-weighted axis mix (capability quality), estimated cost, speed, and context headroom. Fixed weights are tuned on evals; ties go to lexicographically smaller model ID. No stickiness or automatic model escalation after a failed gate.
- **Fallback and health:** after a retryable provider error, cool the target and try at most one next-best eligible model; select and log each attempt separately. Do not execute tool calls until a valid response arrives. Insufficient funds disables a provider until manual re-enable. Temporary failures cool models/providers on `1m → 5m → 30m → 2h → 12h → 1d → 7d → 30d`, honoring longer `Retry-After` up to 30 days; success resets the tier. Auth failures become `needs-auth`; context/parameter incompatibility excludes the model for the current run; refusals get no fallback; malformed or unknown errors are logged safely and cool the model at the first tier. Availability is shared in `availability.json` under a lock.
- **Accounting:** log every selection, estimate, filter summary, and candidate scores to per-run `events.jsonl`. Append one ≤4 KiB record per provider attempt to machine-wide `spend.jsonl`, linked by unique call ID; report actual and estimated spend separately by day, project, provider, and model. CLI/TUI expose provider enable/disable and cooldown-clear actions. Catalogue refresh does not clear health state.
- Copy only the pure scoring, calibration, and OpenRouter parsing functions from `model-selector`; do not import from OpenCode config or port its tier model; selection has only free/paid here.

### Tools, profiles, and search

Exactly six core tools:

| Tool | Function |
|---|---|
| `read`, `write`, `edit` | Bounded file access; `edit` requires a unique exact match. |
| `search` | Read-only search in ten modes: map, files, text, structure, JSON, YAML, definition, references, workspace symbols, hover/info. |
| `command` | Describe or run one named typed command from core, repo/global manifests, profiles, or gates. |
| `task` | Spawn a bounded fresh-context child; available to Architect and Build, and to Sudo in solo mode. |

The six-CLI base palette is `git` (worktrees/history/diffs), `rg` (text and file listing), `ast-grep` (`sg`, syntax-shape search/rewrites), `jq` (JSON), `yq` (YAML), and `sd` (regex-by-default/literal with `-l` replacement). Edit precision: LSP for symbol rename, `ast-grep` for syntax shapes, `sd` for text. `rg` covers `grep`/`find`/`fd`; other exclusions include `sed`/`awk`/`perl`, `ctags`, tree-sitter CLI, `comby`, `jscodeshift`/`ts-morph`, `semgrep`, `scip`/`lsif`, presentation/interactive tools, profilers, watchers, and GNU `parallel`.

Language profiles declare optional LSP servers: TypeScript (`typescript-language-server`), Python (`pyright-langserver`), Rust (`rust-analyzer`), Go (`gopls`), C/C++ (`clangd`). A thin client uses `vscode-jsonrpc` and `vscode-languageserver-protocol`. Start one server per project lazily under time/memory budgets; it dies with its owner. Missing, over-budget, or indexing servers fall back to `ast-grep`/`rg`, with the fallback logged. LSP results are advisory and may be incomplete or stale. `core:check` supplies fast per-file diagnostics; profile lint/typecheck and gates remain authoritative.

Profiles are TOML manifests mapping shared verbs (`build`, `test`, `lint`, `format`, `typecheck`, `run`) to project tools. Initial profiles: TypeScript, Python, Rust, Go, shell, SQLite/data, GitHub; containers and reference ingestion are M5. Missing binaries are configuration gaps, not cooldowns.

Commands use fixed executables/argument vectors, typed arguments, timeouts, minimal environment, and capped output. Validate arguments and call with `execFile`; never interpolate shell strings. Kill process groups on timeout/interrupt and never pass provider secrets. Core commands:

| Read-only | Mutating |
|---|---|
| `core:status`, `diff`, `history`, `show`, `check` | `core:move`, `copy`, `delete`, `replace`, `rewrite`, `rename` |

Mutators belong to Build; Sudo gets all configured commands. `core:rename` previews the LSP workspace edit and reports all touched paths. Bulk replace/rewrite requires explicit path scope and reports paths/counts. All changes are checked in the resulting diff and by runner gates. No arbitrary shell, including for Sudo.

Search/file access stays within the worktree, rejects binaries and symlink escapes, respects `.gitignore`, repo excludes, and built-in excludes (`.git`, `.machine_code/local`, `node_modules`, `vendor`, `dist`, `build`, `target`, `.next`, `coverage`, `.cache`, virtual environments). Default caps: read 24 KiB, search 12 KiB, command 8 KiB; results can be paged. The generated filtered repo map is on-demand, ≤32 KiB, never auto-loaded.

Skills provide instructions, not tools. Prompts list skill names/descriptions; full `SKILL.md` bodies load only on request. `AGENTS.md` is ordinary searchable content. The `reference` skill describes research and curation; only an Architect doing reference work receives task-scoped web search, browser MCP, PDF extraction, and typed reference-index commands. Convert sources into attributed reference bundles, refresh central and project-linked indexes, and write only to `~/.machine_code/references/` and `.machine_code/references/links.toml`—never project code. This integration is M5.

### Agents and modes

Five agents have separate prompts, requirements, and allowlists in `policy.toml`:

- **General:** general questions; only `read`, no search, commands, tasks, or writes. `solo` only.
- **Architect:** explores and compiles an immutable packet (goal, paths, constraints, named gates); does not implement. Read/search/task and read-only core commands only, except scoped reference commands during reference work. Never solo.
- **Build:** code-specific implementation of one packet; cannot re-plan or change packet acceptance commands. It has the file tools and configured mutating/profile commands. `direct` adds no tests; `verified` and `redundant` author focused tests.
- **Review:** fresh, read-only assessment of packet conformance, acceptance coverage, and completion. Read/search/read-only commands only; runs only in `redundant`.
- **Sudo:** explicit rare `solo` agent with all configured repo/global/profile/MCP permissions and core tools. It bypasses Architect, Build, and Review, but still uses worktrees, typed commands, and runner gates for mutations. It does not get arbitrary shell or host-root access.

`solo` requires `--agent general` or `--agent sudo`. Other modes always run Architect → Build; `--agent` is invalid with them. `plan:on/off` does not exist: planning is intrinsic to Architect. General needs no packet; a Sudo request is its packet.

| Mode | Flow |
|---|---|
| `solo` | One General or Sudo invocation. |
| `direct` | Architect → Build without new tests → runner gates. |
| `verified` | Architect → Build with focused tests → runner gates. Default packet mode. |
| `redundant` | `verified` plus a separate Review invocation; completion requires approval. |

Packets may lower, never raise, the configured token budget. Examples: `machine_code run --mode solo --agent general "summarize README.md"`; `machine_code run --mode verified "fix the parser panic"`; `machine_code run --mode solo --agent sudo "update release metadata"`.

### Context, execution, and verification

Each invocation starts fresh with its prompt, request/packet, allowed tool/skill descriptions, and only necessary handoffs. No repo-wide or skill-body preloads. Search/read are on-demand; no auto-compaction in v1. If the token budget is exceeded, Build writes `HANDOFF.md` and stops; resume is a fresh attempt.

Mutating tasks use a clean Git worktree at `.machine_code/local/worktrees/<run-id>` on `task/<task-id>/<attempt>`. A resumed attempt gets a new run ID and reuses the preserved worktree/branch. General read-only questions read within the selected repository and do not need a worktree. No auto-merge; humans merge successful branches.

The runner resolves gates from the packet plus repo defaults and runs named commands after Build (or after a Sudo mutation). A mutating task needs at least one applicable meaningful command; otherwise it is `blocked`. Record exit code, output, duration, and diff. `done` requires all gates to pass and, in `redundant`, Review approval. The runner always records `git diff --check`. No agent can self-certify.

### Persistence and TUI

Machine state is `~/.machine_code/` (override `MACHINE_CODE_HOME`); repo policy is committed under `.machine_code/`; generated/local state is gitignored under `.machine_code/local/`.

| Location | Contents |
|---|---|
| `~/.machine_code/` | `config.toml`, `curation.toml`, catalogue, `spend.jsonl`, `availability.json`, personal profiles/tools/skills, references, instance files. |
| `.machine_code/` | `policy.toml`, `plan.md`, immutable task packets, profiles/tools/skills, five agent prompts, optional `mcp.json`, and reference links. |
| `.machine_code/local/` | Per-run `run.json`, append-only `events.jsonl`, packet snapshot, optional `HANDOFF.md`/repo map/control files, and worktrees. |

`config.toml` reloads atomically before each model call. Repo policy/manifests are snapshotted from the task's base commit. Each run has one writer; spend is the only intentionally shared append-only ledger. Secrets never go in files.

`machine_code` runs in the foreground or TUI; use tmux for persistence. No daemon/socket/network listener. Instances register PID/heartbeat. TUI lists runs across instances and sends sequenced control requests through per-run files. A dead owner is reported `interrupted`; stale command groups are terminated, but runs are never restarted automatically. `status`, `log`, `resume`, and `prune` read/write file state; pruning never removes active/interrupted runs. TUI shows runs/events, providers/health, spend, and settings; only machine defaults (mode, output ceiling, price caps) are editable there. Notifications (M4) are one-way email/webhook on terminal states.

Queue packets are committed files processed in filename order. Completed packets are skipped; interrupted/blocked/failed work stops the queue until explicit resume/requeue. Packets remain immutable and each starts from the current base branch.

### Packet shape

Architect-generated or human-authored packets are immutable once a run begins. Acceptance entries name typed commands, never shell strings:

```yaml
id: fix-empty-parser
mode: verified
budget_tokens: 150000
# goal, context paths, constraints, acceptance command names/typed args
```

Queued packets live in `.machine_code/tasks/`. `direct`, `verified`, and `redundant` imply Architect then Build; a solo packet names `agent: sudo` (General is not for queued implementation).

## 4. Build order

- **M0 — Core and General:** TypeScript app, config/policy loaders, provider/catalogue checks, selector, `pi-agent-core` loop, six tools/base palette, initial built-ins, run event stream. Gate: read-only General works with two providers; Ctrl-C leaves a readable interrupted run.
- **M1 — Packets and agents:** named acceptance runner, TypeScript profile, bounded repo map, all five agents/modes and permissions, LSP search/check/rename. Gate: verified bug fix passes; direct authors no tests but still runs gates; redundant requires Review; Sudo mutations are gated; Architect/Review cannot mutate code; General only reads; no shell; semantic fallback works; rename passes TypeScript gates.
- **M2 — State and health:** run records, status/log/resume/prune, machine-wide spend/availability, error classification, bounded provider retry. Gate: long command survives tmux detach; owner death terminates command group and reports interrupted; explicit resume starts fresh without replay; cooldown/disable/re-enable and one-retry behavior pass.
- **M3 — TUI:** run/instance views, run detail, settings, spend, provider/model recovery actions. Gate: a third TUI observes and interrupts runs owned by TUI and headless instances; one owner can be SIGKILLed without impairing the other.
- **M4 — Queue and notifications:** ordered immutable packets and terminal notifications. Gate: successful packets notify once; after owner death completed packets are skipped and queue stops at interrupted work.
- **M5 — Evidence-based extras:** scoped reference ingestion/indexing (web, browser MCP, PDF, source-attributed bundles and linked indexes), then container sandbox only if evals show value. Gate: reference task searches/opens a web source, extracts a PDF, updates indexes, and uses the source in its packet; General never gets research tools.

## 5. Evaluation and risks

Use 12 workspace tasks (4 fixes, 3 features, 3 refactors, 2 test additions), one strong and one cheap fixed model, and control arms `pi` and `mini-swe-agent`. Record pass/fail, tokens, cost, time, tool calls, retries, interventions, and diff size. Do not ship features without a measured or clear usability benefit.

| Risk | Mitigation |
|---|---|
| Upstream API churn | Exact pins and local interfaces; eval before upgrades. |
| Long tasks exceed context | Hard token budgets, handoff, explicit fresh resume; no silent compaction. |
| Large/generated repos flood context | Exclusions, bounded tools, filtered map, no shell. |
| LSP is stale/heavy/missing | Lazy budgets, logged fallback, advisory-only results; gates are truth. |
| Gate or profile gaps | Typed named gates; missing binaries are configuration errors; report `blocked`. |
| Untrusted code/remote exposure | No listener; SSH/tmux only. Until container isolation exists, run trusted repos. |

**Open decisions:** container runtime (M5); notification channel (M4); profile auto-detection vs explicit opt-in (start opt-in); selector weights and per-agent expected output (eval); validate `ast-grep` and `sd` on largest repos (M0); LSP server defaults/budgets (M1); consider LSP code actions only after diagnostics prove useful.

## 6. Sources

- [Pi](https://github.com/earendil-works/pi): reuse `pi-ai` and `pi-agent-core`, not its CLI or tool surface.
- [Goose](https://github.com/aaif-goose/goose): interoperability reference; avoid hidden model calls and monolithic orchestration.
- [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk): isolation/event-log reference, not a stack to adopt.
- `mini-swe-agent`: small benchmark control arm, not a base.

## 7. Upgrade addendum (2026-10-31)

The harness has been extended beyond this v1 plan. `upgrade-plan.md` is the
authoritative design for the upgrade; the deltas that matter when reading the
sections above:

- **Nine core tools**, not six: `read`, `write`, `edit`, `search`, `command`,
  `task` (real delegation), `ask` (suspend for user input), `issue` (GitHub),
  `pr` (pull requests). `task` is no longer a stub.
- **Agent configuration is separate from run modes.** Roles (general, architect,
  build, review, sudo) carry explicit config: `delegate`, `verification`
  (`direct|verified|redundant`), `issues` (`required|optional|disabled`), `ask`,
  `approval` (`human|agent`), `ambiguity`. `--mode solo/direct/verified/redundant`
  remains as compatibility aliases; `solo` means "this agent cannot spawn
  children".
- **Worktrees are real.** Mutating runs work in
  `.machine_code/local/worktrees/<run-id>` on `mc/task/<n>` (or `mc/run/<id>`),
  based on `mc/feature/<n>`; tools, commands, gates, and LSP run there. Branches
  belong to issues; worktrees belong to runs.
- **Runs persist beyond the process.** `transcript.json` checkpoints plus an
  `inbox.jsonl` make awaiting-input, pause/fork, and resume-after-restart work;
  the `ask` tool suspends a run without creating a new one.
- **GitHub issues are the work index.** Every Epic gets one reserved
  `Feature 0: Planning & Review`; every Feature gets one reserved
  `Task 0: Planning & Review`. Runs attach to Tasks only; Epic/Feature planning
  resolves to the reserved Task 0. Duplicate empty reserved issues are closed.
- **Context is assembled per run** from the Task→Feature→Epic hierarchy, explicit
  packet/knowledge/skill references, the project plan, and the parent run, with
  a provenance manifest (`context.json`) and a character budget.
- **PRs are runner-owned.** After gates/review the runner commits the worktree,
  pushes the branch, and opens a Task PR into the Feature branch; after all
  deliverable tasks close, `pr feature <n>` runs integration gates and opens the
  Feature PR to main. Approval defaults to human (TUI/CLI approve), with
  per-issue opt-in agent merges; squash merges.
- **TUI**: issue-tree grouping with rollups/health, header counts, filters/sort,
  awaiting-human filtering, issue cache, and run detail metadata.

### Model selection

Capability is multi-dimensional, not a single scalar. Each catalogue row has
four calibrated axes — `reasoning`, `code`, `agentic`, `general` — plus a
composite `capability`. Repo policy sets, per role:

```toml
[agents.build]
min_capability = 7.3        # hard filter on the composite (0-10)
[agents.build.axes]         # optional hard per-axis floors
reasoning = 6.0
code = 5.5
agentic = 6.0
[agents.build.weights]      # role-weighted mix, normalized
code = 0.40
agentic = 0.35
reasoning = 0.15
general = 0.10
```

Every call hard-filters models below `min_capability` or any axis floor, then
scores `0.5 × capability-quality + 0.25 × cost + 0.10 × speed + 0.15 × headroom`
(ascending). Capability-quality is the role-weighted axis fit converted to a
penalty, so a materially better model outranks a cheaper one; close models are
decided by cost. Defaults: balanced role weights, composite floor 7.

Inspect and dry-run the selector without spending tokens:

```
machine_code models                       # configured providers, capability-sorted
machine_code models --all --json          # every row
machine_code models --agent build         # hard filters + selected model + top candidates
machine_code models --agent review --min-capability 7.6 --context-chars 48000
```

`--model <catalogue-key>` (or an id suffix) still pins one model. Provider
note: pin with e.g. `--model opencode-go/glm-5.3-flash`.

### Tiers, funding, and data files

Selection has exactly two tiers:

```toml
[selection]
tier = "paid"            # free | paid
```

- `paid` — every row that passes the capability/context floors is eligible,
  including zero-price rows. The best fit wins; a free model can win outright.
  Paid rows from providers without funding are rejected as
  `unfunded-provider`; free rows bypass the funding check.
- `free` — only zero-price rows are eligible.

Provider funding and billing adjustments live in machine config:

```toml
[providers.opencode-go]
cost_multiplier = 0.5    # 2x cheaper than list (quota discount)
funded = true
```

Defaults come from `data/providers.toml`; `openrouter`, `opencode`, and
`opencode-go` ship funded. Override per run with `--tier free|paid`. The
catalogue (`~/.machine_code/catalogue/models.json`) is generated from
`data/providers.toml`, `data/benchmarks.json`, provider metadata, and curation,
and contains the full provider table plus every model's pricing, context,
axes, and capability score. That is the single runtime data file. Each model row carries explicit
`capabilities` (reasoning/toolCall/image, input/output modalities, context,
max output), `modes` (reasoning, tools, vision, structured-output, ...),
`pricing` (including tier bands), `scores` (four axes + composite), and
`provenance.scoreSources` telling you whether each axis came from a benchmark,
a metadata prior, or an authored override. Provider entries carry billing
`modes` (usage/subscription/free), `billing` details ($10/$60 OpenCode Go
quota), default `costMultiplier`, model counts, and price ranges.

`data/models.toml` is a generated, committed snapshot of the current catalogue
(`machine_code catalogue snapshot`, or `catalogue refresh --snapshot`). It is
normalized: capabilities, modes, scores, and benchmarks appear once per
canonical model; provider offers carry pricing/free and only the fields that
differ (context/max-output limits, modes, capability gaps). `score_sources`
lists only non-metadata axes; an absent axis means the metadata prior. It is
the readable starting point for reviewing model capabilities, modes, and
prices; it is regenerated, not authoritative. Hand-authored
capability/pricing corrections go in `data/model-overrides.toml` (machine
override: `~/.machine_code/data/model-overrides.toml`) and win last.

### Minimums and overrides

Precedence (lowest → highest): built-in defaults → machine `[selection]` →
machine `[agents.<role>]` → repo `.machine_code/policy.toml` `[agents.<role>]`.
Axis tables merge per axis.

Experiment per run without editing files:

```bash
machine_code run --tier free --min-capability 7.0 --min-axes code=6.5,agentic=7 ...
machine_code models --agent build --min-capability 7.8 --min-axes reasoning=7.5
```

Inspect/edit the effective policy:

```bash
machine_code policy [role] [--json]
machine_code policy edit [--repo]
```

### Agents and presets as data

`data/agents.toml` defines roles (prompt file, tools, read-only flag, TUI modes,
blurb, default preset) and behavior presets. Prompts live in
`data/prompts/*.md`. Machine override: `~/.machine_code/data/agents.toml`;
repo prompt override: `.machine_code/agents/<role>.md`. Capability gating stays
in the harness, not the data file.

### Provider notes
### Provider notes

- **DeepInfra** is an OpenAI-compatible shim; `/v1/openai/models` metadata
  supplies pricing, context, max output, and chat filtering.
- **NVIDIA** models are zero-price in the generated catalog and are retained as
  `free` rows: selectable in both tiers; free-only selection uses `--tier free`.
- **OpenCode Go** is discounted via `cost_multiplier`; rate-limit errors cool
  the model/provider on the tier schedule (1m → 5m → 30m → …), and a provider
  cooldown makes the next call re-pick another provider.
