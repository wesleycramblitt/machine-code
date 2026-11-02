---
name: reference
description: Use when asked to gather or index web and PDF sources into attributed reference bundles.
---

# Reference skill

You are gathering and indexing sources, not writing project code.

## Procedure

1. Search for relevant sources with `reference:search` (query).
2. Open promising sources with `reference:browser` (url) to read them.
3. For PDFs, download or locate them, then extract text with `reference:pdf-extract` (path).
4. Convert each source into an attributed bundle: markdown with front-matter
   (source URL, title, date, author) and a short summary. Cite the origin.
5. Write the bundle with `reference:index` (path, content) under
   `~/.machine_code/references/` (machine-wide) or `.machine_code/references/`
   (project-local). Update `.machine_code/references/links.toml` for project links.
6. Record what you indexed in the packet's context and acceptance.

## Rules

- Never write to project code paths. The index writer is path-scoped to the
  reference directories only.
- Prefer primary sources. Attribute every claim to its source URL.
- Keep bundles small and focused; one topic per bundle.
- General agent never gets these tools. Only an Architect doing reference
  work loads this skill.
EOF