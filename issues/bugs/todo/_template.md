priority: medium
review: none
verification: direct
tags:
depends:
keywords:
acceptance: script:build
todo:
  - [ ] Step 1
  - [ ] Step 2
  - [ ] Step 3
  - [ ] Finish

# Title

Prompt body in markdown. This text is the definition of done.

## Notes

- `priority`: low | medium | high (default medium; omitted when medium)
- `review`: none | agent | human (default none; omitted when none)
- `verification`: direct | verified (default direct; only written when verified)
- `tags`: comma list
- `depends`: comma list of issue slugs that must be done first
- `keywords`: comma-separated phrases naming the exact UI strings, page names, or commands involved (e.g. `Run Details, Timeline, TUI`); the runner matches these exactly to find files
- `acceptance`: comma list of runner commands (script:build, script:test, ...)
- `todo`: multi-line checklist; indented `- [ ]` / `- [x]` lines
- Body is the prompt. No `context` field; context files are selected at run time.