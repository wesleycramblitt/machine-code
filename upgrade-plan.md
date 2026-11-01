# Revised agent harness architecture

> Refined against repository `e4eb220` (2026-10-31). Complements `plan.md`
> (the shipped v1/M0–M5 baseline); it does not replace it.
>
> **Status: design + implementation; revised 2026-11-01.** Orchestration modes
> are now per-role data (`modes` + `default_mode`), not a global enum. A role
> with empty modes runs alone; `solo` is no longer a mode value.
>
> All architectural decisions are resolved. Residual implementation choices are
> listed in §15.

## Implementation status

| Phase | State | Notes |
|---|---|---|
| 0 — schema, atomic writes, packets, tests | **done** | v1→v2 migration, atomic JSON, packet resolver + persistence, `node:test` harness |
| 1 — worktrees, branches | **done** | run worktrees, issue/run branches, clean preflight, dependency links, runner commits, prune |
| 2 — lifecycle, ask, fork, resume | **done** | transcript checkpoints, inbox/`respond`, pause/cancel/fork, real resume; verified with SIGKILL + two-question e2e |
| 3 — config, capabilities, delegation | **done** | presets + overrides, capability matrix, tool gating, prompt composition, real `task` delegation |
| 4 — issues, hierarchy, reserved | **core done** | provider + gh + null, reserved ensure/audit/duplicates, Task-only association, `issue` CLI, issue tool; TUI cache deferred to Phase 7 |
| 5 — PR pipeline, approval | **done** | `pr` provider/tool, runner publish (Task→Feature), Feature PR with temporary integration worktree, squash merges, human approval queue |
| 6 — context assembly | **done** | priority bands, hierarchy + explicit refs, dedupe, budget, provenance manifest, prompt injection for run/queue/children |
| 7 — TUI status surfaces | **done** | four-page TUI, Work groups runs by issue with untracked runs, new-run composer with model/context preview, run sections (overview/timeline/thinking/changes/children/context), search/filter, spend, settings/artifact browser |
| 8 — completion/hardening | **core done** | acceptance verdicts (`accept`), parent closure requires closed children + acceptance, reserved close/reopen cascade; remaining: opt-in real-GitHub integration test |

Current test suite: 142 tests (`npm test`).

## Settled decisions

- Follow-up input is the `ask` tool; it stays within the same run.
- Worktree isolation is a prerequisite and lands before run forking.
- There is **no** `PLAN`/`BUILD`/`FULL` workflow abstraction.
- `direct`/`verified`/`redundant` are **orchestration modes declared by the
  selected role**. Architect owns them (`default_mode = "verified"`); General,
  Build, Review, and Sudo have empty mode lists and run alone. There is no
  global `solo` mode or TypeScript mode union.
- Agent configuration is explicit, with presets and per-field overrides.
- Every Epic has one reserved `Feature 0: Planning & Review`; every Feature has
  one reserved `Task 0: Planning & Review`. They are real GitHub issues.
- Issue-associated runs attach to a **Task** only; Epic/Feature planning resolves
  to the reserved `Task 0`.
- Branches belong to issues, worktrees belong to runs.
- Feature branch → Task branches; Task PRs target the Feature branch; one Feature
  PR targets `main`.
- Runner owns commit, push, PR creation, and merge. Agents do not run raw
  `git`/`gh` for publishing.
- Approval is per Task and Feature, default `human`; `agent` is opt-in for
  verified/redundant, non-visual work.
- Feature-to-main merge is human by default; a Feature may explicitly opt into
  agent approval.
- Squash Task PRs into the Feature branch and squash the Feature PR into `main`.
- One branch per issue, reused across runs.
- Review shares the Task worktree read-only.
- `artifact:write` covers plans and packets only; knowledge writes need a
  separate capability.
- Dirty main tree is allowed only for plan/packet artifacts.
- Plans/packets are branch-scoped; Epic plans go to `main` via a docs-only change;
  ephemeral packets stay local.
- Reserved issues close with the parent and reopen on parent reopen.
- Duplicate reserved issues: canonical is chosen by marker, run count, age, then
  issue number; **empty duplicates are auto-closed**.
- TUI status surfaces: issue rollups/health, header counts, awaiting-human
  queue, activity feed, sorting/search; the draw path reads local state only.

## Review guide

Read these first:

1. **§2 agent configuration** — the replacement for workflow modes.
2. **§3 issue hierarchy and reserved issues**.
3. **§4 runs, delegation, branches, and PRs**.
4. **§7 TUI** — issue tree, rollups, awaiting-human queue, activity feed.
5. **§10 phases** and **§15 settled/residual choices**.

---

## 1. What changes, what stays

### Stays

- File-based run state: `run.json` + append-only `events.jsonl`.
- Five roles: `general`, `architect`, `build`, `review`, `sudo`.
- Typed commands, no shell; model selection; gates; queue; spend; instances.
- Packets as durable execution specs; plans, knowledge, skills, tools.
- TUI frame contract, tabs, run detail, filters, new-run screen.
- Worktrees and transcript checkpoints.

### Changes

- Workflow layer removed. Verification levels and delegation are agent
  configuration, not workflow types.
- `task` becomes the delegation primitive; `ask` and `issue` and `pr` are added.
- Every Epic/Feature gets reserved Planning & Review issues.
- Runs attach to Tasks only; planning/review runs attach to reserved Task 0.
- Branches belong to issues; PRs form a Feature → Task → Feature → main pipeline.
- Approval is a first-class per-issue policy, default human.
- TUI primary grouping is the issue hierarchy; a run-tree view exposes execution
  independently.

### Existing defects on the critical path

- Architect-generated packets are parsed but never persisted.
- Packets are JSON stored as `.md`; `packet.ts` and `queue.ts` disagree on paths.
- No worktrees, despite `plan.md` and `RunSummary.worktree`.
- No tests or test script.
- No GitHub/PR integration.

---

## 2. Agent roles, configuration, capabilities

### 2.1 Role and configuration are separate

A role is identity and base permissions. An agent config controls execution
behavior.

```toml
[agents.architect]
preset = "orchestrate"     # optional shorthand; explicit fields override
delegate = true            # may call task to spawn children
verification = "verified"  # direct | verified | redundant
issues = "optional"        # required | optional | disabled
ask = true                 # may use ask
approval = "human"         # human | agent (default for issues it plans)
ambiguity = "precise"      # strict | precise | adaptive | autonomous
```

| Field | Meaning |
|---|---|
| `preset` | Named defaults; explicit fields override individual values. |
| `delegate` | Whether the agent may call `task`. Runner-owned verification is separate. |
| `verification` | `direct` = no new tests; `verified` = focused tests; `redundant` = tests + independent Review. Applies to any task, one agent or many. |
| `issues` | Required, optional, or disabled. Disabled never constructs a provider. |
| `ask` | Whether `ask` is registered. Build/Review default `false`. |
| `approval` | Default approval mode for issues planned/delegated by this agent: human or agent. |
| `ambiguity` | Clarification policy. |

### 2.2 Presets

| Preset | delegate | verification | issues | ask | approval |
|---|---|---|---|---|---|
| `architect.plan` | false | direct | optional | true | human |
| `architect.orchestrate` | true | verified | optional | true | human |
| `build.implement` | false | verified | optional | false | human |
| `review.review` | false | direct | optional | false | human |
| `general.assistant` | false | direct | disabled | true | human |
| `sudo.unrestricted` | true | verified | optional | true | human |

A preset only sets defaults. `architect.plan` is `delegate=false`; there is no
separate PLAN mode enum. `architect.orchestrate` is `delegate=true`.

### 2.3 Verification levels

| Level | Requirements |
|---|---|
| `direct` | Implementation, no new tests; runner gates. |
| `verified` | Implementation plus focused tests for each acceptance criterion; runner gates. |
| `redundant` | `verified` plus an independent Review run. If the acting agent has `delegate=false`, the runner spawns Review as a child. |

Verification applies to a task regardless of whether one agent or many subagents
perform it. It is a runner guarantee, not an agent permission.

### 2.4 Delegation rules

| Acting role | May spawn |
|---|---|
| `architect` with `delegate=true` | `build`, `review` |
| `sudo` with `delegate=true` | `sudo` only |
| `build`, `review`, `general` | nothing |
| `architect` with `delegate=false` | nothing |

`task` is unavailable when `delegate=false`. Runner verification is not
delegation and still runs.

Sudo children are sudo, never build/review. Sudo is fully enabled by default
(`delegate=true`, all capabilities), but approval still defaults to human.

### 2.5 Capability matrix

| Capability | architect.plan | architect.orchestrate | build | review | general | sudo |
|---|---|---|---|---|---|---|
| `code:read` | yes | yes | yes | yes | yes | yes |
| `code:write` | no | no | yes | no | no | yes |
| `artifact:write` | yes | yes | no | no | no | yes |
| `issue:read` | yes | yes | assigned | yes | no | yes |
| `issue:write` | yes | yes | no | no | no | yes |
| `issue:hierarchy:write` | yes | yes | no | no | no | yes |
| `issue:close` | no | yes | no | no | no | yes |
| `run:spawn` | no | yes | no | no | no | yes |
| `run:coordinate` | no | yes | no | no | no | yes |
| `pr:read` | yes | yes | no | no | no | yes |
| `pr:create` | no | yes | no | no | no | yes |
| `pr:merge` | no | yes* | no | no | no | yes* |
| `review:write` | no | no | no | yes | no | yes |
| `knowledge:write` | no | no | no | no | no | opt-in |
| `context:inherit` | yes | yes | yes | yes | yes | yes |

`*` `pr:merge` and `issue:close` still obey per-issue `approval`; with
`approval=human` they create an approval request instead of acting immediately.

### 2.6 Harness enforcement

Final core tools: `read`, `write`, `edit`, `search`, `command`, `task`, `ask`,
`issue`, `pr`. `task` is no longer a stub. `plan.md`’s “six tools” invariant is
amended to nine.

- `coreTools()` receives the resolved capability set; unavailable tools are not
  registered.
- `write`/`edit` require `code:write`, or `artifact:write` plus an allowed path
  scope.
- `command` checks the command’s readonly/mutating flag plus capabilities.
- `issue` checks the action’s capability and hierarchy rules.
- `task` checks `run:spawn`, the child role, the Task association, and
  `delegate`.
- `pr` checks `pr:read`/`pr:create`/`pr:merge` and per-issue approval.
- `ask` is registered only when `ask=true` and ambiguity is not `autonomous`.
- Prompts explain policy; prompts are not the enforcement boundary.

### 2.7 Role-owned orchestration modes

| Role | Modes | Meaning |
|---|---|---|
| General, Build, Review, Sudo | none | single-agent invocation |
| Architect | `direct` | compile a packet; Build implements; gates |
| Architect | `verified` (default) | direct + focused tests |
| Architect | `redundant` | verified + independent Review |

`--mode` is validated against the selected role's `modes` array. Omitting it
selects `default_mode` if the role declares one, otherwise the role runs alone.
A single-agent packet omits `mode`. There is no `solo` value to pass.

### 2.8 Prompt composition

```
systemPrompt = base role prompt
             + agent configuration summary
             + capability summary
             + verification/approval policy
             + ambiguity policy
```

A repo override at `.machine_code/agents/<role>.md` replaces the base role prompt
only. Mode/config/capability appendices still apply, so an override cannot grant
permissions.

---

## 3. Issue hierarchy and reserved issues

### 3.1 Hierarchy invariants

```
Epic
└── Feature
    └── Task
```

Hard rules:

1. Every Epic has exactly one reserved `Feature 0: Planning & Review`.
2. Every Feature, including Feature 0, has exactly one reserved
   `Task 0: Planning & Review`.
3. Reserved issues are real GitHub issues.
4. Reserved issues are excluded from deliverable completion counts.
5. Every issue-associated run attaches to a Task, never an Epic or Feature.
6. Epic/Feature planning or review runs attach to the appropriate reserved
   Task 0.
7. Implementation runs attach to deliverable Tasks.
8. No duplicate reserved issues; empty duplicates are auto-closed.

Example:

```
Epic #10 — Develop propulsion system
├── Feature 0: Planning & Review
│   └── Task 0: Planning & Review
├── Feature #20 — Combustion chamber
│   ├── Task 0: Planning & Review
│   ├── Task #31 — Implement thermal model
│   └── Task #32 — Implement material properties
└── Feature #21 — Fuel delivery
    ├── Task 0: Planning & Review
    └── Task #40 — Implement fuel injector
```

### 3.2 Reserved identity

| Reserved kind | Type | Title | Labels |
|---|---|---|---|
| Epic planning/review Feature | Feature | `Feature 0: Planning & Review` | `mc:reserved`, `mc:planning-review`, `mc:reserved:epic-pr` |
| Feature planning/review Task | Task | `Task 0: Planning & Review` | `mc:reserved`, `mc:planning-review`, `mc:reserved:feature-pr` |

Body marker:

```markdown
<!-- mc:reserved
{"for":"owner/repo#10","kind":"epic-pr"}
-->
```

The marker is authoritative if the title is edited. `0` is a logical ordinal, not
an issue number.

Issue model:

```ts
type IssueKind = "epic" | "feature" | "task";

interface Issue {
  ref: IssueRef;
  title: string;
  body: string;
  state: "open" | "closed";
  kind: IssueKind;
  issueType?: string;
  labels: string[];
  parent?: IssueRef;
  children: IssueRef[];
  blockedBy: IssueRef[];
  blocking: IssueRef[];
  reserved?: { for: IssueRef; kind: "epic-pr" | "feature-pr" };
  acceptance: string[];
  approval?: "human" | "agent";
  branch?: string;
  pr?: { number: number; url: string; state: string };
  url?: string;
  updatedAt?: string;
}
```

Acceptance criteria are parsed from a `## Acceptance criteria` bullet section.
Missing criteria means closure requires an explicit review verdict.

### 3.3 Ensure, audit, duplicates

`ensureEpic(epic)` creates/reuses Feature 0 then Task 0. `ensureFeature(feature)`
creates/reuses Task 0. `ensureReservedHierarchy(root)` covers both.

Idempotent algorithm:

1. Find reserved child by marker `mc:reserved` + `for` + `kind`.
2. Fall back to reserved label + exact title.
3. If exactly one, reuse it.
4. If none, create it under the correct parent with type/label/title/marker.
5. Any create/link under an Epic or Feature first ensures that parent’s reserved
   chain.

Duplicate detection:

- Group children of a parent by `(parent, reserved kind)`.
- 0 = missing; 1 = healthy; 2+ = duplicate.
- Marker/parent disagreement = conflict, not duplicate.

Canonical priority:

1. matching reserved marker;
2. most associated runs;
3. oldest `createdAt`;
4. lowest issue number.

Empty duplicates (zero runs) are auto-closed as a harness maintenance exception;
the event log records the canonical issue and the closed duplicate. Duplicates
with runs are reported for manual consolidation and never auto-closed. Conflicts
are reported.

`auditHierarchy()` runs on read and reports `reserved_missing`,
`reserved_duplicate`, and `reserved_conflict`. Read-only TUI refreshes never
mutate GitHub; `issue ensure` performs repairs. Auto-closing an empty reserved
duplicate is part of `ensure` and is not a normal issue closure; it is limited to
zero-run reserved duplicates and is recorded in the event log.

### 3.4 Run-to-issue association

| Run kind | Primary issue |
|---|---|
| Epic planning/review | Task 0 under the Epic’s Feature 0 |
| Feature planning/review | that Feature’s Task 0 |
| Task implementation | the deliverable Task |
| Task review | the deliverable Task |
| General/SUDO/untracked | none |
| Unassociated planning | none (category `Planning`) |

Rules:

- Zero or one primary issue per run.
- If one, it must be a Task.
- Never attach directly to an Epic or Feature.
- An issue may have zero or many runs.
- A run may have zero or one parent run.
- Parent-child run relationships are independent of issue relationships.
- A parent run may spawn children on different Tasks.
- Build/implementation runs target deliverable Tasks only; reserved Task 0 is for
  planning, review, and coordination.
- Follow-up Q&A stays in the same run; a new objective creates a new run.
- Task 0 is a long-lived anchor; multiple planning/review runs may attach to it.

Resolution:

```ts
resolvePlanningAnchor(issue): IssueRef
// Epic → its reserved Feature 0's Task 0
// Feature → its reserved Task 0
// Task → itself
```

CLI/TUI use this for Epic/Feature selection. The harness rejects non-Task
associations. `task` never resolves an Epic/Feature; coordination of those
happens in the parent run attached to the reserved Task 0.

### 3.5 Completion, review, closure

- Task 0 is the coordination anchor for its parent.
- Child completion does not complete the parent.
- The parent must satisfy its own acceptance criteria.
- A coordinating run can review, create more children, and repeat.
- Reserved issues are excluded from completion counts.
- Closure requires:
  1. an `acceptance_verified` event;
  2. `issue:close` capability;
  3. no open blocking dependencies;
  4. all deliverable children closed (reserved excluded), unless waived;
  5. for a parent, its own acceptance verdict, not child counts;
  6. for an issue with a branch/PR, the PR merged.
- Reserved issues have no branch/PR and are exempt from the merge check.
- The parent verdict cites a Review child’s `review_verdict` or the
  orchestrator’s explicit acceptance review.
- `approval=human` creates a close request; a human approves in TUI/CLI.
  `approval=agent` closes immediately after the gates above.
- Reserved lifecycle: keep open while parent is open; close with parent; reopen
  if parent reopens. Parent close cascades to its reserved Feature 0 and Task 0;
  parent reopen reopens them.
- `issue_closed` records `closedByRunId` and evidence.

---

## 4. Runs, delegation, branches, and PRs

### 4.1 Run model

```ts
export type RunStatus =
  | "created" | "running" | "awaiting_input" | "paused"
  | "completed" | "blocked" | "failed" | "interrupted" | "cancelled";

export type Verification = "direct" | "verified" | "redundant";
export type Approval = "human" | "agent";

export interface RunSummary {
  schemaVersion: 2;
  id: string;
  repoRoot: string;
  agent: "general" | "architect" | "build" | "review" | "sudo";
  preset?: string;
  delegate: boolean;
  verification: Verification;
  issues: "required" | "optional" | "disabled";
  ask: boolean;
  approval: Approval;
  ambiguity: "strict" | "precise" | "adaptive" | "autonomous";
  capabilities: string[];

  mode?: string;                    // role-declared; absent = single agent
  issue?: IssueRef;                // Task only
  packetId?: string;
  request: string;
  status: RunStatus;

  parentRunId?: string;
  rootRunId?: string;
  forkReason?: "user_interrupt" | "manual" | "resume";
  resumedFrom?: string;

  worktree?: string;
  worktreeOwnerRunId?: string;
  branch?: string;
  baseBranch?: string;
  commit?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: "none" | "open" | "merged" | "closed";

  phase?: "plan" | "delegate" | "implement" | "review" | "gates" | "publish" | "ask";
  pid: number;
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
  turns: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  cost: { actual: number; estimated: number };
  modelCalls: number;
  error?: string;
  finalText?: string;
  contextChars?: number;
  contextSources?: number;
}
```

`children` is derived by scanning `parentRunId`. A child never writes the
parent’s summary. `run.json` and `transcript.json` use atomic temp+rename writes.

Per-run files:

```
.machine_code/local/runs/<run-id>/
  run.json           # atomic summary/state
  events.jsonl       # append-only audit/lifecycle
  transcript.json    # latest model transcript checkpoint
  context.json       # last context manifest
  inbox.jsonl        # answers and follow-up messages
  control            # sequenced control request
  control.ack        # acknowledgement
```

Events:

| Event | Purpose |
|---|---|
| `run_start`, `run_state`, `run_end` | lifecycle |
| `model_select`, `model_call_end` | selection/accounting |
| `tool_call_start`, `tool_call` | tool audit |
| `question`, `answer` | follow-up |
| `checkpoint` | transcript checkpoint |
| `worktree_created`, `worktree_missing` | isolation |
| `branch_created`, `commit_created` | branch pipeline |
| `pr_opened`, `pr_merged`, `pr_closed` | PR pipeline |
| `approval_requested`, `approval_granted` | human approval |
| `issue_linked`, `issue_closed` | issue association/completion |
| `reserved_missing`, `reserved_duplicate`, `reserved_conflict` | hierarchy audit |
| `child_spawned`, `child_completed` | delegation |
| `review_verdict`, `acceptance_verified` | review/completion |
| `context_assembled`, `resume_started`, `fork_paused` | provenance/recovery |

### 4.2 Delegation: `task`

```ts
const TaskParams = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("spawn"), Type.Literal("status"), Type.Literal("result"),
  ])),                                  // default spawn
  agent: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("review"), Type.Literal("sudo")])),
  issue: Type.Optional(Type.String()),  // Task ref: "123" or "owner/repo#123"
  prompt: Type.Optional(Type.String()),
  verification: Type.Optional(Type.Union(["direct", "verified", "redundant"])),
  wait: Type.Optional(Type.Boolean),    // default true
  reviewOfRunId: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),  // status/result
  inherit: Type.Optional(Type.Array(Type.String())),
});
```

Rules:

1. Check `run:spawn` and `delegate=true`.
2. Validate the child role and issue:
   - Architect may spawn `build` or `review`; build requires a deliverable Task;
     review may target a deliverable Task or reserved Task 0.
   - Sudo may spawn only `sudo`; no issue required.
   - Never resolve an Epic/Feature here.
3. Resolve the child’s agent config and capabilities.
4. Create the child run with `parentRunId` and optional `rootRunId`.
5. Build creates a Task worktree. Review shares the Build worktree
   (`worktreeOwnerRunId`). Review of reserved Task 0 uses no worktree.
6. `wait=true` blocks until the child reaches terminal or `awaiting_input`.
   `wait=false` returns the child id; `status`/`result` read it later. Only own
   descendants are visible.
7. Record `child_spawned`/`child_completed`.

Build/Review default `ask=false`; they should receive self-contained packets. If
`ask=true`, they wait for a human exactly like any other run. The TUI must show
“awaiting human” for both parent and child.

A coordinating run alternates:

```
read hierarchy → create/edit issues → delegate build → delegate review
→ evaluate → create missing issues → repeat
```

Planning and review are activities inside a run, not separate run types.

### 4.3 Follow-up questions (`ask`)

- `ask` writes a `question` event, sets `status=awaiting_input`, waits on
  `inbox.jsonl`, then returns the answer as a tool result in the same run.
- `respond <run-id> "..."` appends an answer; it never creates a run.
- A pending question survives restart; `resume` attaches the answer or records an
  orphan.
- `ask` is registered only when `ask=true` and ambiguity is not `autonomous`.
- Build/Review default `ask=false`.
- TUI shows a prominent awaiting-input indicator and a global “Awaiting human”
  filter.

Ambiguity:

| Mode | Behavior |
|---|---|
| `STRICT` | Literal; ask about minor ambiguity; never expand scope. |
| `PRECISE` | Resolve low-impact ambiguity; ask when material. Default. |
| `ADAPTIVE` | Use project judgment; ask when risk warrants. |
| `AUTONOMOUS` | Infer intent; no questions; complete or blocked. |

### 4.4 Branches and worktrees

Branches belong to issues; worktrees belong to runs.

```
main
└── mc/feature/<feature#>-<slug>       one per Feature issue
    ├── mc/task/<task#>-<slug>         one per deliverable Task
    └── mc/task/<task#>-<slug>
```

- Feature integration: fetch `origin`, fast-forward the local Feature branch,
  create the temporary Feature worktree, run integration gates, then open the
  Feature PR. If the local branch cannot fast-forward, stop and report.
- Epic has no branch; it groups Features.
- Reserved Feature 0/Task 0 have no branches or PRs.
- Feature branch: created from `main` (or configured base) when the first Task
  starts, or when Feature planning writes artifacts.
- Task branch: created from the Feature branch at Task start.
- Re-runs reuse the issue branch; each run gets a fresh worktree.
- One active run per Task branch by default; different Tasks may run
  concurrently. Feature merges may conflict; resolve explicitly.

Worktree rules:

| Run kind | Worktree |
|---|---|
| `general` / orchestration | none (read-only main tree) |
| `architect.plan` for an Epic | none; Epic plans are committed to `main` docs-only |
| `architect.plan` for a Feature | temporary Feature worktree on the Feature branch for artifact writes |
| `build` | Task worktree on Task branch |
| `review` on deliverable Task | shares Build worktree read-only |
| `review` on reserved Task 0 | none |
| `sudo` mutation | Task/Sudo worktree on its branch |
| Feature integration | temporary Feature worktree on Feature branch |

- Path: `.machine_code/local/worktrees/<run-id>`.
- Task worktree base = Feature branch; Feature worktree base = Feature branch.
- Feature planning uses a temporary Feature worktree to commit plans/packets to
  the Feature branch. It does not create a PR from Task 0; those artifacts ride
  the Feature PR.
- Epic planning writes plans to the main worktree and leaves them for a docs-only
  human commit; it does not create an Epic branch.
- Preflight: main tree clean except `.machine_code/plans/` and
  `.machine_code/tasks/`; materialize artifacts into the worktree. Code/config/
  knowledge changes must be committed or stashed; `--base` is available.
- Dependency bootstrap: profile `[worktree] links` (TypeScript links
  `node_modules`); validate repo-relative paths; skip missing sources with a
  warning. Do not link build outputs.
- Review sets `worktreeOwnerRunId`; only the owner removes the worktree.
- Only one Feature worktree per Feature branch at a time; Feature planning and
  integration runs serialize on that branch.
- `prune` never removes a worktree referenced by an active run or as
  `worktreeOwnerRunId`.
- Resume recreates from the branch if the path is missing; if both are missing,
  `blocked` with `worktree_missing`, unless `--recreate`.

Creation algorithm:

1. Resolve the main worktree root.
2. Resolve the base branch/ref.
3. Run the clean preflight.
4. Ensure the Feature branch exists (`git branch mc/feature/<n>-<slug> <base>`).
5. For a Task: `git worktree add -b mc/task/<n>-<slug> <path> mc/feature/<n>-<slug>`.
   For a Feature artifact/integration run: `git worktree add <path> mc/feature/<n>-<slug>`.
6. Create dependency links.
7. Materialize packet snapshot.
8. Emit `worktree_created` / `branch_created`.

All Git calls use `runProc` with `GIT_CONFIG_NOSYSTEM=1` and
`GIT_TERMINAL_PROMPT=0`; no shell. Push uses the user’s configured Git credential
helper; `machine_code init` checks `gh auth status` and can run
`gh auth setup-git`. Tokens are never embedded in URLs or logged.

### 4.5 Commit and PR lifecycle

The runner owns commit, push, PR creation, and merge.

Task PR creation is automatic after gates; the PR is marked ready after review.
The `pr` tool is for coordination, status, Feature PRs, and merges. Build/Review
do not need PR capabilities.

1. Build edits the Task worktree.
2. Runner gates pass.
3. Runner commits the Task branch (`git add -A`, structured commit message).
4. Runner pushes the Feature branch (if needed), pushes the Task branch, and
   opens the Task PR into the Feature branch. It stays draft until review passes.
5. Review (if `redundant`) evaluates the commit/PR. Approval marks the PR ready;
   rejection requests changes and blocks merge.
6. Approval:
   - `human` (default): PR is ready for human review/merge; run/issue shows
     “awaiting human.”
   - `agent`: if verification is `verified`/`redundant`, gates pass, Review
     approves, and the issue is not flagged human-only, runner may squash-merge.
7. Task closes after its PR is merged and acceptance is verified.
8. When all deliverable Task PRs are merged and the Feature’s acceptance is
   verified, the runner creates a temporary Feature worktree, runs integration
   gates, and opens the Feature PR to `main`.
9. Feature PR merge is human by default. A Feature may explicitly set
   `approval=agent` to allow agent merge.
10. Epic closes after its own acceptance and all Feature PRs are merged.

PR body includes: issue refs, packet id, gates, review verdict, approval mode,
and evidence. Merge strategy is squash for both Task and Feature PRs.

Approval metadata:

```markdown
<!-- mc:approval
{"mode":"human","reason":"visual UI change"}
-->
```

Planner sets it per Task and Feature; default human. `agent` is only for
verified/redundant work with gates/review and no visual/UI risk. Issues labeled
`ui`, `visual`, or `ux` cannot use `approval=agent`; the harness rejects the
combination.

Human approval flow:

- `approval=human` creates an `approval_requested` event.
- TUI/CLI shows it in “Awaiting human.”
- `machine_code approve <issue|pr>` (or TUI `y`) records `approval_granted` and
  performs the merge/close if gates and PR state allow.
- No agent may bypass a pending human approval.

### 4.6 Fork, parent/child, and resume

- A new unrelated objective creates a child run with `parentRunId`.
- Default fork inherits issue/context, not parent edits or transcript.
- `--inherit-worktree` optionally bases the child on the parent’s branch and
  applies the parent diff; conflicts fail explicitly.
- Parent history is immutable from the child’s perspective.
- A parent may have children on different Tasks; issue associations are
  independent.
- Transcript checkpoints persist after assistant `message_end` and
  `tool_execution_end`.
- Resume:
  - user/toolResult tail → `continue()`;
  - assistant with unanswered tools → synthetic results (inbox answer for `ask`,
    interruption error for others) → `continue()`;
  - terminal assistant text → resume message → `prompt()`;
  - missing transcript → rebuild from request + context.
- Prune oldest complete turns over `context.max_chars`; insert a summary.

### 4.7 CLI surface

```
machine_code run [--agent <role>] [--preset <name>]
                [--mode <mode declared by that role>]
                [--delegate true|false]
                [--verify direct|verified|redundant]
                [--issues required|optional|disabled]
                [--ask true|false] [--approval human|agent]
                [--ambiguity strict|precise|adaptive|autonomous]
                [--issue <task>] [--packet <id>] [--review-of <run-id>]
                [--parent <run-id>] [--base <ref>]
                [--dry-run] [--allow-concurrent]
                "<request>"

machine_code respond <run-id> "<answer>" [--question <id>]
machine_code pause <run-id>
machine_code cancel <run-id>
machine_code fork <run-id> "<new objective>" [--inherit-worktree]
machine_code resume <run-id> [--recreate]

machine_code issue list|view|tree|create|edit|close|link|ensure ...
machine_code pr list|view|create|merge|request-review
machine_code approve <issue|pr>        # human approval queue
machine_code worktree list|remove <run-id> [--delete-branch]
machine_code context <run-id>
```

Compatibility:

- `run --agent architect --mode direct|verified|redundant` selects the
  Architect's data-declared orchestration mode.
- `run --agent build` (no mode) runs Build alone; Build declares no modes.
- `run --agent general` and `run --agent sudo` are single-agent runs.
- `--issue` resolves to a Task. With `--auto-issue`, selecting an Epic creates
  its Feature → Task chain (or reuses exact-title open children). Planning/
  review roles resolve to the reserved Task 0.
- Human approval is required unless the issue metadata explicitly sets
  `approval=agent`.

---

## 5. Context and artifacts

### 5.1 Sources and priority

| Priority | Source | Origin |
|---|---|---|
| 1 | Explicit artifacts (`--packet`, issue `mc:context` block) | explicit |
| 2 | Associated Task | explicit |
| 3 | Parent Feature | inherited |
| 4 | Parent Epic | inherited |
| 5 | Parent run summary/decisions | inherited |
| 6 | Project plan / knowledge index | inherited |
| 7 | Skill descriptions / tool names | explicit |

Reserved Task 0 context includes its parent Feature/Epic and reserved acceptance
criteria. Children inherit selected context from parent runs, never the full
transcript.

### 5.2 Artifact references

```markdown
<!-- mc:context
{"packets":["20261031-thermal"],"files":["src/parser.ts"],
 "knowledge":["knowledge/thermal.md"],"skills":["reference"],
 "tools":["bench"],"scripts":["release-check"]}
-->
```

Issues reference artifacts; they do not duplicate them. References cascade
Task → Feature → Epic (nearest wins), so a Feature can declare the files/tools
that all of its Tasks inherit. Issue bodies stay concise: scope, status,
acceptance criteria, dependencies, approval, references. Tools live in
`.machine_code/tools/<name>.toml`; plain scripts under `.machine_code/scripts/`.

### 5.3 Assembly

1. Resolve hierarchy ancestor-first, max depth 3, cycle-safe.
2. Collect explicit references.
3. Collect project sources (`.machine_code/plan.md` head, optional knowledge
   index; no repo-wide dump).
4. Resolve packets from the current branch/worktree and main artifacts.
5. Collect skill name/description only.
6. Deduplicate by `(kind, ref)` and content hash.
7. Allocate budget by priority; truncate with a marker.
8. Write `context.json`; render labelled blocks.

Default total: 24,000 chars. Caps: packet 8 KiB, Task 6 KiB, Feature 4 KiB, Epic
3 KiB, files/knowledge 8 KiB each, referenced skill 4 KiB, referenced
tool/script 3 KiB, project plan/index 2 KiB.

### 5.4 Artifact versioning

| Artifact | Location | Versioned by |
|---|---|---|
| Feature plans/packets | Feature branch `.machine_code/plans/`, `.machine_code/tasks/` | Feature PR |
| Task packets | Task branch `.machine_code/tasks/` | Task PR |
| Epic plans | `main` `.machine_code/plans/` | Docs-only human commit |
| Ephemeral one-shot packets | `.machine_code/local/tasks/` | None |

- Canonical packet: `.machine_code/tasks/<id>.json`; legacy `.md` JSON read.
- Packets are immutable once a run starts; a snapshot goes into the run/worktree.
- Plans live under `.machine_code/plans/`; created only when first written.
- `artifact:write` is scoped to plans/tasks. Knowledge writes require
  `knowledge:write`, which is not granted by default.
- Issues reference artifacts by id/path; no duplication.

---

## 6. GitHub and PR integration

### 6.1 Issue provider

```ts
export interface IssueProvider {
  readonly kind: string;
  available(): Promise<boolean>;
  get(ref: IssueRef): Promise<Issue | null>;
  list(filter?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<Issue[]>;
  hierarchy(ref: IssueRef): Promise<Issue[]>;
  children(ref: IssueRef): Promise<Issue[]>;
  blockers(ref: IssueRef): Promise<IssueRef[]>;
  create(input: NewIssue): Promise<Issue>;
  update(ref: IssueRef, patch: IssuePatch): Promise<Issue>;
  close(ref: IssueRef, reason?: string): Promise<void>;
  reopen(ref: IssueRef): Promise<void>;
  linkParent(child: IssueRef, parent: IssueRef | null): Promise<void>;
}
```

Implementations: `github` (`gh` CLI, JSON) and `none`.

### 6.2 `issue` tool

Actions: `list`, `view`, `create`, `edit`, `close`, `link`, `ensure`, `tree`.

| Action | Capability |
|---|---|
| `list`, `view`, `tree` | `issue:read` |
| `create`, `edit` | `issue:write` |
| `link` | `issue:hierarchy:write` |
| `close` | `issue:close` + approval policy |
| `ensure` | `issue:hierarchy:write` |

Validation:

- Create Epic → ensure Feature 0 + Task 0.
- Create Feature → ensure Task 0.
- Create Task under Feature → ensure parent Task 0.
- `link` only Feature→Epic, Task→Feature.
- `edit` cannot move parents; reserved identity cannot be removed.
- `close` requires acceptance, blocked-by resolution, child closure, approval.
- `ensure` repairs missing/duplicate reserved issues.

No generic `gh` command exists. Profile/global manifests naming `gh`/`github` are
rejected when issue tracking is enabled.

### 6.3 PR provider and `pr` tool

```ts
interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  mergeable?: boolean;
  head: string;
  base: string;
}

interface PullRequestProvider {
  create(input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequest>;
  status(number: number): Promise<PullRequest>;
  merge(number: number, method: "squash" | "merge" | "rebase"): Promise<void>;
  list(filter?: { head?: string; base?: string; state?: string }): Promise<PullRequest[]>;
}
```

`pr` actions: `create`, `status`, `merge`, `list`, `request-review`.

| Action | Capability |
|---|---|
| `status`, `list` | `pr:read` |
| `create`, `request-review` | `pr:create` |
| `merge` | `pr:merge` + approval policy |

The `pr` tool validates:
- Task PR base is the Feature branch; head is the Task branch.
- Feature PR base is `main`; head is the Feature branch.
- No Task PR targets `main`.
- `merge` respects `approval=human` (approval request) or `approval=agent`.
- Merge method is squash by default.

### 6.4 `gh` mapping and fallback

Verified against `gh` 2.101.0:

```
gh issue list --state all --limit N --json number,title,state,body,labels,issueType,parent,subIssues,subIssuesSummary,blockedBy,blocking,url,updatedAt
gh issue view <n> --json <same>
gh issue create --title <t> --body-file - --type <type> --parent <n> --label <l>
gh issue edit <n> --parent <n> | --remove-parent | --add-sub-issue <n> | --add-blocked-by <n>
gh issue close <n> --reason completed
gh issue reopen <n>
gh pr create --base <base> --head <head> --title <t> --body-file - [--draft]
gh pr view <n> --json number,url,state,isDraft,mergeable,mergedAt
gh pr merge <n> --squash
```

The current repo has `hasIssuesEnabled: true` and `issueTypes: null`, so fallback
is required:

- Type unavailable → labels `mc:epic`, `mc:feature`, `mc:task`.
- Native parent unavailable → `<!-- mc-parent: N -->`.
- Neither → infer kind by depth.

All `gh` calls use an allowlisted environment (`PATH`, `HOME`, `LANG`, `XDG_*`,
`GH_*`, `GITHUB_TOKEN`, `NO_COLOR`); never provider API keys, never a shell.

### 6.5 Caches

```
.machine_code/local/cache/issues.json
.machine_code/local/cache/prs.json
```

TTL 30 s; background refresh; stale cache retained on failure. TUI never calls
`gh` on the draw path.

---

## 7. TUI

The TUI stays six tabs (`runs`, `agents`, `models`, `providers`, `spend`,
`settings`) with the fixed-height frame contract. All new project-status
capability lives inside the Runs tab as views, rollups, badges, and queues; no
new tab is required. Every draw reads local files only — run summaries/events,
issue/PR caches, spend, availability. No network call ever happens on the draw
path.

### 7.1 Issue-primary view (default)

```
Epic #10 — Develop propulsion system            ● 62%  tasks 3/5  runs 8 (1)  $0.42  4m
├── [P&R] Feature 0: Planning & Review          ◐ 1 run (active)  $0.08
│   └── [P&R] Task 0: Planning & Review
│       ├── R100  architect/orchestrate  verified  running      2m
│       └── R130  architect/plan         direct    completed   1h
├── Feature #20 — Combustion chamber            ● 67%  mc/feature/20  PR #88 open  12m
│   ├── [P&R] Task 0: Planning & Review         ✓ 1 run
│   │   └── R101  architect/orchestrate  verified  completed   3h
│   ├── Task #31 — Implement thermal model      ✓ PR #91 merged  $0.19
│   │   ├── R103  build   verified   completed   45m
│   │   └── R108  review  verified   completed   20m
│   └── Task #32 — Implement material properties ⏸ awaiting human  PR #92 open
│       └── R104  build   verified   running     5m
└── Feature #21 — Fuel delivery                 ✖ blocked by #37
    └── [P&R] Task 0: Planning & Review         (no runs yet)

Planning
  R140  architect/orchestrate  strict  awaiting_input

Untracked
  R150  general/assistant      precise completed
```

- Reserved issues display normally with a `[P&R]` badge.
- Each run appears once under its primary Task.
- Branch/PR/approval status is shown on Feature/Task lines.
- Runs with no issue go under `Planning` (architect plan/orchestrate) or
  `Untracked` (everything else).
- `Orphaned issue` holds runs whose issue is not in the cache.
- Multiple runs per issue are sorted by last activity.
- New run on Epic/Feature resolves to reserved Task 0 and shows the target.

### 7.2 Issue status lines and rollups

Every Epic/Feature/Task line carries a computed status segment, built from the
issue cache, run summaries, and PR cache. All rollup math is a pure function
tested in `tui-pure`.

Task line (deliverable):

```
<icon> Task #31 — <title>  [state] [PR #n state] [runs a/t] [$cost] [ago]
```

- `state`: `open`, `in-progress` (≥1 active run), `awaiting human`, `review`,
  `merged`, `closed`, `blocked` (open blocker), `stalled` (no activity beyond
  the stall threshold, default 24 h; §15), `attention` (failed/blocked run).
- `runs a/t`: active/total runs associated with the Task.
- `$cost`: sum of run costs for that Task.
- `ago`: last activity across the Task's runs.

Feature line rollup (reserved Task 0 excluded from deliverable math):

```
<icon> Feature #20 — <title>  [pct%] [tasks c/t] [runs a/t] [branch] [PR state] [cost] [ago]
```

- `pct` = closed deliverable tasks ÷ total deliverable tasks; `—` when no
  deliverable tasks yet.
- PR state: `draft`, `open`, `ready`, `merged`.
- Feature health inherits the worst Task health (`blocked`/`attention`
  dominate), else `on-track`.

Epic line rollup (reserved Feature 0 excluded):

```
<icon> Epic #10 — <title>  [pct%] [features f/t] [tasks c/t] [runs a/t] [cost] [ago]
```

Reserved lines show coordination activity instead of delivery progress:

```
[P&R] Task 0 — Planning & Review   [runs a/t] [last verdict: approved|changes] [ago]
```

Health values: `on-track`, `awaiting human`, `review`, `blocked`, `attention`,
`stalled`, `done`. Highest-severity wins; ties resolve in that order.

### 7.3 Header rollup bar

Line 1 of the frame gains a machine/project rollup next to the tabs:

```
runs 4 active · 2 awaiting · 1 paused · 3 blocked · 12 done | PRs 2 open · 1 draft
| approvals 2 | issues 1 blocked · 1 stalled | spend $1.24 today | 3 inst
```

- Counts derive from the same rollup functions as issue lines (single source).
- `approvals` counts pending human approvals (merge/close) plus unanswered
  questions.
- `spend` is the existing machine-wide spend summary for today.
- In `issues` grouping the bar shows the selected Epic/Feature rollup when the
  cursor is on a group line; otherwise project totals.

### 7.4 Execution hierarchy view

`g` cycles `issues | runs | directory | status`.

```
R100  architect/orchestrate  Task 0 (Epic #10)   running
├── R103  build   Task #31   completed  [PR #91 merged]
│   └── R108  review  Task #31  completed
└── R104  build   Task #32   running    [awaiting human]
```

Keys: `Enter` detail, `p` parent, `c` children, `x` expand/collapse. Runs are not
duplicated across views; these are alternate groupings. Root-only filter: `r` in
this view lists only runs without a parent (top-level coordinators), making the
delegation shape of the project visible at a glance.

### 7.5 Awaiting-human queue

A dedicated pseudo-group (and `f` filter value) that aggregates everything
needing a human, ordered by oldest first:

- unanswered `question`s (`awaiting_input` runs), with the question preview;
- PRs awaiting human review/merge under `approval=human`;
- issues awaiting human close approval;
- forks paused pending `--inherit-worktree` decisions are listed as paused, not
  waiting.

Each entry shows the action needed (`answer`, `review`, `merge`, `approve close`),
the target run/issue/PR, and age. `y` acts on the selected entry; `a` answers a
selected question inline. Indicators also appear on the issue line, run line, and
detail view. The TUI never hides a waiting run inside a collapsed group without a
count badge.

### 7.6 Activity feed

An `l` toggle inside the Runs tab switches the body to a reverse-chronological
feed of the latest events across all visible runs:

```
12:04  R104  ▶ gates          verified      PASS (2/2)
12:03  R104  ◉ model_call     gpt-oss-20b   1.2k tok  $0.0009
12:01  R100  ⌘ child_spawned  R104 build #32
11:58  R103  ■ pr_opened      #91 → mc/feature/20
11:40  R100  ? question       "Which solver for transient terms?"
```

- Sources: tail of each run's `events.jsonl` (bounded scan, capped at ~200 lines
  per refresh).
- Highlight filter follows the current status filter; `j/k` selects an entry and
  `Enter` jumps to that run/event in detail view.
- Paused by default while scrolled (`p` freezes/unfreezes) so the feed does not
  move under the cursor.

### 7.7 Status vocabulary and badges

Single mapping used by every view (issue lines, run lines, header, feed):

| Status | Icon | Color |
|---|---|---|
| `created` | ○ | gray |
| `running` | ● | cyan |
| `awaiting_input` | ? | yellow |
| `paused` | ⏸ | yellow |
| `completed` | ✓ | green |
| `blocked` | ⊘ | yellow |
| `failed` | ✗ | red |
| `interrupted` | ◯ | gray |
| `cancelled` | ⃠ | gray |

Issue-health badges: `[P&R]` reserved, `[ui]` human-review-required label,
`[merge-conflict]`, `[stale]` cache age, `[orphan]`. Badges are text, not color
alone, so status survives color-blind palettes and non-color terminals.

### 7.8 Sorting and search

- `s` cycles sort: `activity` (default), `issue number`, `status severity`,
  `cost`. Sort applies within groups, never across hierarchy parent/child order.
- `/` opens a substring filter over issue titles, run ids, agent, preset,
  status, and branch/PR numbers; `Enter` applies, `Esc` clears. Filter composes
  with `f` status filters.
- The selected item survives refreshes and re-sorts by identity (run id), not
  row position.

### 7.9 Health warnings and degraded modes

The TUI surfaces its own operational state:

- `issues: fresh 12s | stale 3m | unavailable (gh missing)` in the header line.
- `Orphaned issue` group when runs reference issues missing from the cache.
- `reserved_duplicate`/`reserved_conflict` badges on the affected parent line.
- Worktree warnings: `missing` worktree for an interrupted run;
  `owner=dead` when the owner run is interrupted but the worktree is still
  linked.
- Dead-instance notice when a run is `running` but its PID is gone (the existing
  reconcile logic marks it `interrupted` on next read).
- Gate-failure flash on the issue line (`attention`) when the latest run for a
  Task ended `blocked`.

### 7.10 Data sources and refresh contract

| Data | Source | Refresh |
|---|---|---|
| Runs list/summaries | `run.json` files | every draw (1 s) |
| Run detail/events | `events.jsonl` | on selection/scroll |
| Issue hierarchy | `cache/issues.json` | background, TTL 30 s, `r` forces |
| PR state | `cache/prs.json` | background, TTL 30 s, `r` forces |
| Approvals queue | derived: runs + caches | every draw |
| Activity feed | event tails | every 2 s, bounded |
| Spend | `spend.jsonl` summary | every 5 s |

Rollups, health, badges, and the queue are pure derivations over these sources;
no new state files are required. If the issue cache is empty or `gh` is missing,
the TUI falls back to `directory` grouping and shows why.

### 7.11 Filters and actions

Filters (`f`): `active`, `paused`, `completed`, `awaiting human`, `all`.

| Key | Action |
|---|---|
| `n` | New run from selected issue (resolves Task 0 for Epic/Feature) |
| `a` | Answer pending question |
| `i` | Pause/interrupt |
| `c` | Cancel (runs view) / expand children (run tree) |
| `f` | Fork with a new objective / cycle status filter (views without forks) |
| `r` | Refresh issue/PR cache (runs view) / root-only filter (run tree) |
| `g` | Cycle grouping |
| `l` | Toggle activity feed |
| `s` | Cycle sort |
| `/` | Search filter |
| `Enter` | Detail / jump to event (activity feed) |
| `p` | Parent run |
| `y` | Approve pending human action (when permitted) |
| `o` | Open PR/issue in browser |
| `Space` | Fold/unfold group |

Key meanings are view-scoped; the footer always shows the active mapping. The
existing `g` group-cycling and `Space` fold behaviors are preserved.

New-run screen: agent, preset, delegate, verification, issues, ask, approval,
ambiguity, resolved issue.

### 7.12 Detail view

Show:

- run id, status, agent, preset/config, verification, approval, ambiguity;
- primary Task, reserved badge, parent/root run;
- branch, base branch, commit, PR number/state;
- worktree path and owner;
- context source count and manifest summary;
- pending question + answer input;
- pending approval actions (`y` to approve, `o` to open);
- child runs and statuses;
- issue rollup for the associated Task (state, pct, blockers);
- events, including `approval_requested`, `pr_opened`, `pr_merged`,
  `reserved_duplicate`, `review_verdict`, `acceptance_verified`;
- cost/usage roll-up for the run and, for coordinators, the sum over children.

---

## 8. Configuration

Machine `config.toml`:

```toml
[ambiguity]
default = "precise"

[issues]
provider = "github"          # github | none
policy = "optional"          # required | optional | disabled
cache_ttl_seconds = 30

[context]
max_chars = 24000
plan_file = ".machine_code/plan.md"
knowledge_index = ".machine_code/knowledge/index.md"

[worktrees]
enabled = true
require_clean = true         # except plan/packet artifacts

[git]
base_branch = "main"
feature_prefix = "mc/feature"
task_prefix = "mc/task"
merge_strategy = "squash"
delete_branch_after_merge = true

[prs]
draft_until_review = true

[agents.architect]
preset = "orchestrate"
delegate = true
verification = "verified"
issues = "optional"
ask = true
approval = "human"
ambiguity = "precise"

[agents.build]
preset = "implement"
verification = "verified"
ask = false
approval = "human"

[agents.review]
preset = "review"
ask = false

[agents.general]
preset = "assistant"
issues = "disabled"

[agents.sudo]
preset = "unrestricted"
delegate = true
issues = "optional"
ask = true
approval = "human"
```

Repo `policy.toml` may override the same fields. Precedence:

```
run flag → agent policy → repo policy → machine config → preset → built-in
```

Defaults:

- Verification: `verified` for implementation, `direct` for planning/review.
- Issues: `optional` for architect/build/review/sudo, `disabled` for general.
- Ask: true for architect/general/sudo, false for build/review.
- Approval: human.
- Delegate: false except architect.orchestrate and sudo.
- Worktree `require_clean`: true, except plan/packet artifacts.
- Merge: squash; Feature-to-main human by default.

`issue_tracking` is the per-agent form of `issues`; `[issues] policy` is the
project default. `disabled` never constructs a provider.

---

## 9. Conflicts with existing functionality

| Conflict | Resolution |
|---|---|
| Existing modes conflate execution and verification | Split into role-owned orchestration `modes` + `verification` overrides |
| `solo` hardcoded | Removed; a role with empty `modes` runs alone |
| Architect is read-only | Gains `artifact:write`, issue, and (orchestrate) PR capabilities; still no `code:write` |
| `task` is a stub | Repurposed as delegation; child roles depend on parent role |
| No worktrees | Worktrees per run; branches per issue |
| No PR pipeline | Runner-owned commit/push/PR with approval policy |
| No issue hierarchy | Provider + reserved issue invariants |
| TUI groups by directory/status | Issue-primary view + independent run tree; old groupings remain |
| Parent completion inferred from children | Parent acceptance + approval required |
| Review only in `redundant` | Verification level controls Review; orchestrator may delegate review separately |
| Packets never persisted | Runner writes; path/extension fixed |
| No tests | `node:test` in Phase 0 |
| `plan.md` says six tools | Amend to nine: six + `ask`, `issue`, `pr` |

---

## 10. Implementation phases

### Phase 0 — Foundations, schema, tests, packets

- `schemaVersion`, status union, `lastActivityAt`, v1 read migration.
- Atomic JSON writes.
- `node:test` harness; `npm test`.
- Fix packet resolver (`.json` canonical, legacy `.md` read, one path).
- Persist Architect-generated packets.
- Tests: migration, atomic write, packet round-trip.

Exit: old runs work; generated packet on disk; tests pass.

### Phase 1 — Worktrees, branches, PR plumbing

- `src/worktree.ts`: create/remove/list/exists, base ref, clean preflight,
  dependency links, materialization.
- Branch model: Feature branch, Task branch, issue-based names, reuse.
- Split `repoRoot`/`toolRoot`; route tools, commands, gates, LSP, Review.
- Worktree fields, worktree owner/sharing.
- `machine_code worktree list|remove`; prune integration.
- Git commit helper and `gh pr` provider skeleton.
- Tests: isolation, branch creation, dirty preflight, links, gates, resume,
  prune, commit.

Exit: Task worktree based on Feature branch; main tree untouched; gates run in
the worktree; commit created by runner.

### Phase 2 — Run lifecycle, `ask`, fork, resume

- Transcript checkpoints; tail repair.
- `ask`; inbox; `respond`; TUI answer input.
- `pause`, `cancel`, `fork`; parent/child metadata.
- `resume` reconstruction.
- Tests: two questions one run, fork isolation, SIGKILL resume, orphan answer.

Exit: one run asks twice; new objective creates a child; resume works.

### Phase 3 — Agent configuration, capabilities, delegation

- `src/agents/config.ts` / `src/policy/capabilities.ts`.
- Presets + explicit overrides; legacy `--mode` aliases.
- Capability matrix; tool registration; artifact scope; knowledge capability.
- Implement `task`: role-aware children, Task validation, sudo→sudo,
  awaiting_input return, status/result.
- Prompt composition.
- Tests: config precedence, capability enforcement, child-role rules,
  architect.plan cannot spawn, build/review cannot escalate.

Exit: configs resolve; roles/modes/capabilities distinct; delegation works.

### Phase 4 — Issues, hierarchy, reserved issues

- Provider interface, GitHub `gh`, null provider.
- `issue` tool with action-gated capabilities.
- Reserved Feature 0/Task 0 creation, ensure/audit, duplicate auto-close.
- Task-only association; `resolvePlanningAnchor`.
- Hierarchy validation; native/fallback types.
- Issue cache; `issue` CLI; init `gh` check.
- Tests: hierarchy, reserved invariants, empty duplicate auto-close, Task-only,
  type fallback, missing `gh`, disabled policy.

Exit: Epic/Feature creation yields reserved issues; runs never attach to
Epic/Feature; duplicate empty reserved issues are cleaned.

### Phase 5 — PR pipeline and approval

- `pr` tool + provider; `pr:read/create/merge`.
- Runner commit, push, Task PR, Feature PR.
- Approval metadata (`mc:approval`), human approval queue, TUI/CLI approvals.
- Feature integration worktree + gates.
- Squash merge; Feature-to-main human default.
- Branch cleanup.
- Tests: Task PR base, Feature PR base, no Task→main, human approval, agent
  approval conditions, squash, integration gates, merge gating.

Exit: Task PRs target Feature branches; Feature PR targets main; human approval
cannot be bypassed; agent approval only when configured and eligible.

### Phase 6 — Context assembly

- `mc:context` parser; assembler; provenance; `context.json`.
- Task → Feature → Epic → parent run → project/knowledge/skills.
- `contextText` in `runLoop`.
- Branch-scoped artifact resolution.
- Tests: inheritance, dedupe, budget, cycles, missing refs, parent-run context.

Exit: Task run receives task + feature + epic + project context with source
labels; no repo-wide dump.

### Phase 7 — TUI status surfaces

- Issue-primary tree, reserved badges, branch/PR/approval status.
- Issue status lines and rollups (§7.2): task state, feature/epic pct, runs
  a/t, cost, last activity, health classification.
- Header rollup bar (§7.3): active/awaiting/paused/blocked/done counts, open
  PRs, pending approvals, spend today, instance count.
- Run-tree grouping with parent/child navigation and root-only filter.
- Awaiting-human queue (§7.5) with inline answer/approve actions.
- Activity feed (§7.6): bounded event tails, jump-to-event, freeze while
  scrolled.
- Shared status vocabulary/badges (§7.7) across all views.
- Sorting (`s`) and search (`/`); selection stability across refreshes.
- Health warnings (§7.9): cache age, orphans, reserved duplicates, dead
  instances, missing worktrees, gate-failure attention.
- Filters, new-run-from-issue, answer/pause/cancel/fork/approve.
- Issue/PR cache refresh and no-`gh` fallback to directory grouping.
- Detail view additions (§7.12), including child cost roll-up.

Exit: hierarchy and run tree both work; rollups/health/awaiting-human are
visible and correct in fixtures; waiting runs are never hidden; controls
reachable; draw path performs no network calls.

### Phase 8 — Completion, hardening, migration

- `acceptance_verified` and close approval enforcement.
- Parent acceptance gate; no child-count closure.
- Reserved lifecycle close/reopen.
- Opt-in GitHub integration test; migration test; concurrency stress.
- Update `plan.md` (nine tools, branches/PRs, reserved issues, verification).
- Update README/init.

Exit: parent cannot close without acceptance + approval; reserved issues follow
parent lifecycle; existing functionality preserved.

Dependencies:

```
0 → 1 (worktrees/branches) → 2 (lifecycle)
                                  ↓
                          3 (config/capabilities)
                                  ↓
                          4 (issues/reserved)
                                  ↓
                          5 (PR/approval)
                                  ↓
                          6 (context) → 7 (TUI) → 8 (completion)
```

Delegation in Phase 3 needs worktrees from Phase 1 and issue validation from
Phase 4; the capability layer lands first, then connect. PR in Phase 5 needs
Phase 3/4.

---

## 11. Test plan

`node:test`; tests import compiled `dist/`. Temp dirs/git repos; fake issue/PR
providers; no network/`gh` in the default suite.

| Suite | Cases |
|---|---|
| `run-schema` | v1→v2, `done`→`completed`, atomic write, status transitions |
| `worktree` | isolation, task base=feature, links, gates, review sharing, resume, prune |
| `branch` | feature/task branch creation, reuse, naming, concurrent tasks, cleanup |
| `transcript` | save/load, tail repair, prune/summary, cap |
| `question` | ask/answer, multiple questions, abort, restart, orphan |
| `fork` | parent pause, child independence, inherit-worktree, conflict |
| `config` | presets, overrides, precedence, legacy mode aliases |
| `capabilities` | matrix, tool registration, artifact scope, no escalation |
| `delegation` | child roles, Task validation, sudo→sudo, awaiting_input, status/result |
| `ambiguity` | precedence, prompt, `ask` registration |
| `issue-provider` | JSON fixtures, hierarchy, dependencies, type fallback, null |
| `reserved` | Feature 0/Task 0 creation, idempotency, duplicate auto-close, conflicts |
| `association` | Task-only, Epic/Feature resolution, one primary |
| `pr` | Task→Feature, Feature→main, no Task→main, squash, state |
| `approval` | human queue, agent eligibility, visual/human-only, no bypass |
| `completion` | acceptance gate, parent verdict, child closure, reserved exclusion |
| `context` | priority, dedupe, budget, provenance, cycles, parent-run inheritance |
| `tui-pure` | issue tree, reserved badges, run tree, awaiting-human queue, rollup math (pct, runs a/t, cost), health classification and severity ordering, header counts, sorting/search, activity-feed selection, degraded-mode fallbacks, status icon/badge mapping |
| `compat` | legacy modes, old packets, old runs, queue |

---

## 12. Backward compatibility

- v1 `run.json` without `schemaVersion`:
  - `done` → `completed`;
  - `mode` maps to `delegate`/`verification` defaults;
  - missing `approval` → `human`;
  - missing `lastActivityAt` → `startedAt`/`endedAt`.
- `--mode` is accepted only when the selected role declares it. `solo` is
  rejected with a hint to omit `--mode`; old runs with `mode: "solo"` remain
  readable as display-only legacy data.
- Single-agent queued packets may omit `mode`.
- `task` becomes real; it only spawns when `delegate=true` and `run:spawn`.
- Legacy `.md` packets remain readable.
- Existing control file/ack remain valid; new actions additive.
- No GitHub config required for general/sudo/untracked.
- Existing TUI grouping modes remain alongside issue grouping.

---

## 13. Risks and non-goals

| Risk | Mitigation |
|---|---|
| Verification/delegation confusion | Separate `verification` from `delegate`; runner-owned review |
| Capability drift | Resolve once; filter tools; re-check in handlers |
| Reserved issue duplication | Marker/label/title priority; auto-close empty; report with runs |
| Runs attach to Epic/Feature | `resolvePlanningAnchor`; harness rejects non-Task |
| Parent closed too early | Acceptance verdict + approval + child closure |
| Human approval bypass | `pr:merge`/`issue:close` check approval; no raw gh |
| Task PR targets main | PR tool validates base/head |
| Feature branch divergence | Task PRs squash into Feature; Feature integration gates |
| Worktree dependency gaps | Profile links; TypeScript `node_modules`; document venv limits |
| Dirty main tree diverges | Clean preflight; allow plan/packet artifacts only |
| Review sees wrong tree | Share Task worktree via owner; never copy |
| Concurrent branch conflicts | Expected; one active run per Task branch; explicit resolution |
| Transcript growth | Turn-boundary pruning + summary |
| Crash mid-tool | Synthetic interrupted results; no blind mutation replay |
| `gh` auth under minimal env | Allowlist `GH_*`/`XDG_*`/`HOME`; no provider secrets |
| Issue types unavailable | Label/marker/depth fallback (verified `issueTypes:null`) |
| TUI blocks on `gh` | Background cache; draw reads disk only |
| Scope creep | Non-goals below |

Non-goals: auto-merge beyond approval policy, container sandbox, daemon/API,
embeddings, parallel model calls within a run, web UI, GitHub Projects beyond
`gh` reads, replacing `pi-agent-core`.

---

## 14. Acceptance criteria mapping

| Criterion | Phase | Verification |
|---|---|---|
| No PLAN/BUILD/FULL workflow abstraction | 3 | Config fields only; no workflow enum |
| Roles, config, run modes, permissions distinct | 3 | Config/capability tests |
| Every Epic has exactly one reserved Feature 0 | 4 | ensure/idempotency/duplicate tests |
| Every Feature has exactly one reserved Task 0 | 4 | creation/repair tests |
| Reserved issues are real GitHub issues | 4 | provider fixtures/integration |
| Runs can exist without issue associations | 2/4 | untracked run test |
| Issue-associated runs attach only to Tasks | 4 | Epic/Feature rejected |
| Epic planning/review attach to reserved Task 0 | 4 | `resolvePlanningAnchor` |
| Feature planning/review attach to reserved Task 0 | 4 | `resolvePlanningAnchor` |
| Implementation runs attach to deliverable Tasks | 3/4 | delegation + association |
| One coordinating run plans/delegates/reviews/re-plans | 3 | multi-cycle single run |
| Parent/child runs independent of issue hierarchy | 2/3 | fork + cross-Task children |
| Parent needs own acceptance before closure | 8 | no child-count closure |
| General/SUDO without GitHub | 4 | null/disabled provider |
| Issue/run status visible at a glance (rollups, health, awaiting human) | 7 | `tui-pure` rollup/health/queue fixtures |
| Draw path performs no network calls | 7 | refresh-contract test: draw reads caches only |
| Existing functionality preserved | 0/8 | compat suite |
| Task PRs target Feature branch | 5 | PR base/head tests |
| Feature PR targets main | 5 | PR base/head tests |
| Human approval cannot be bypassed | 5 | approval gating tests |
| Agent approval only when eligible | 5 | verification/visual tests |
| Review shares Task worktree | 1 | worktree owner tests |
| Branch-scoped artifacts | 5/6 | artifact versioning tests |
| Reserved duplicates auto-close only when empty | 4 | duplicate tests |

---

## 15. Settled decisions and residual choices

All architectural decisions are settled:

| Decision | Resolution |
|---|---|
| Run-mode interaction | `delegate` + `verification`; legacy `--mode` aliases |
| Close authority | human approval default; agent opt-in per Task/Feature |
| Delegation + questions | build/review ask off by default; if enabled, wait for human |
| SUDO delegation | sudo children only; all capabilities |
| Reserved lifecycle | close with parent, reopen on parent reopen |
| Duplicate reserved | canonical by marker/runs/age/number; auto-close empty |
| Review worktree | share Task worktree read-only |
| Artifact scope | plans + packets; knowledge separate capability |
| Dirty tree | allow plan/packet artifacts only |
| Artifact versioning | branch-scoped; Epic plans on main; ephemeral local |
| Approval granularity | per Task/Feature; default human |
| Merge strategy | squash tasks and features |
| Feature→main | human by default; Feature approval=agent opt-in |
| Branch model | one branch per issue, reused |
| PR ownership | runner-owned PR tool; Feature integration worktree |

Residual implementation choices (not architectural blockers):

1. Branch slug length/format and collision handling.
2. Draft handling for verification levels without Review: mark ready after gates.
3. Commit message template.
4. Whether to delete Task branches immediately after squash merge.
5. Exact Feature integration gate set.
6. TUI key for approval (`y`) and PR open (`o`).
7. Human approval timeout/expiry behavior.
8. "Stalled" threshold for issue health (default: no run activity for 24 h).
9. Activity-feed cap per refresh (default ~200 event lines) and freeze key (`p`).
10. Header rollup bar density on narrow terminals (which counts to drop first).
