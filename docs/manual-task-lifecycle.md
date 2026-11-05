# Manual task lifecycle

> **Update:** `machine_code task start|review|approve|cleanup` now provides the
> single-task lifecycle described below. The manual git/gh steps remain as a
> fallback and as an explanation of what the runner does.

Without the orchestrator, **you are the orchestrator**. Before the `task`
commands, `machine_code` gave you the build run and a few approval/close
commands, but commit, Task PR creation, Review, acceptance, closure, and
worktree cleanup were separate steps. The manual sequence below remains the
fallback and shows exactly what the runner now does for you.

With the new commands the short version is:

```bash
machine_code task status 104
machine_code task review 104
machine_code task approve 104
```

`task start 104` is the same pipeline for a Task that has not run yet.

The runner now uses this order:

```text
Build → verification → commit → Review(commit) → Task PR
→ merge gate → acceptance → close → worktree removal
```

The Task PR is not merged, and the Task is not closed, until the review and
merge policy allow it. Feature publishing runs a final aggregate Review before
the Feature PR to main.

In the TUI, press `p` in the Runs list to open the Pipeline view. The old
separate Orchestrate tab is gone. `x` starts the selected scope, `a` approves a
packet, and `A` finishes the selected task.

## The complete manual sequence

### 0. Inspect the worktree first

```bash
machine_code worktree list
machine_code show <run-id> --changes
```

Build runs reuse an existing worktree for the same issue branch. This is what
happened with `#104`: `20261104-202445-1atr` reused `20261104-054553-eisi`, which
already had uncommitted changes. The new run verified them but did not edit or
commit.

If an old worktree is dirty, either commit it or discard it before starting
another run. Otherwise the next run can “complete” without doing the work.

### 1. Build

```bash
machine_code run --agent build --issue 104
```

This creates or reuses:

- worktree: `.machine_code/local/worktrees/<run-id>`
- branch: `mc/task/104`
- base: `mc/feature/98`

With `task start`, the runner commits after Build verification, before Review.
With a bare `machine_code run --agent build`, the agent edits the worktree but
does **not** commit, open a PR, accept, or close.

Run the gates yourself if you want independent confirmation:

```bash
cd .machine_code/local/worktrees/<owner-run-id>
npm run build
npm run typecheck
npm test
npm run lint
```

### 2. Review

There is no public `machine_code review <run-id>` command that attaches the
Review agent to a Build worktree. The built-in Review against a build diff lives
inside orchestration.

Your practical options are:

- **Self-review** the diff and tests. This is the normal non-orchestrator
  option.
- Use the orchestrator’s Review step.
- Use a custom wrapper around the existing Review agent.

In the new pipeline, Build commits first and Review reads
`baseBranch...HEAD`. If you use a bare Build run, review before committing or
commit first and inspect the commit. `core:diff` shows unstaged changes unless
you pass a base ref.

### 3. Commit

```bash
cd .machine_code/local/worktrees/<owner-run-id>
git add -A
git commit -m "Task #104: resolve orchestrator item lineage"
```

The runner normally does this through `commitWorktree`; direct runs do not call
it.

### 4. Push and open the Task PR

```bash
git push -u origin mc/task/104
git push -u origin mc/feature/98

gh pr create \
  --base mc/feature/98 \
  --head mc/task/104 \
  --title "Task #104: resolve orchestrator item lineage" \
  --body "Implements #104."
```

Merge options:

```bash
# machine_code merge path
machine_code approve <task-pr>

# or plain git hosting
gh pr merge <task-pr> --squash
```

`machine_code approve <pr>` merges any open PR. For a manually created PR it
will not have a recorded `approval_requested` event, so it merges without adding
runner approval evidence.

### 5. Record acceptance and close the Task

```bash
machine_code accept 104
machine_code issue close 104
```

`accept` records a human `acceptance_verified` event on the latest run
associated with `#104`.

`issue close` checks `checkCompletion`:

- no open deliverable children
- acceptance evidence exists

If either fails, it refuses to close and prints the reason.

Close options:

- **Human direct:** `accept` then `issue close`.
- **Agent request:** an agent calls `issue action=close`; because approval is
  human it records an approval request. Then:
  ```bash
  machine_code approve 104
  ```
- **Agent approval policy:** the agent closes directly through the issue tool.
- **Orchestrator:** `orchestrate approve --result`, which is excluded here.

### 6. Feature and Epic closure

After every deliverable Task under Feature `#98` is merged and closed:

```bash
machine_code pr feature 98 --gates typescript:build,typescript:typecheck,typescript:test
machine_code approve <feature-pr>
machine_code accept 98
machine_code issue close 98
```

`pr feature` requires all deliverable Tasks under the Feature to be closed. It
creates a temporary Feature worktree, runs a final aggregate Review and the
gates, removes that temporary worktree, pushes `mc/feature/98`, and opens the
Feature PR to `main`. Use `--no-review` to skip the Review agent.

Feature and Epic issue closure follows the same completion gate. Do not close
them until all deliverable children are closed. Reserved Task 0 / Feature 0
anchors should not be handled manually; `issue close` cascades them.

### 7. Remove the Task worktree

```bash
machine_code worktree remove <owner-run-id> --delete-branch
```

Examples:

```bash
# normal run
machine_code worktree remove 20261104-202445-1atr --delete-branch

# reused worktree: use the run that owns the directory
machine_code worktree remove 20261104-054553-eisi --delete-branch
```

Options:

- no flag: refuses if there are uncommitted changes
- `--force`: discards uncommitted changes
- `--delete-branch`: deletes local `mc/task/<n>`
- `machine_code prune`: removes old run directories and orphaned worktrees

Do not prune before `accept` and `close`. Acceptance evidence lives in run
events.

## All supported options today

1. **Single-task lifecycle commands**
   `machine_code task start|review|approve|cleanup` wires the lifecycle
   together: Build, gates, commit, Review, Task PR, merge, acceptance, closure,
   and worktree removal. Use this unless you need to intervene at a git step.

2. **Manual pipeline**
   Build manually, self-review, commit with git, create and merge the Task PR
   with git/gh or `machine_code approve`, then `accept`, `issue close`, and
   `worktree remove`. This remains the fallback when you want raw control.

3. **Hybrid manual pipeline**
   Use `machine_code run` for Build, then use `machine_code approve` for PR
   merges, `machine_code accept`, `machine_code issue close`, and
   `machine_code worktree remove`. Same lifecycle, less raw git/gh.

4. **Packet queue**
   `machine_code queue` runs committed packets through Build, gates, Review,
   commit, and publish. It is not issue-aware, so it will not accept or close
   issue tasks. Useful for non-issue packet work only.

5. **Orchestrator**
   The scheduler path for many Tasks. It uses the same Build → gates → commit →
   Review → Task PR pipeline and the same merge/closure rules.

## For `#104` right now

```bash
cd .machine_code/local/worktrees/20261104-054553-eisi

git diff
npm test

git add -A
git commit -m "Task #104: resolve orchestrator item lineage"
git push -u origin mc/task/104
git push -u origin mc/feature/98

gh pr create --base mc/feature/98 --head mc/task/104 --fill
machine_code approve <pr>

machine_code accept 104
machine_code issue close 104
machine_code worktree remove 20261104-054553-eisi --delete-branch
```

The old gaps are now handled by `task start`: Build commits after verification,
Review reads the commit, the Task PR is gated by policy, and the Task closes
only after the PR merges. The manual steps above remain the fallback.
