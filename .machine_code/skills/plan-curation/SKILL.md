---
name: plan-curation
description: Use when curating plan files. Create and maintain index.md and plan files in plans/ directories.
---

# Plan curation

Plan files track planned features, bugs, or upgrades before they become GitHub
issues. The `plans/` directory holds lightweight markdown files. Keep each
file focused on one area.

## Directory structure

The canonical path is `plans/` at the repository root. Agents also check
machine configuration, nested repositories, and any path the issue declares:

```text
plans/
├── index.md        # semantic map: links with short descriptions
├── tui.md          # TUI upgrades and issues
├── web-tools.md    # web fetch, search, and browse
└── models.md       # providers, models, algorithms
```

## Procedure

1. Read `plans/index.md` to find which file covers the area. If none does,
   plan a new file.
2. Read the existing plan file or files that are relevant. Keep the reading
   scope to one area at a time.
3. Edit the file or create a new one. Keep each file under 200 lines. Split a
   growing area into a new file and add its link to `index.md`.
4. When a GitHub issue is created for a plan entry, add the issue reference
   next to the entry (for example, `(#123)`).
5. When an issue is closed, remove the corresponding plan entry. Do not keep
   stale entries.

## Rules

- Write plans, not logs. No run history or events.
- Keep one area per file. Split when a file exceeds 200 lines.
- Use short, active sentences (ASD-STE100).
- Front-load the file with the fact that helps a reader decide if they need it.
- Reference existing issues when they are created. Use the GitHub issue number.
- Remove entries when their issue is closed. Stale plan entries create noise.
- Do not duplicate information that lives in the issue tracker.