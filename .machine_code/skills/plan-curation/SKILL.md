---
name: plan-curation
description: Use when creating or updating plan files in plans/. Items are typed checklist lines that the Runs page renders.
---

# Plan curation

`plans/` is the single work tree. Each plan file is a category (TUI, Models,
Web tools, …), and its checklist lines are the items the Runs page and
`machine_code plan` render.

## Item grammar

```text
- [ ] slug — short title
- [ ] slug — short title → packets/<slug>.md
- [x] slug — short title
```

- **slug**: lowercase, hyphenated, 2–5 words. Stable once written; the item
  id and any branch use it.
- **type**: the nearest `## Features` / `## Bugs` / `## Ideas` heading.
  When the heading is prose, the parser infers from the line (`fix`/`crash`/
  `error` → bug, `maybe`/`explore`/`investigate` → idea, else feature).
  Prefer explicit headings.
- **link**: add `→ packets/<slug>.md` once the packet exists. That nests the
  packet and its runs under the item.
- **done**: `[x]` is a status badge, not a category. Never create a
  `## Done` section or move completed lines.

Ideas are vague statements that can become features or bugs. Put them under
`## Ideas`; a research run turns them into concrete items.

## Procedure

1. Read `plans/index.md` to find the right plan file. If none covers the
   area, create `plans/<area>.md` with a `# <Area>` heading and add it to the
   index.
2. Add the item under `## Features`, `## Bugs`, or `## Ideas` as
   `- [ ] slug — title`. Keep the title one sentence.
3. If a packet exists (or you just created one), append
   `→ packets/<slug>.md`.
4. Mark finished work `[x]` in place.
5. Keep prose outside checklist lines; it is ignored by the parser but useful
   to humans. Do not put real items inside fenced code blocks — fenced
   examples are skipped.

## Rules

- One area per file; split at roughly 200 lines and add the new file to
  `plans/index.md`.
- Write plans, not run logs. No run history or events.
- Do not duplicate what `knowledge/` or packets already record; link instead.
- Use short, active sentences.
