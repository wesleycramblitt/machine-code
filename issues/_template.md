priority: medium
tags:
depends:
files:
keywords:
acceptance: script:build

# Title

Prompt body in markdown. This text is the definition of done.

Write a concise prompt that describes the deliverable. The agent reads this as the goal. Make the scope and acceptance criteria obvious from the text alone.

## Notes

- `priority`: low | medium | high (default medium; omitted when medium)
- `tags`: comma list
- `depends`: comma list of issue slugs that must be done first
- `files`: comma list of repo-relative paths or globs this issue expects to touch (e.g. `src/loop.ts, src/tools/*.ts`); overlapping issues need a `depends:` edge
- `keywords`: comma-separated phrases naming the exact UI strings, page names, or commands involved (e.g. `Run Details, Timeline, TUI`); the runner matches these exactly to find files
- `acceptance`: comma list of runner commands (script:build, script:test, ...)
- Body is the prompt. No `context` field; context files are selected at run time.
