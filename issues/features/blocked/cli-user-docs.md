tags: docs, cli
acceptance: script:build
keywords: CLI, docs, machine_code
todo:
<<<<<<< HEAD:issues/features/blocked/cli-user-docs.md
  - [ ] Locate the change
  - [ ] Make the smallest edit
  - [ ] Finish
=======
  - [x] Inventory existing CLI commands and examples (src/cli, src/commands, scripts/)
  - [x] Draft a user-facing CLI guide (getting started, common workflows, examples)
  - [x] Add docs/cli.md, link from README, and finalize examples
>>>>>>> mc/cli-user-docs:issues/features/todo/cli-user-docs.md

todo:
  - [ ] Inventory existing CLI commands and examples (src/cli, src/commands, scripts/)
  - [ ] Draft a user-facing CLI guide (getting started, common workflows, examples)
  - [ ] Add docs/cli.md, link from README, and finalize examples

# CLI user documentation

Write comprehensive user documentation describing how to use the machine_code CLI. The goal is practical, example-driven documentation that lets new users and power users understand workflows and common commands.

Deliverables

- A new docs/cli.md containing:
  - Quick start: installation, basic configuration, common environment variables
  - Core workflows with examples: creating and running a run, inspecting runs, viewing reports, using the TUI, building the map/index, and running scripts
  - Reference section: important commands (e.g. `machine_code run`, `machine_code show`, `machine_code map`, `machine_code reference`, `scripts/build.sh`) with short examples and typical outputs
  - Troubleshooting tips: common errors, where to find logs, how to interpret run events
  - Links to relevant code locations for maintainers (src/cli, src/commands, scripts/)

- Update README to link to docs/cli.md and surface a short example.

Audience and scope

- Primary audience: new users who have cloned the repo and want to run machine_code locally; secondary audience: contributors who need to understand how the CLI maps to code.
- Keep examples copy-pasteable and tested against the project's scripts where possible.

Acceptance criteria

- docs/cli.md exists in the repository and the README links to it
- The guide covers the quick start and at least three common workflows with examples
- The documentation references the source locations of key commands (src/cli, src/commands, scripts)

Notes

- Start by inventorying executable entrypoints and scripts in the repo (src/cli/*.ts, src/commands, scripts/) to ensure examples match actual commands.
- If anything in the CLI is confusing or missing examples, create follow-up feature/bug issues linking to this one.
