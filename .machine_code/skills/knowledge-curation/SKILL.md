---
name: knowledge-curation
description: Use when curating repository knowledge files. Create and maintain index.md and topic files in knowledge/ directories.
---

# Knowledge curation

Repository knowledge helps agents and humans navigate, use, and modify the
codebase. The `knowledge/` directory holds concise, factual markdown files.
Keep them small: one concept per file.

## Directory structure

The canonical path is `knowledge/` at the repository root. Agents also check
machine configuration, nested repositories, and any path the issue declares:

```text
knowledge/
├── index.md            # semantic map: links with short descriptions
├── architecture.md     # runtime flow, module map, invariants
└── skills-curation.md  # how skills are selected and authored
```

## Procedure

1. Read `knowledge/index.md` to find which file covers the topic. If none
   does, plan a new file.
2. Read the existing file (or files) that relates to the change. Keep the
   reading scope to one concept at a time.
3. Edit the file or create a new one. Keep each file under 200 lines. Split a
   growing topic into a new file and add its link to `index.md`.
4. Update `knowledge/index.md` after any add or rename. Add a one-line
   description. Place the link in the relevant section.
5. Remove stale entries from `index.md` when a file is deleted.

## Rules

- Write facts, not logs. No run history, events, or verbose notes.
- Keep one concept per file. Split when a file exceeds 200 lines.
- Use short, active sentences (ASD-STE100).
- Front-load the file with the fact that helps a reader decide if they need it.
- Reference plans and issues when relevant. Use relative markdown links.
- Do not duplicate source code — summarize the architecture, the invariants,
  and the conventions.