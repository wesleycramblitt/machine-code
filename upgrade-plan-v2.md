# machine_code v2 — deterministic orchestration and process supervision

> **Status: proposed; not implemented.**
>
> Baseline: `8fa7cdc` (146 tests). This plan supersedes the architect/subagent
> execution model in `upgrade-plan.md`. It keeps the existing issue hierarchy,
> run records, worktrees, context assembly, gates, and TUI frame contract.

## 1. Summary

The next architecture turns planned work into a deterministic build graph:

- A **Planner** agent replaces the Architect.
- The Planner creates/updates GitHub issues with machine-readable task metadata,
  context references, acceptance criteria, and dependencies.
- A **deterministic Orchestrator** process reads those issues and dispatches
  ordinary agent runs in dependency order.
- Build and Review are **sibling runs**, not subagents. No agent can spawn
  another agent.
- `general` and `sudo` remain standalone roles for work that is not part of a
  planned issue graph.
- Every run tracks the OS processes, scripts, and tools it starts, with logs and
  kill controls visible in run details.

The mental model is a local build system:

```text
Planner      = configure step
Issues       = build graph + task specs
Orchestrator = make/ninja
Build/Review = compilers and checks
Replanning   = explicit configure rerun
```

## 2. Settled decisions

- The Architect role is replaced by Planner.
- `task` delegation and `run:spawn` are removed. No agent calls another agent.
- The Orchestrator is code, never an agent, and never uses a model to schedule.
- The Orchestrator only operates on tasks tied to GitHub issues.
- `general` and `sudo` stay outside orchestration; they may run untracked.
- A Build run can report `needs_planning` directly. That stops the affected
  orchestration; there is no automatic replanning loop.
- If Build reports `completed` but gates or Review reject it, Build may retry a
  configurable number of times. After that, the task moves to `needs_planning`.
- Replanning is an explicit Planner run, started by a human or TUI. It is not
  automatically retried.
- Every spawned OS process is registered per run, streamed to logs, and can be
  inspected or killed from the CLI and TUI.
- Builds use isolated worktrees; Review reads the build worktree.
- Task state is reconstructed from issues + runs. The Orchestrator keeps only
  operational leases/checkpoints, not a second project model.
- TUI gains a fifth primary tab: `5:Orchestrate`.
- The old `Children` run section is replaced by `Processes` plus `Related`.

## 3. Roles and boundaries

| Role | Kind | Issue required | Purpose |
|---|---|---:|---|
| Planner | agent | yes | Create/update Epic, Feature, Task plans |
| Build | agent | yes | Implement one compiled task |
| Review | agent | yes | Structured verdict on one build |
| General | agent | no | Generic read-only Q&A |
| Sudo | agent | no | Explicit escape hatch for generic work |
| Orchestrator | deterministic process | yes | Schedule issue-backed tasks |

### 3.1 Planner

Replaces `data/agents/architect.toml` with `data/agents/planner.toml`.

Tools:

```toml
tools = ["read", "search", "command", "ask", "issue", "pr"]
readonly = true
```

The Planner may write issues but not code. It must:

- create/update the Epic, Feature, and Task hierarchy
- write `mc:context` references at each level
- write acceptance criteria
- write dependency links
- declare task role, verification, worktree requirement, and retry budget
- validate the graph before declaring planning complete
- persist decisions incrementally so a new planning run can resume from issues

The Planner has no `task` tool and no `run:spawn` capability.

### 3.2 Build

Build implements exactly one frozen task snapshot.

Outcomes are typed, not inferred from prose:

- `completed` — implementation done; gates may now run
- `needs_planning` — spec/context is insufficient or contradictory
- `blocked` — external/human dependency or environment problem
- `failed` — the agent could not complete the work

Build never closes its own task and never edits the plan.

### 3.3 Review

Review runs after a successful Build and gates. It receives:

- the frozen task snapshot
- the build run's diff/commit/worktree
- gate evidence

It returns a typed verdict:

- `approved`
- `changes_requested` with required changes
- `needs_planning`
- `blocked`
- `failed`

Review does not edit the worktree.

### 3.4 General and Sudo

These remain standalone roles:

```bash
machine_code run --agent general "explain this module"
machine_code run --agent sudo "repair the local toolchain"
```

They may have no issue. They do not appear in orchestration previews and cannot
be scheduled by the Orchestrator. If they are associated with an issue for
traceability, they still remain outside any orchestration graph.

### 3.5 Removed

- `src/tools/task.ts`
- `task` in every role tool list
- `run:spawn` capability
- Architect role and Architect modes
- parent-run delegation context
- `queue.ts` filename-order execution as the primary scheduler

`parentRunId` remains for `fork` and `correct`; it no longer means delegation.

## 4. Planning model

### 4.1 Issue tree remains the source of truth

Existing hierarchy and reserved anchors stay:

```text
Epic
  Feature 0: Planning & Review
    Task 0: Planning & Review
  Feature
    Task 0: Planning & Review
    Task 1
    Task 2
```

Planner runs attach to the reserved Task 0 for their Epic/Feature. The
Orchestrator ignores reserved planning/review anchors as build candidates.

### 4.2 Machine-readable task marker

Each deliverable Task carries a marker:

```html
<!-- mc:plan
{
  "v": 1,
  "role": "build",
  "verification": "verified",
  "worktree": "required",
  "retries_before_replan": 2
}
-->
```

`mc:context` remains separate:

```html
<!-- mc:context
{"files":["src/parser.ts"],"knowledge":["knowledge/parser.md"],
 "skills":["reference"],"tools":["bench"],"scripts":["release-check"]}
-->
```

Acceptance criteria remain in the issue's `## Acceptance criteria` section.
Approval remains `mc:approval`.

### 4.3 Dependencies

Dependencies use GitHub issue links (`blockedBy`) as the canonical graph. The
current provider already supports them, but the `issue` tool does not expose
them yet. Add `blocked_by`/`depends_on` to `issue create` and `issue edit`.

Rules:

- A task is ready only when every blocker is closed.
- Cycles are rejected before dispatch.
- Blockers must be in the same repository for v2.
- Cross-repo dependencies are deferred.
- The Orchestrator recomputes readiness on every tick.

### 4.4 Task snapshots

At dispatch, the Orchestrator freezes the task into an immutable snapshot:

- issue number and title
- plan marker
- acceptance criteria
- dependencies
- context references
- base branch / worktree requirement

The snapshot is stored in the run directory and hashed into the run summary.
Review judges the build against this snapshot, not against a body that may have
changed mid-flight.

### 4.5 Planning runs are issue-memory, not transcript-memory

A planning conversation may span multiple runs. Each run starts by reading the
current issue tree and writes decisions back immediately. A crash loses at most
one planning step. The Planner should validate before writing a batch of issues
where practical, and all creates/updates must be idempotent.

## 5. Orchestrator

### 5.1 Definition

`Orchestrator` is a deterministic process, not an agent.

It:

- reads issues, dependencies, plan markers, and run records
- derives task readiness
- dispatches Build and Review runs
- runs/reads gates
- closes tasks after approval policy is satisfied
- stops at checkpoints
- records operational leases and checkpoints

It never:

- writes task prose
- chooses new work
- changes dependencies
- decides that a plan is wrong
- calls a model directly

### 5.2 Operational state

The project state lives in issues. The Orchestrator still needs a small local
ledger to avoid duplicate work:

```text
.machine_code/local/orchestrations/<id>.json
.machine_code/local/orchestrations/<id>.lock
.machine_code/local/orchestrations/<id>.events.jsonl
```

Contents:

- orchestration id and scope
- lease owner + heartbeat
- current checkpoint
- stop reason
- last tick timestamp
- process id of the orchestrator

Task readiness, attempts, and review outcomes are derived from issues and runs.
The local ledger is operational, not a competing project model.

### 5.3 Scope

Default scope is one Epic. Feature scope is supported for focused execution.
Cross-repo orchestration is out of scope for v2.

### 5.4 Tick algorithm

Each tick is deterministic and idempotent:

```text
1. Acquire/renew orchestration lease.
2. Reconcile interrupted runs.
3. Load open tasks and dependency links.
4. Validate plan markers, dependencies, cycles, and issue association.
5. Close tasks whose latest review was approved and approval allows closure.
6. Mark ready tasks: open, all blockers closed, no active run.
7. Dispatch ready Build runs up to max_parallel.
8. For completed builds with passing gates, dispatch Review runs.
9. Apply failure policy (see §6).
10. Apply checkpoint/stop conditions.
11. Release lease or sleep until next tick.
```

### 5.5 Idempotency

Every dispatched run carries:

- `orchestrationId`
- `taskIssue`
- `attempt`
- `phase` (`build` or `review`)
- `reviewOfRunId` for reviews

Before dispatch, the Orchestrator checks for an active run with the same
`orchestrationId + taskIssue + phase`. A lock/lease prevents two orchestrators
from scheduling the same task.

### 5.6 Triggers

Supported trigger modes:

- manual: `machine_code orchestrate start|tick`
- after planning: optionally start when the planning anchor closes
- issue change: poll issue state/updatedAt and tick when relevant issues change
- watch: long-running poll loop
- TUI: start/step/resume from the Orchestrate screen

GitHub webhooks are deferred; polling uses the local issue cache and conditional
requests to stay within rate limits.

### 5.7 Stop conditions and checkpoints

Invocation policy, not task plans, controls:

- `--max-parallel N`
- `--max-minutes N`
- `--max-spend-usd N`
- `--until plan|task|feature|orchestration|checkpoint`
- `--checkpoint after-plan|after-review|before-merge`
- `--on-needs-planning stop`
- `--on-build-failure stop`

Defaults:

- checkpoints: after plan approval and before Feature merge
- `on_needs_planning`: stop
- `on_build_failure`: stop
- no automatic replanning

## 6. Failure and replanning semantics

### 6.1 Build outcomes

| Build outcome | Orchestrator action |
|---|---|
| `completed` | Run acceptance gates, then Review |
| `needs_planning` | Stop affected orchestration at `awaiting_plan`; no retry |
| `blocked` | Stop; surface reason |
| `failed` | Stop; surface evidence |
| `interrupted`/`cancelled` | Stop; no automatic restart |

### 6.2 Completion failures

If Build says `completed` but gates fail or Review rejects:

1. Record the failure evidence.
2. Dispatch a new Build attempt with the evidence.
3. Increment the completion-failure count.
4. Repeat until `retries_before_replan` is reached.
5. Move the task to `needs_planning` and stop.

`retries_before_replan` is task-plan data, default `2`, and applies to the
combination of failed acceptance gates and rejected reviews.

### 6.3 No replan loops

- `needs_planning` never triggers an automatic Planner run.
- The Orchestrator enters `awaiting_plan` and stops scheduling.
- A human or TUI explicitly starts a Planner run.
- The Planner updates issues.
- The human resumes the Orchestrator.
- If Build again reports `needs_planning`, the Orchestrator stops again.

There is no build → replan → build → replan loop inside one orchestration tick.

### 6.4 Technical failures

A Build `failed`/`blocked` is not automatically reclassified as a planning
problem. It stops orchestration and preserves evidence. A human may resume,
launch a Planner run explicitly, or cancel.

## 7. Process supervision

### 7.1 Goal

Every OS process spawned by a run is visible while it is alive and after it
exits. A human can inspect output and kill a process or the whole run's process
tree without hunting for PIDs.

This covers:

- typed commands
- repo/global scripts
- tool-spawned processes
- LSP servers
- MCP servers
- external CLIs used by tools
- orchestrator-spawned runs

### 7.2 Registry

One supervisor per run:

```text
.machine_code/local/runs/<run-id>/processes.jsonl
.machine_code/local/runs/<run-id>/processes/<process-id>.stdout.log
.machine_code/local/runs/<run-id>/processes/<process-id>.stderr.log
```

Record:

```json
{
  "id": "p-0001",
  "runId": "20261101-...",
  "origin": "tool|command|script|lsp|mcp|orchestrator",
  "name": "typescript:test",
  "toolCallId": "call_...",
  "argv": ["npm", "test"],
  "pid": 12345,
  "pgid": 12345,
  "status": "running|exited|killed|failed",
  "startedAt": "...",
  "endedAt": "...",
  "exitCode": 0,
  "signal": null,
  "stdoutLog": "...",
  "stderrLog": "...",
  "lastOutputAt": "..."
}
```

Events:

- `process_started`
- `process_exited`
- `process_killed`
- `process_output_truncated` (optional warning)

Do not append every output line to `events.jsonl`; output belongs in log files.

### 7.3 Lifecycle

- All spawn/execFile calls go through `src/processes/supervisor.ts`.
- Spawn processes in their own process group on Linux.
- On run cancellation/interruption, terminate the whole group.
- On terminal run status, terminate any remaining children.
- Kill flow: `SIGTERM`, grace period, then `SIGKILL`.
- Only registered processes owned by the run can be killed.
- Never accept an arbitrary PID from the TUI/CLI.
- Orphan reaping runs during reconcile and `prune`.

### 7.4 CLI

```bash
machine_code processes <run-id> [--json]
machine_code processes kill <run-id> <process-id|all>
machine_code processes logs <run-id> <process-id> [--follow]
```

### 7.5 TUI

Run detail gains a **Processes** section:

```text
● p-0003  command  typescript:test       pid 48122  12s   tail: PASS src/parser.test.ts
✓ p-0002  script   release-check         pid 48010  3s    exit 0
✗ p-0001  tool     core:diff             pid 47990  1s    exit 2
```

Controls:

- `j/k` select process
- `Enter` expand output
- `l` follow live output
- `k` kill selected process tree
- `K` kill all processes for the run
- `o` open log file

The section refreshes on the TUI timer while the run is active.

### 7.6 Tool call linkage

Timeline tool events remain. Each process record links to its `toolCallId`, so a
tool call in the timeline can point at the process and its logs.

## 8. TUI

### 8.1 Primary tabs

```text
1:Runs  2:Models  3:Spend  4:Settings  5:Orchestrate
```

### 8.2 Orchestrate screen

List view:

- repository, Epic/Feature, plan readiness
- ready/running/blocked/needs-planning counts
- active orchestration state and checkpoint
- spend, attempts, last tick
- selected agents/models preview

Detail/preflight view:

- dependency graph or ordered task table
- per-task role, verification, worktree requirement
- predicted model and projected cost
- checkpoints and stop policy
- blockers and reasons
- buttons/keys to start, step, pause, resume, stop, replan

Commands (5–8 per screen):

```text
n new orchestration   Enter open/preflight   s start/step
p pause               R resume                r refresh
a approve checkpoint  ? help
```

### 8.3 Run detail sections

```text
Overview · Timeline · Processes · Thinking · Changes · Context · Related
```

- `Processes` is the live process supervisor view.
- `Related` shows orchestration id, task issue, attempt, build/review siblings,
  and fork/correct lineage.
- The old `Children` subagent view is removed.

### 8.4 Runs page

- Worker runs remain grouped by repository/issue/status.
- Untracked general/sudo runs remain in Untracked.
- Orchestration runs show a compact orchestration/task badge.
- Narrow two-line run rows stay.

## 9. CLI and configuration

### 9.1 CLI

```bash
machine_code run --agent planner --issue <epic|feature|task> "<planning request>"
machine_code orchestrate start --epic 42
machine_code orchestrate tick --epic 42 --dry-run
machine_code orchestrate watch --epic 42 --interval 15s
machine_code orchestrate status --epic 42
machine_code orchestrate pause|resume|stop --epic 42
machine_code processes <run-id>
machine_code processes kill <run-id> <process-id|all>
```

### 9.2 Config

```toml
[orchestration]
max_parallel = 2
max_minutes = 120
max_spend_usd = 5
checkpoints = ["after-plan", "before-merge"]
on_needs_planning = "stop"
on_build_failure = "stop"
auto_start_after_plan = false
```

Task-level plan data:

```html
<!-- mc:plan
{"v":1,"role":"build","verification":"verified",
 "worktree":"required","retries_before_replan":2}
-->
```

## 10. Data model changes

### 10.1 Run summary

Add optional fields:

```ts
orchestrationId?: string;
taskIssue?: IssueRef;
attempt?: number;
phase?: "build" | "review";
reviewOfRunId?: string;       // already exists in places
planSnapshotHash?: string;
processCount?: number;
liveProcessCount?: number;
```

### 10.2 Issue markers

- `mc:plan` — task role/verification/worktree/retry budget
- `mc:context` — existing file/tool/script/skill references
- `mc:approval` — existing closure/merge policy
- `mc:reserved` — existing planning anchors

Dependencies stay in GitHub `blockedBy`.

### 10.3 New modules

```text
src/plan/schema.ts          parse/validate mc:plan
src/plan/validate.ts        DAG validation, cycles, required context
src/orchestrator/scheduler.ts
src/orchestrator/state.ts   leases/checkpoints
src/orchestrator/execute.ts dispatch build/review runs
src/processes/supervisor.ts
src/processes/registry.ts
src/processes/kill.ts
src/tui/orchestrate.ts      pure view model
```

Likely modified:

```text
src/cli.ts
src/tui.ts
src/state/run-schema.ts
src/tools/index.ts
src/tools/issues.ts
src/loop.ts
src/commands/registry.ts
src/issue provider/tool code
src/context/assemble.ts
data/agents/*.toml
```

## 11. Migration phases

### Phase 0 — Contracts and schema

- Add `mc:plan` parser/validator.
- Add run fields for orchestration/task/attempt/phase.
- Add process record types.
- Add dependency fields to the `issue` tool.
- Keep old execution paths working.

### Phase 1 — Process supervision

Independent of orchestration and useful immediately.

- Supervisor + registry + logs.
- Route all spawn/execFile through it.
- Run-detail Processes section.
- CLI list/kill/logs.
- Orphan cleanup.
- Tests for spawn, kill, logs, and terminal cleanup.

### Phase 2 — Planner

- Add `planner.toml`; keep `architect` as a deprecated alias temporarily.
- Remove `task` from the Planner's tools.
- Add plan validation and idempotent issue updates.
- Planner can produce a complete Epic/Feature/Task graph.
- No orchestration execution yet.

### Phase 3 — Read-only orchestrator

- Build the deterministic tick from issues + runs.
- Implement dependency readiness, cycle checks, idempotency, and dry-run.
- Add orchestration ledger/lease.
- TUI Orchestrate preflight view.
- No worker dispatch yet.

### Phase 4 — Sequential execution

- Dispatch Build and Review as separate runs.
- Add typed Build outcomes and Review verdicts.
- Run gates, close tasks, and record evidence.
- Implement `needs_planning` stop behavior.
- Implement `retries_before_replan`.
- Replace `queue` as the primary execution path.

### Phase 5 — Parallelism and checkpoints

- Parallel dispatch with `max_parallel`.
- Checkpoints, budgets, wall-clock limits.
- Replan stop/resume flow.
- Failure evidence handoff between attempts.
- Branch/merge serialization where required.

### Phase 6 — TUI and cleanup

- Add `5:Orchestrate` list/detail/preflight.
- Add process controls to run detail.
- Remove `Children`; add `Related`.
- Remove `task` tool, `run:spawn`, Architect, and Architect modes.
- Deprecate `queue` and document migration.
- Update README and data docs.

## 12. Test plan

### Planner/schema

- `mc:plan` parsing and validation.
- Missing issue, reserved issue, or missing plan marker rejected.
- Dependency creation/edit through the issue tool.
- Cycle detection.
- Idempotent plan updates.
- Context/acceptance preservation.

### Orchestrator

- Ready only when blockers are closed.
- Dependency order is deterministic.
- Parallel limit respected.
- No duplicate dispatch with two ticks/leases.
- Closed tasks skipped.
- General/sudo and untracked work rejected.
- Checkpoint stops and resumes.
- Budget/time stop conditions.

### Failure semantics

- Build `needs_planning` stops immediately and does not invoke Planner.
- Build `failed`/`blocked` stops without replanning.
- Gate failure retries up to the configured limit.
- Review rejection retries with evidence.
- Exhausted retries move to `needs_planning`.
- No automatic replan loop.
- Review verdict parsing is typed, not prose-regex based.

### Process supervision

- Process start/exit records.
- stdout/stderr logs.
- Kill individual process tree.
- Kill all on cancel.
- Orphan reaping.
- Terminal run leaves no live children.
- TUI process section updates.
- Ownership validation prevents arbitrary PID kills.

### End-to-end

- Plan an Epic with two dependent tasks.
- Execute Build → gates → Review → close task 1 → Build task 2.
- Run two independent tasks in parallel.
- Reject a review and verify retry then `needs_planning`.
- Build emits `needs_planning` and orchestration stops.
- Run an untracked `general` or `sudo` run and confirm it never appears in
  orchestration.
- Kill a running script from run detail and confirm the run records the kill.
- Keep all existing 146 tests green.

## 13. Risks and non-goals

### Risks

- GitHub API latency/rate limits and `blockedBy` availability.
- Plan edits during execution; mitigated by immutable task snapshots.
- Parallel merges and branch conflicts.
- Process output volume; use log files, not event spam.
- Process-group semantics differ by OS; Linux-first.
- A Planner can still produce a bad graph; validation and human plan approval
  are required.
- "Stateless" orchestration still needs leases/idempotency.

### Non-goals

- Agent-to-agent delegation.
- Automatic replanning loops.
- Orchestrating untracked general/sudo work.
- Cross-repo dependency graphs.
- Webhook infrastructure.
- Arbitrary shell execution.
- Replacing GitHub as the plan/state source.

## 14. Acceptance criteria

- No `task` tool or `run:spawn` remains.
- Planner creates a complete, validated issue graph.
- Orchestrator schedules only issue-backed compiled tasks.
- Build and Review are independent runs with typed outcomes.
- `needs_planning` stops orchestration and requires an explicit Planner run.
- Completion failures retry up to a configured number, then stop.
- General/sudo remain standalone and untracked-capable.
- Every run-owned OS process is listed, logged, and killable.
- Run detail shows Processes and Related, not subagent Children.
- TUI has an Orchestrate preflight and control screen.
- All existing behavior for runs, issues, worktrees, spend, models, and settings
  continues to work.

## 15. Residual implementation choices

Recommended defaults, to be confirmed during implementation:

- `retries_before_replan = 2`
- checkpoints after plan approval and before Feature merge
- `max_parallel = 2`
- orchestration scope = Epic
- process log retention follows run retention
- LSP/MCP processes included in process supervision
- Planner edits existing issues; each accepted plan revision is recorded as an
  issue comment for audit
