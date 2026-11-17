priority: medium
tags: tui, cli
depends: orchestrator-auto-block-on-blocked-run
files: src/tui/screens/issue-keys.ts, src/cli/issues.ts, src/tui/screens/issue.ts
keywords: Blocked, blocked, block, unblock
acceptance: script:build

# Manually block and unblock an issue

## Problem

Once an issue can land in `blocked/` (from the auto-block feature or a
`depends:` situation), there is no way for a human to block or unblock it, so
a blocked issue is stuck forever. The runs page groups issues by status; a
manual blocked status makes the page much easier to read and stops the
orchestrator from wasting runs on an issue you are not ready to tackle.

## Behavior change

1. A new `block` action in the issue detail screen moves a feature/bug issue
   into `blocked/`. The orchestrator must not dispatch it until it is
   unblocked (it never will once `blocked` is dropped from
   `ENGINEER_WORK_STATUSES` — see the dependent auto-block feature).
2. A matching `unblock` action moves it back to `todo/`. Unblocking is the
   only way out of `blocked/`: dependencies completing never auto-unblocks
   an issue.
3. Publishing the same capability in the CLI: `machine_code issue block
   <slug>` and `machine_code issue unblock <slug>`.

## Where to wire it

- Issue detail screen keys live in `src/tui/screens/issue-keys.ts`. Today
  `n`=start, `a`=approve, `d`=delete, `e`=edit (line 40 area). Add one key,
  e.g. `b`, that toggles block/unblock: `block` when the issue is not in
  `blocked/`, `unblock` when it is. Follow the existing `spawnCli` pattern so
  the act runs in a detached `machine_code` process.
- The CLI side is `src/cli/issues.ts` (`cmdIssue`, around line 108). Reuse
  the existing `moveIssue(layout, slug, "blocked")` / `moveIssue(layout,
  slug, "todo")` primitives (`src/plan/issues.ts:656`), guarded by
  `assertNoActiveRun` like the other move/approve/delete actions.
- `src/tui/screens/issue.ts` renders the action hint line; add `b` to it so
  the key is discoverable. Ideas cannot be blocked — guard against `idea`
  kind (an idea's only statuses are `needs-research`/`researched`).

## Verification

- `machine_code issue block <slug>` moves a feature/bug into
  `features/blocked/` / `bugs/blocked/`.
- `machine_code issue unblock <slug>` returns it to `todo/`.
- The `b` key on the issue detail screen blocks then unblocks the same issue.
- A blocked issue is absent from the orchestrator's dispatch queue.