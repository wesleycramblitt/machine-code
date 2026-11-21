commit: 20d132689d7011c01d2d2a599099cecd4a791341
files: src/agents.ts, src/agents/config.ts, src/policy/capabilities.ts, src/commands/research.ts, data/agents/research.toml, data/agents/engineer.toml, data/prompts/base.md
acceptance: script:build
keywords: issue:create, research:verify, allowed_paths, issue-curation

# Wire roles, prompts, and verify for tool-guarded curation

Behavior change: research role uses `command` tool for `issue:create`, `issue:update`, and `issue:show`. Engineer role has no issue write paths. Prompts in `data/prompts/base.md` and role files ban raw `issues/` writes and point to the issue commands. Skill `issue-curation` describes only command use, never raw write. `research:verify` in `src/commands/research.ts` rejects issues outside `todo`, `blocked`, `done`, or `ideas` dirs.

Config change: `data/agents/research.toml` keeps `allowed_paths` for docs and references but removes `issues/` direct write. `data/agents/engineer.toml` keeps code write. Capability check in `src/policy/capabilities.ts` and tool gating in `src/agents/config.ts` enforce the split.

Verify: run `script:build`. Run `research:verify` with file `issues/features/foo.md`. Check verify fails. Run `issue:create` for kind features. Check file lands in `issues/features/todo/`.
