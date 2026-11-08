# Context algorithm upgrades

File-first fixes to the context pipeline (preview → composer → assemble → render),
ordered so measurements are valid before optimizations land.

## Why
- preview/assemble diverge (caps, secret checks, dropped file includes)
- whole-file-only includes, no chunk/expand or scoring
- blind tail-trim instead of per-section budgets
- no eval (recall/faithfulness/cost) to ablate against

## Packets (in build order)
1. ~~ctx-preview-parity — unify preview/assemble (prerequisite)~~ — done 2026-11-08
2. ~~ctx-section-budgets — per-section budgets + accounting~~ — done 2026-11-08 (superseded: static caps removed, see 3)
3. ~~ctx-chunk-expand — path:lines snippet includes~~ — done 2026-11-08 (folded in: TUI-mirroring sections, role-aware priority, no static caps)
4. ~~ctx-tier-descriptions — description-only defaults, on-demand bodies~~ — done 2026-11-08
5. ~~ctx-eval-harness — recall/faithfulness/cost eval~~ — done 2026-11-08
6. ~~ctx-ordering-cache — lost-in-middle ordering + cache-stable layout~~ — done 2026-11-08
7. ~~ctx-compaction — rolling compaction for parent history~~ — dropped 2026-11-08 (compaction is the wrong model; replaced by ctx-parent-index below)
8. ~~ctx-parent-index — parent chain as one-line index + on-demand pull~~ — done 2026-11-08

Open ideas (not packeted yet): none blocking. Default skill bodies are now description-only (on-demand) unless a role preset or composer include says otherwise.

Research deferred: revisit SOTA (hybrid retrieval + rerank, embeddings) only if
keyword chunk/expand + tiering prove insufficient.
