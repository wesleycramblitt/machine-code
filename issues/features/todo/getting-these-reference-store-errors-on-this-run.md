id: 0748b6
branch: mc/getting-these-reference-store-errors-on-this-run-0748b6
acceptance: script:build

Auto-created from run.

Getting these reference store errors on this run. It should be reading the reference ~/.machine_code/references/minecraft-java/   

 ◯ 20261117-161422-9pgn  INTERRUPTED  engineer  26 call(s)  $0.0220  updated 51s ago
 850K total
 ui-config-screen-vanilla-layout
 ⏸ interrupted (51s)

  Overview    Timeline    Processes    Changes    Related    Context


⚡ 16:16:32 command ok 0ms
    ok {"content":[{"type":"text","text":"[cached reference:find from turn 13; no files changed since]\nno reference index matches for \"HeaderAndFooterLayout\""}]} (spac…

⚡ 16:16:32 command ok 0ms
    ok {"content":[{"type":"text","text":"[cached reference:find from turn 14; no files changed since]\nno reference index matches for \"CycleButton\""}]} (space to expan…

⚡ 16:16:32 command ok 0ms
    ok {"content":[{"type":"text","text":"[cached reference:find from turn 14; no files changed since]\nno reference index matches for \"AbstractSliderButton\""}]} (space…

⚡ 16:16:32 command ok 0ms
    ok {"content":[{"type":"text","text":"[cached reference:find from turn 14; no files changed since]\nno reference index matches for \"ScrollableLayout\""}]} (space to …

  16:16:34 record_nudge

◉ Call 25 16:16:34 openrouter/deepseek/deepseek-v4-flash-0731 toolUse 34ktok 0.00074
    ok I have the full ConfigScreen. The reference markdown files aren't reachable by glob/read path. Let me consult the exact API via `reference:read` with the store … 1…
    · end Call 25

⚡ 16:16:36 command ERR 0ms
    ERR {"content":[{"type":"text","text":"bad arguments for reference:read: unknown store. Schema: {\"path\":{\"type\":\"string\",\"required\":true,\"description\":\"S… …

⚡ 16:16:36 command ERR 0ms
    ERR {"content":[{"type":"text","text":"bad arguments for reference:read: unknown store. Schema: {\"path\":{\"type\":\"string\",\"required\":true,\"description\":\"S… …

  16:16:38 record_nudge




Figure out if something is wrong with our reference retrieval system. I attached the reference to that run with the engineer agent.

---

## Diagnosis: reference retrieval system is healthy; the bundle was never in the store

There is no code bug here. The bare `minecraft-java` reference bundle does not
exist in `~/.machine_code/references/`. That is why the run's `reference:find`
calls for `HeaderAndFooterLayout`, `CycleButton`, `AbstractSliderButton`, and
`ScrollableLayout` all returned "no reference index matches" and the agent
could not read it.

**What is in the store** (confirmed by `reference:find`):

- `minecraft-java-fabric/26.2`
- `minecraft-java-mob-ai/26.3`
- `minecraft-java-neoforge/26.1`
- `minecraft-java-forge/1.20.1`
- `minecraft-java-local-inference/2026.10.07`

There is no `minecraft-java/<version>/` product directory.

**Evidence the bundle is absent, not just unreindexed:**

- `reference:read minecraft-java/index.md` -> `reference not found: minecraft-java/index.md`
- `reference:read minecraft-java/26.2/content/...` -> `not found` (the version
  26.2 lives under `minecraft-java-fabric`, which is a different bundle)
- `reference:reindex` exits 0 and rebuilds the catalog normally — so the index
  is current, and it simply has nothing for a bare `minecraft-java`.

**Two triggers compounded in the interrupted run:**

1. The attached reference was never extracted/written into the store under a
   `minecraft-java/` directory, so no index and no content exists for it. This is
   the actual failure. Re-attaching the bundle (via `reference:write` or the
   attach flow writing under `~/.machine_code/references/minecraft-java/
   content/`) and running `reference:reindex` fixes it.
2. The agent then mis-called `reference:read` with a `store:` argument. The
   schema (src/commands/reference.ts:138) accepts only `path` and `limit`, so
   the extra key was rejected as `unknown store`. That is an agent usage error
   and a symptom of #1 — the agent reached for `reference:read` with a raw store
   path only after `reference:find` returned nothing.

**Why `reference:find` cannot find the symbols even after the bundle exists:**
`findReferences` (src/references/store.ts:185) scans only `index.md`,
`topics.yaml`, and per-bundle `api-index.md`. It never searches `content/*.md`.
The vanilla-layout symbols the run wanted live in `content/*.md` and only become
findable once `reference:reindex` has generated their `api-index.md`. So the
correct flow after the bundle is in place is: write the bundle, run
`reference:reindex`, then `reference:find` / `reference:read` work.

**Conclusion:** no change to `src/` is required. The fix is operational: place
the `minecraft-java` bundle in the store and reindex it.
