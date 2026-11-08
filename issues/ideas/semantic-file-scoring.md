---
priority = "high"
prompt = "On a new run from a feature or bug, score repo files against the issue prompt (keywords, symbols, semantic map) and pre-select the top matches in the composer; the human can edit before launch."
tags = [ "context", "engineer" ]
review = "none"
---

# Score and pre-select context files per issue

A new run seeded from an issue should start with the likely-relevant files
already checked, so the engineer begins from a useful working set instead of
an empty composer.

Score files from the issue prompt + tags using the repo map/semantic index
(symbol names, paths, keywords), rank by score, pre-select the top N, and
leave every row editable (`space` toggles, `x` sections off). Keep the score
visible so the human can see why a file was chosen.
