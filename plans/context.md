# Context algorithm upgrades

File-first fixes to the context pipeline (preview → composer → assemble → render),
ordered so measurements were valid before optimizations landed.

## Features

- [x] preview-parity — Unify preview and assemble: same caps, secret checks, and file forwarding.
- [x] section-budgets — Per-section accounting with priority truncation (superseded by role-aware priority).
- [x] chunk-expand — `path:lines` snippet includes, TUI-mirroring sections, and role-aware priority.
- [x] tier-descriptions — Description-only defaults for tools, skills, and references with on-demand bodies.
- [x] eval-harness — Recall, faithfulness, and per-section cost in `machine_code eval`.
- [x] ordering-cache — Fixed section order, end-of-context recap, and normalized dedupe.
- [x] parent-index — Parent chain as one-line index with on-demand pull.

## Ideas

- [ ] ctx-hybrid-retrieval — Revisit hybrid retrieval and reranking only if keyword chunk/expand plus tiering prove insufficient.
- [x] ctx-compaction-dropped — Compaction was rejected: build an index and pull on demand instead.
- [ ] scripting - Review the idea of specific prompting that encourage building reusable scripts on a planning run for a feature task packet ahead of time?
- [ ] knowledge maintenance - Look into best way to maintain knowledge graph.
- [ ] repo map, lsp, semantic map - Research best method for injecting those maps into context

