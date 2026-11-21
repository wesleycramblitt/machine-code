commit: 00b98c0a515795dcd45f9b599f8f68f2e2ecf1b7
files: src/tools/index.ts, src/tools/safety.ts
acceptance: script:build
keywords: write, edit, issues/

# Block raw issues/ writes through write and edit tools

Behavior change: `write` and `edit` tools reject any path under `issues/`. Agents can no longer create `issues/features/*.md` by hand. Agents must use `issue:create` and `issue:update` instead.

Reject with clear error text naming the correct command. Keep `docs/` and `.machine_code/` writes allowed for research role. Keep all other code writes unchanged.

Replace: current path check in `src/tools/index.ts` and `src/tools/safety.ts` which allows any worktree path.

Verify: run `script:build`. Call `write` with path `issues/features/foo.md`. Check call fails. Call `edit` with path `issues/features/todo/foo.md`. Check call fails.
