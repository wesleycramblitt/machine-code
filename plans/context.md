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
2. ~~ctx-section-budgets — per-section budgets + accounting~~ — done 2026-11-08
3. ctx-chunk-expand — path:lines snippet includes
4. ctx-tier-descriptions — description-only defaults, on-demand bodies
5. ctx-eval-harness — recall/faithfulness/cost eval
6. ctx-ordering-cache — lost-in-middle ordering + cache-stable layout
7. ctx-compaction — rolling compaction for parent history

Research deferred: revisit SOTA (hybrid retrieval + rerank, embeddings) only if
keyword chunk/expand + tiering prove insufficient.
