# machine_code — remaining work

> Consolidated roadmap. This file replaces `plans/context-and-map-plan.md`,
> `plans/upgrade-plan.md`, and `plans/upgrade-plan-v2.md`; their full design
> history remains in git. It lists only work that is not built.
>
> Baseline: `9388aa7`, 192 tests passing. Current: Phase 1 contracts are
> implemented (issue access, `mc:plan` schema/validator, run orchestration
> fields, process registry/types, issue dependencies, artifact usage). Phase 2
> has metadata/free-model probes, run preflight, the `availability` CLI, and a
> manual TUI probe. Phase 3 has the registry/supervisor, typed-command and gate tracking,
> `processes` CLI, and the run-detail Processes section with kill controls.
> Orphan records are reconciled on read. The suite has 222 tests.
>
> Goal: complete real repository work with runner-owned evidence, low context
> cost, and deterministic scheduling. Success measures: ≥80% on the fixed
> 12-task suite, lower cost per completed task than `pi` and `mini-swe-agent`
> on the same model, p50 time within 20% of `pi`, every change has gate
> evidence, and interrupted work resumes explicitly.

## 1. Shipped baseline — do not rebuild

| Area | Current state |
|---|---|
| Runtime, models | TypeScript/Node 22, provider catalogue, capability/axis scoring, free/paid tiers, retries, cooldowns, spend ledger |
| Runs | Run records, event log, transcripts, pause/cancel/fork/resume, `ask`/`respond`, cross-instance control |
| Worktrees | Run worktrees, issue-based branches, clean preflight, dependency links, runner commits, prune |
| Issues | GitHub/null providers, Epic → Feature → Task hierarchy, reserved Feature 0/Task 0, completion/approval, dependency reads |
| PRs | Runner-owned Task → Feature and Feature → main PRs, integration worktree, approval queue, squash merges |
| Context | Issue/packet/knowledge/skill/tool assembly, provenance, budget, child inheritance |
| Maps and state | Deterministic map, semantic annotations with coalesced refresh, run-state rendering, artifacts, `context` tool, base + role prompts |
| TUI/CLI | Four-tab TUI, issue-grouped runs, run detail, timeline, settings, spend/model views, map/status/prompt commands |
| Reference | Web/PDF extraction and indexed reference bundles via typed commands |

The only unfinished validation from this baseline is in Phase 0.

## 2. Target architecture

A local build system:

```text
Planner       = configure step
Issues        = build graph + task specs
Orchestrator  = deterministic make/ninja
Build/Review  = sibling runs, not subagents
Replanning    = explicit Planner rerun
```

Rules:

- The Planner writes plans; it does not implement.
- Issues and their machine-readable markers are the only project model.
- The Orchestrator is code. It never calls a model or chooses new work.
- Build and Review are independent runs. No agent spawns another agent.
- Only the Planner creates issue structure by default. Issue access is an
  explicit, visible role capability, not an inferred prompt behavior.
- `general` and `sudo` remain standalone and outside orchestration.
- Every run-owned OS process is registered, logged, and killable.
- Existing issue, run, worktree, context, gate, PR, model, and spend behavior
  remains intact.

### Roles

| Role | Kind | Issue | Issue access | Purpose |
|---|---|---:|---|---|
| Planner | agent | optional | create | Create/update Epic, Feature, and Task plans |
| Build | agent | yes | read | Implement one frozen task snapshot |
| Review | agent | yes | read | Typed verdict on one Build |
| General | agent | no | none | Read-only questions outside a plan |
| Sudo | agent | no | read (create opt-in) | Explicit escape hatch outside a plan |
| Orchestrator | code | yes | manage | Schedule issue-backed runs |

Build cannot close its own task or edit the plan. Review cannot mutate the
worktree. Architect, `task` delegation, `run:spawn`, and the child-run
`Children` view are removed in Phase 8.

## 3. Phase 0 — Finish shipped validation

### 3.1 Replay the context/map evidence run

Replay `20261102-173114-etdx` on the current build and record turns, calls, tool
calls, peak context, total tokens, cost, edits, gate result, and wall time.

Acceptance:

- The task produces an edit.
- ≤12 turns and ≤10 model calls.
- ≤250,000 total reported tokens (≤35% of the 735,207 baseline).
- Gates pass.
- A model changes only on a retry inside the run envelope pool.
- Context growth blocks with `context_exceeded`; it never switches models.
- The answer uses `Result / Changes / Evidence` and the STE checklist.

This validates the shipped context work. It is independent of Phases 1-8.

### 3.2 Opt-in GitHub integration test

Add an integration test that uses a real repository only when explicitly enabled
by an environment flag. Keep it out of the default suite. Cover:

- reserved Feature 0 / Task 0 creation and repair;
- Task-only association;
- dependency links;
- acceptance and approval closure;
- Task PR → Feature, Feature PR → main.

## 4. Phase 1 — Contracts and schema

Status: implemented. This phase now includes issue access, derived
capabilities, tool guards, `--auto-issue` guarding, UI badges, the `mc:plan`
schema/validator, orchestration run fields, process registry/types, issue
dependency fields, and artifact-usage records.

- Add `mc:plan` parsing and validation.
- Add run fields for orchestration/scope/task/attempt/phase/snapshot/review and
  process counts.
- Add process record types.
- Expose `blocked_by` / `depends_on` through the `issue` tool (the provider
  already supports them).
- Add artifact-usage events and schema.
- Add `issue_access` levels and derived issue capabilities; keep
  `issue:write` as a deprecated alias for `issue:plan`.
- Keep current run, queue, issue, and PR paths working.

### Task marker

```html
<!-- mc:plan
{"v":1,"status":"draft","role":"build","verification":"verified",
 "worktree":"required","retries_before_replan":2,
 "plan_review":"agent","result_review":"agent"}
-->
```

- `status` is `draft` until material questions are resolved; the Orchestrator
  ignores drafts.
- `role` is `build` or `review`.
- `verification` is `direct`, `verified`, or `redundant`.
- `worktree` is `required` or `optional`.
- `plan_review` / `result_review` are `agent` or `human`.
- `mc:context`, `mc:approval`, and `mc:reserved` remain separate markers.
- Acceptance criteria stay in the issue body.

### Dependencies and snapshots

- GitHub `blockedBy` is canonical. A task is ready only when every blocker is
  closed; cycles are rejected. Cross-repo dependencies are deferred.
- At dispatch, freeze the issue number/title, plan marker, acceptance criteria,
  dependencies, context references, and base/worktree requirement.
- Store the snapshot in the run directory and hash it into the run summary.
- Review judges the build against the snapshot, not a body that changed
  mid-flight.

### Issue access

Do not add another run mode for planning. Modes already select orchestration;
a second mode could disagree with the enforced capability. Use one explicit
access level per role and derive both enforcement and display from it.

```toml
# data/agents/<role>.toml
issue_access = "create"   # none | read | plan | create
```

Repo or machine policy may override it as `[agents.<role>] issue_access`.

| Level | Allows |
|---|---|
| `none` | No `issue` tool |
| `read` | `list`, `view`, `tree` |
| `plan` | read + `edit`, `link`, dependencies, `mc:plan`/`mc:context` |
| `create` | plan + create Epic/Feature/Task |

The existing `issues = required|optional|disabled` setting still controls
whether tracking is required. `issue_access` controls what the role may do.

- Defaults: Planner `create`; Build and Review `read`; General `none`; Sudo
  `read`. Sudo `create` requires `[agents.sudo] issue_access = "create"` or the
  explicit `--allow-issue-create` flag.
- Enforcement: `issue.create` requires `issue:create`; `issue.edit`, `link`,
  and dependency changes require `issue:plan`; `issue.close` remains a separate
  approval-gated capability.
- `--auto-issue` and harness gap-filling require `issue:create`. Otherwise
  reject with `issue_create_forbidden` and suggest a Planner run.
- Show the resolved level as a badge: `issues:create`, `issues:plan`,
  `issues:read`, or `issues:none`. Resolve it as `issue_access` intersected with
  the role's tool list, so a role without the `issue` tool always shows
  `issues:none`. Use it in the new-run agent picker, run Overview, and
  `machine_code policy [role]`.
- A non-Planner role that has been granted `create` shows a warning and needs
  explicit confirmation before it starts.
- Planner attaches to the reserved Task 0 anchor; it does not use `--auto-issue`
  to manufacture deliverables.
- Role prompts state the same rule: Planner owns plan writes; Build, Review, and
  General do not create or edit issue structure; Sudo does so only with explicit
  create access.

## 5. Phase 2 — Availability heartbeat and preflight

Status: metadata and opt-in free-model probes, run preflight, CLI commands, and
a manual TUI probe are implemented. Remaining: probe jitter, an automatic TUI
timer, and richer provider health statuses.

Goal: do not start a run on a model that is known unavailable, and recover a
cooldown as soon as evidence permits. A heartbeat is evidence, not a guarantee.

What is actually free:

- Provider metadata: authenticated `GET /models`, OpenRouter
  `GET /models/user` and `GET /key`, Ollama `/api/tags`. These use no inference
  and cost nothing.
- Rate-limit headers on an error: `Retry-After` and `X-RateLimit-*`. Successful
  responses often omit them.
- There is no cross-provider free endpoint that proves a specific model's
  current rate-limit state. Do not claim otherwise.
- Paid completion probes are not implemented. A free-model 1-token probe costs
  no money but consumes provider request quota, so it is opt-in.

Design:

- Add an `AvailabilityProbe` interface returning `ready`, `cooling`,
  `unavailable`, `auth`, or `unknown`, plus source, `retryAfter`, and latency.
- Add provider adapters only where a free metadata endpoint exists. Start with
  OpenRouter, OpenAI-compatible discovery, and Ollama; everything else returns
  `unknown` and keeps the existing cooldown.
- Store `probe_after`, `last_probe`, `last_result`, and evidence in
  `availability.json`. Keep the cooldown as a circuit breaker: a probe can clear
  it early only on explicit `ready`; a failed probe extends it; `unknown` leaves
  it alone.
- Probe at run start and when a cooldown would gate selection. Optionally probe
  visible cooling models on a TUI timer; never scan the whole catalogue.
- A run-start preflight selects the best ready model. If none is ready, block
  before creating a run record and show which models are cooling, why, and when
  they can be probed again.
- Coalesce probes per model and add jitter. One in-flight probe per model.
- For a paid row, clear a cooldown only from metadata evidence, a manual clear,
  or the next real run. Never send a probe completion.
- Free-model completion probes use `max_tokens=1`, no tools, a fixed `ping`
  prompt, and a short timeout. Run them only after a rate-limit cooldown or a
  manual request, not on every tick. Record the probe and its result, but do not
  count it as a run.
- Events: `availability_probe_started`, `availability_probe_result`,
  `availability_cooldown_cleared`, `availability_cooldown_extended`.
- CLI: `machine_code availability [--agent build] [--probe] [--free-only]
  [--json]` and `machine_code model probe <key>`. Extend the model/TUI status
  with `ready`, `probing`, `cooling 4m`, `auth`, `funds`, or `unknown`.
- Config:

```toml
[availability]
probe = "metadata"          # off | metadata | free-models
interval = "5m"
timeout_ms = 5000
free_completion_max_per_hour = 2
```

Probe results are advisory and expire. The real call remains the final
authority; the probe only prevents a run from starting on a model already known
to be unavailable.

Acceptance: a pure metadata probe makes zero inference calls; no code path sends
a paid completion probe; a known-unavailable model does not start a run; a
recovered free model can clear its cooldown before the conservative timer; all
probe activity is visible and rate-limited.

## 6. Phase 3 — Process supervision

Status: partially implemented. The registry/supervisor, typed-command and gate
process records and logs, `processes` CLI, run-detail Processes section with
select/kill controls, and orphan reconciliation exist. Remaining: route every
spawn (git/map, LSP, MCP, delegated runs), live follow/open-log controls, a
SIGTERM→SIGKILL grace path, and a shared orphan reap during prune.

Ship this before orchestration; it is useful on its own.

### Registry

One supervisor per run:

```text
.machine_code/local/runs/<run-id>/processes.jsonl
.machine_code/local/runs/<run-id>/processes/<process-id>.stdout.log
.machine_code/local/runs/<run-id>/processes/<process-id>.stderr.log
```

Records include id, run, origin (`tool|command|script|lsp|mcp|orchestrator`),
name, tool call id, argv, pid/pgid, status, timestamps, exit code/signal, log
paths, and last-output time. Emit `process_started`, `process_exited`,
`process_killed`, and optional `process_output_truncated`; do not copy output
lines into `events.jsonl`.

### Lifecycle

- Route every spawn/`execFile` through `src/processes/supervisor.ts`.
- Spawn in a separate process group on Linux.
- Cancel/interrupt terminates the whole group; terminal runs leave no children.
- Kill sends `SIGTERM`, waits, then `SIGKILL`.
- Only registered processes owned by the run can be killed. Never accept an
  arbitrary PID.
- Reap orphans during reconcile and `prune`.

### Surfaces

```bash
machine_code processes <run-id> [--json]
machine_code processes kill <run-id> <process-id|all>
machine_code processes logs <run-id> <process-id> [--follow]
```

Run detail gains a **Processes** section with status, origin, name, pid, elapsed
time, output tail, expand/follow/kill controls, and links from timeline tool
calls. The section refreshes while the run is active.

## 7. Phase 4 — Planner

```bash
machine_code run --agent planner "<plan a new epic>"
machine_code run --agent planner --issue 42 "<planning request>"
```

- Add `data/agents/planner.toml`; keep `architect` as a deprecated alias until
  Phase 8. While the alias remains, set its `issue_access` to `read`; only the
  Planner creates issue structure.
- Planner tools: `read`, `search`, `command`, `ask`, `issue`, `artifact`, `pr`;
  read-only code access; no `task`.
- Capabilities: `code:read`, `context:inherit`, `issue:read`, `issue:create`,
  `issue:plan`, `artifact:provision`, `pr:read`.
- Set `issue_access = "create"`. This is the only role that creates Epic,
  Feature, or Task issues by default.
- Add the `artifact` tool for listing/showing tools, scripts, manifests, usage,
  and creating/updating them. New executable scripts require human approval.
- Add deterministic plan validation and idempotent issue updates.
- Support new-Epic bootstrap: create the Epic, ensure reserved Feature 0 and
  Task 0, then attach later planning to the reserved anchor.
- Update run-target resolution so Planner attaches to the planning anchor;
  Review stays read-only and does not resolve as a planner.
- Use `ask` until material ambiguity is resolved. There is no fixed question
  cap; assumptions must be explicit and accepted.
- Keep planning in issue memory, not transcript memory. Persist decisions
  immediately so a new run can resume from issues.
- Inventory existing tools/scripts before creating new ones. Attach a reference
  at Task, Feature, or Epic scope according to actual reuse.
- Record artifact use in Planner, Build, Review, and Orchestrator runs. Promote
  an artifact after use by two different tasks/features; demote after the
  configured unused window.
- Validate before writing: acceptance exists, role/verification valid,
  dependencies acyclic, context/artifact references exist, `ready` has no open
  material questions, reserved anchors are not build tasks, scripts approved.
- Do not require chain-of-thought. Use structured fields, evidence, validators,
  and human review.

### Human review points

| Point | Marker | Behavior |
|---|---|---|
| Before Build | `plan_review: human` | Freeze snapshot; wait in `awaiting_packet_approval` |
| After Review | `result_review: human` | Wait for human result approval before closure |
| Before close/merge | `mc:approval` | Existing policy |

Rejection moves the task to `needs_planning` and stops. No automatic Planner
loop.

## 8. Phase 5 — Read-only Orchestrator

### Scopes

| Scope | Includes |
|---|---|
| `project` | All open planned work in one repository |
| `epic` | One Epic and its descendants |
| `feature` | One Feature and its Tasks |

Default scope is `epic`. Reserved anchors, drafts, untracked runs, and
general/sudo runs are never scheduled.

### Ledger and lease

```text
.machine_code/local/orchestrations/<id>.json
.machine_code/local/orchestrations/<id>.lock
.machine_code/local/orchestrations/<id>.events.jsonl
```

The ledger stores scope, lease owner/heartbeat, checkpoint, stop reason, last
tick, and process id. It is operational state, not a second project model.

### Tick

1. Acquire or renew the lease.
2. Reconcile interrupted runs.
3. Load open tasks and dependency links.
4. Validate markers, dependencies, cycles, references, and issue association.
5. Ignore drafts.
6. Close approved tasks when policy allows.
7. Mark ready tasks: open, ready plan, all blockers closed, no active run.
8. Dispatch Build up to `max_parallel`, honoring before-build checkpoints.
9. Dispatch Review for completed builds with passing gates.
10. Apply failure policy.
11. Apply checkpoints and budgets.
12. Release the lease or sleep.

Every dispatch carries orchestration id, task issue, attempt, phase, and
`reviewOfRunId`. Check for an active run with the same
`orchestrationId + taskIssue + phase` before dispatch.

### Triggers and stops

Manual start/step, after-plan optional start, issue polling, watch loop, and TUI
control. Webhooks are deferred.

```bash
machine_code orchestrate start --scope epic --epic 42
machine_code orchestrate tick --scope feature --feature 43 --dry-run
machine_code orchestrate watch --scope project --interval 15s
machine_code orchestrate status|pause|resume|stop ...
machine_code orchestrate approve|reject --task 101
```

Stop controls: `--max-parallel`, `--max-minutes`, `--max-spend-usd`,
`--until`, `--checkpoint`, `--default-plan-review`, `--default-result-review`,
`--on-needs-planning`, `--on-build-failure`.

The same defaults live under `[orchestration]`: `scope`, `max_parallel`,
`max_minutes`, `max_spend_usd`, `checkpoints`, `default_plan_review`,
`default_result_review`, `on_needs_planning`, `on_build_failure`, and
`auto_start_after_plan`.

### Failure semantics

| Outcome | Action |
|---|---|
| `completed` | Run gates, then Review |
| `needs_planning` | Stop at `awaiting_plan`; no Planner loop |
| `blocked` / `failed` / `interrupted` / `cancelled` | Stop; preserve evidence |
| Gates fail or Review rejects | Retry Build with evidence up to `retries_before_replan`; then `needs_planning` |

Replanning is always an explicit human/TUI Planner run. Technical failures are
not silently reclassified as planning failures.

## 9. Phase 6 — Sequential execution

- Dispatch Build and Review as separate runs. Build uses an isolated worktree;
  Review reads that worktree read-only.
- Add typed Build outcomes and typed Review verdicts:
  - Build: `completed`, `needs_planning`, `blocked`, `failed`.
  - Review: `approved`, `changes_requested`, `needs_planning`, `blocked`,
    `failed`.
- Replace prose/regex approval detection with typed parsing.
- Run gates, close tasks, and record evidence.
- Implement `needs_planning`, retry budgets, and failure-evidence handoff.
- Implement before-build packet approval and after-review human approval.
- Make the Orchestrator the primary path for issue-backed work; keep `queue`
  as a compatibility path until Phase 8.

## 10. Phase 7 — Parallelism and checkpoints

- Dispatch up to `max_parallel` without duplicate task/phase runs.
- Enforce wall-clock, spend, and checkpoint stops.
- Support project scope across Epics.
- Implement replan stop/resume and failure evidence between attempts.
- Serialize branch merges where required and surface conflicts.
- Keep deterministic dependency order and idempotent ticks.

## 11. Phase 8 — TUI and cleanup

Primary tabs:

```text
1:Runs  2:Models  3:Spend  4:Settings  5:Orchestrate
```

Orchestrate list: scope, repo, Epic/Feature, plan readiness, counts
(ready/draft/needs-planning/running/blocked), state/checkpoint, spend, attempts,
last tick, model preview, pending reviews.

Orchestrate preflight/details: included work, dependency order, per-task plan
state, review policy, tools/scripts and scope, predicted model/cost, blockers,
checkpoints, and start/step/pause/resume/stop/replan/approve/reject controls.

Run detail sections become:

```text
Overview · Timeline · Processes · Thinking · Changes · Context · Related
```

`Related` shows orchestration id, task issue, attempt, sibling Build/Review, and
fork/correct lineage. Remove `Children`.

Runs keep repository/issue/status grouping and untracked general/sudo runs.
Add orchestration/task badges.

The new-run agent picker and run Overview show the `issues:*` badge. A
non-Planner role with create access requires confirmation. The Models page and
new-run preview show availability (`ready`, `probing`, `cooling 4m`, `auth`,
`funds`, `unknown`) and allow a manual probe without starting a run. Start is
disabled with a reason when no eligible model is ready.

Cleanup:

- Remove `task`, `run:spawn`, Architect, and Architect modes.
- Deprecate `queue` as the primary scheduler; document migration.
- Update README and data docs.
- Keep all existing behavior for runs, issues, worktrees, spend, models, and
  settings.

## 12. New modules

```text
src/plan/schema.ts          parse/validate mc:plan
src/plan/validate.ts        DAG, cycles, context, acceptance, artifacts
src/plan/artifacts.ts       inventory and provisioning
src/plan/usage.ts           usage index and promotion hints
src/availability/probe.ts   probe result types and cooldown reconciliation
src/availability/adapters.ts free metadata probes by provider
src/agents/access.ts        issue_access -> capabilities + badge
src/orchestrator/scheduler.ts
src/orchestrator/state.ts   leases/checkpoints
src/orchestrator/execute.ts build/review dispatch
src/processes/supervisor.ts
src/processes/registry.ts
src/processes/kill.ts
src/tui/orchestrate.ts      pure view model
```

Expected modifications: `src/cli.ts`, `src/tui.ts`, `src/state/run-schema.ts`,
`src/tools/index.ts`, `src/tools/issues.ts`, `src/loop.ts`,
`src/commands/registry.ts`, `src/availability.ts`, `src/agents/config.ts`,
`src/policy/capabilities.ts`, `src/select.ts`, `src/tui/status.ts`,
issue provider/tool code, `src/context/assemble.ts`, and
`data/agents/*.toml`.

Run summary additions: `orchestrationId`, `orchestrationScope`, `scopeRef`,
`taskIssue`, `attempt`, `phase`, `reviewOfRunId`, `planSnapshotHash`,
`planReview`, `resultReview`, `processCount`, `liveProcessCount`.

## 13. Test plan

Keep the existing 222 tests green. Add:

| Area | Cases |
|---|---|
| Plan schema | parse/validate, drafts ignored, ready gate, missing acceptance/role, reserved rejected |
| Dependencies | issue-tool create/edit, readiness, cycle rejection, same-repo only |
| Availability | metadata probe makes no inference call; paid probe blocked; free probe opt-in; cooldown clears only on `ready`; extends on failure; `unknown` holds; preflight blocks before run creation; probe events and throttling |
| Issue access | level resolution; create/edit/link/close enforcement; `--auto-issue` guard; `issues:*` badge mapping; non-Planner create override confirmation |
| Planner | new-Epic bootstrap, idempotent updates, ambiguity loop, artifact reuse/approval, usage promotion; fixture suite: greenfield, extension, missing artifact, ambiguity, dependency, replan |
| Snapshot | frozen fields, hash, review uses snapshot after issue edit |
| Orchestrator | scopes, deterministic order, leases, no duplicate dispatch, dry-run, closed/draft/general/sudo exclusion |
| Failure | `needs_planning` stop, gate/review retries, retry exhaustion, no automatic replan, typed verdicts |
| Approvals | before-build packet approval, after-review approval, closure policy |
| Processes | start/exit records, logs, individual/group/all kill, orphan reap, no arbitrary PID, terminal cleanup |
| TUI | Orchestrate preflight, process selection/follow/kill, Related lineage, availability chip, `issues:*` badge and confirmation, no network in draw |
| E2E | greenfield Epic, two dependent tasks, parallel tasks, project/feature scope, human packet review, review rejection, missing script reuse, kill a running script; Planner creates issues while Build cannot |
| Compat | legacy `run.json`, packets, and display-only `solo` mode remain readable |
| GitHub | opt-in real-repo integration suite from Phase 0 |

## 14. Risks

| Risk | Mitigation |
|---|---|
| GitHub latency or missing `blockedBy` | local cache, conditional requests, same-repo dependencies |
| Plan edits during execution | immutable task snapshot and hash |
| Parallel branch/merge conflicts | serialize merges; surface conflicts; one active run per task branch |
| Process output volume | log files, not event lines; bounded tails |
| Process-group differences | Linux-first; explicit kill tests |
| Bad Planner graph | deterministic validators plus human plan review |
| Duplicate dispatch | leases and the orchestration/task/phase check |
| Context baseline regresses | complete the Phase 0 replay before v2 evaluation |
| Probe traffic or quota burn | coalesce per model, jitter, metadata by default, free completion opt-in and capped |
| Probe claims availability it cannot prove | treat `unknown` as unknown; keep the cooldown; never infer paid rate-limit state from metadata |
| Agents create issue noise | one `issue_access` level per role, Planner-only by default, tool guard, visible badge |

## 15. Decisions and defaults

| Decision | Default |
|---|---:|
| Orchestration scope | epic |
| Max parallel | 2 |
| Retries before replan | 2 |
| Plan review | agent |
| Result review | agent |
| Checkpoints | after plan approval, before Feature merge |
| `on_needs_planning` | stop |
| `on_build_failure` | stop |
| Availability probe | metadata only |
| Availability probe interval / timeout | 5 min / 5 s |
| Free-model completion probe cap | 2 per hour total |
| Cooldown early clear | only on `ready` evidence |
| Paid completion probe | not implemented |
| Planner issue access | create |
| Build / Review issue access | read |
| General issue access | none |
| Sudo issue access | read; create opt-in with confirmation |
| Process log retention | same as run retention |
| LSP/MCP supervision | included |
| Artifact promotion | 2 different tasks/features |
| Plan audit | record each accepted revision as an issue comment |
| Cross-repo dependencies | deferred |
| Webhooks | deferred |
| Container sandbox | deferred; worktrees isolate changes, not host execution |

Non-goals: agent-to-agent delegation, automatic replanning loops, orchestrating
untracked general/sudo work, arbitrary shell, daemon/API, public plugin SDK,
embeddings/index server, web UI, and replacing GitHub as the plan/state source.

## 16. Acceptance

- No `task` tool or `run:spawn` remains.
- A run does not start on a model already known to be unavailable; availability
  state and probe evidence are visible.
- Metadata probes make no inference call; paid completion probes are not
  implemented; free-model probes are opt-in and capped.
- Only the Planner creates issue structure by default; every role shows an
  explicit `issues:*` access badge and the guard rejects unauthorized creates.
- Planner creates and validates a complete issue graph, including greenfield
  Epic bootstrap with reserved anchors.
- Planner resolves ambiguity with an unbounded human question loop and records
  decisions in issues.
- Planner inventories and provisions tools/scripts at the correct scope.
- Orchestrator supports project, Epic, and Feature scopes and schedules only
  issue-backed ready tasks.
- Build and Review are separate runs with typed outcomes.
- `needs_planning` stops orchestration and requires an explicit Planner run.
- Completion failures retry to the configured limit, then stop.
- Optional human packet/result review works.
- General/sudo stay standalone and untracked-capable.
- Every run-owned OS process is visible, logged, and killable.
- Run detail shows Processes and Related, not Children.
- TUI has Orchestrate preflight and controls.
- Existing run, issue, worktree, context, PR, spend, model, and settings
  behavior remains intact.

## 17. Deferred polish

These are not required for v2. Keep current defaults until an eval or usability
case justifies the change:

- optional branch slugs; numbered `mc/task/<n>` and `mc/feature/<n>` stay;
- human approval timeout/expiry;
- activity-feed cap and freeze controls;
- narrow-terminal header count prioritization;
- preset Feature integration gate set.
