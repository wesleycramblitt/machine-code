files: src/commands/issues.ts, src/plan/issues.ts
keywords: issue:create, issue:update, issue:delete, issue:list, issue:show
acceptance: script:build

# Add tool-guarded issue create, update, delete commands

Add three commands in `src/commands/issues.ts`: `issue:create`, `issue:update`, `issue:delete`.

Behavior change: agents create and change issues only through these commands. Commands reuse `writeIssue`, `updateIssueContents`, `updateIssueMeta`, `moveIssue` from `src/plan/issues.ts`. Commands reject bad kinds, bad statuses, and bad paths. Commands accept only legal dirs from `issueDir`. Research role can call create and update. Engineer role cannot call create, update, or delete.

Replace: raw `write` to `issues/` path by agents.

Verify: run `script:build`. Run `issue:create` with kind features and status todo. Check file lands in `issues/features/todo/`. Run `issue:create` with path `issues/features/foo.md`. Check command fails.
