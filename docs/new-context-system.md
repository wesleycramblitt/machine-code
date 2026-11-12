# Context System — Simplification Plan

Replace the existing context system with a smaller, more disciplined one built on
Git, filesystem primitives, and (optionally) LSP for semantic code intelligence.
Drop redundant representations, duplicated tracking, and agent-facing operations
that the harness can do automatically.

---

## Design

| Layer | Purpose | Tool / Source |
|---|---|---|
| **Brief** | What am I supposed to do? | Assembled context (curated, stable prefix) |
| **Codebase Index** | What exists? | Filesystem + Git + LSP (no structured index) |
| **Inspect** | Show me the relevant code | `inspect` tool (symbol/file/directory/references) |
| **Workspace** | What have I inspected, and what changed? | Git diff baseline + tracked file-versions |
| **Memory** | What did I learn that isn't in the source? | Agent-recorded decisions, findings, questions |
| **Artifacts** | Retrieve exact previous evidence | Content-addressed artifact store |

The harness manages retrieval, freshness, storage, and context assembly.  The
agent focuses on understanding the problem and engineering the solution.

---

## Phase 1 — Remove Dead Weight

Internal cleanups.  No changes to the model's prompt or tool surface.

1. **Remove the module index** (`src/map/modules.ts`)
   - Nothing depends on it.  The map outline tool and `inspect` cover the same
     ground without the overhead of a query-biased index per turn.
   - `skipSemantic` / `wantModules` throughout the codebase → delete.
   - Saves ~3 KB per turn from the stable prefix.

2. **Simplify the git status safety net**
   - Replace per-file fingerprint tracking (`mtimeMs` + `size`) with a simple
     comparison of `git status --porcelain` output strings across turns.
   - Removes the `GitStatusEntry` type, the `Map` data structure, and the stat
     calls per file.
   - Internal only — the change facts in the run state look identical.

3. **Remove the `nextAction` / `nextActionTurn` state** (optional, low-risk)
   - The harness already infers the next step.  The "first edit → finish"
     transition in `settleNextAfterChange` proves the model ignores it.
   - Removes the `todo` seeding at run start and the `Next:` line from the
     `<run-state>` block.
   - Model saves ~200 B per turn.

---

## Phase 2 — New Tool Surface

Consolidate the overlapping retrieval tools.

| Tool | Retained? | Change |
|---|---|---|
| `map` (overview/outline/sections) | **Keep** | Lightweight directory + file outline via CLI |
| `read` (path/symbol/section/around) | **Keep** | Raw file content |
| `search` (text/files/symbol) | **Keep** | Text/pattern search |
| `inspect` | **Add** | Deterministic code retrieval using LSP + filesystem |
| `context expand` | **Remove** | Folded into `inspect` |
| `context focus` | **Remove** | Harness auto-tracks working set from tool calls |
| `context recall` | **Rename** → `recall` | Cleaner name |

### `inspect` tool

```
inspect({
  target: "symbol" | "file" | "directory" | "references",
  path?: string,           // file or directory path
  name?: string,           // symbol name
  detail: "summary" | "full"  // result depth
})
```

- Uses LSP for symbol definitions, references, hover (when running).
- Falls back to regex heuristics (from the current map symbol extractor).
- Uses filesystem commands for file/directory queries.
- First-class Git-aware staleness: the result includes a file version hash; if
  the file changed since the inspect call, the artifact is stale.
- Result auto-stored as an artifact so `recall` can re-fetch it without a new
  query.

### Open question

Do we keep `search` as a separate tool, or fold it into `inspect` as
`inspect target=references` / `inspect target=text`?  A dedicated text-search
tool has a simpler schema and is easier for the model to reach for.  Decision
deferred until Phase 2 implementation.

---

## Phase 3 — Workspace + Memory

Replace three parallel tracking systems (edit facts, git status fingerprints,
working-file ranges) with one authoritative source: Git diff.

### Workspace

- At run start, capture `git diff --stat` + `git ls-files --others --exclude-standard` as the baseline.
- After each turn, re-capture and diff the output.
- Render a compact workspace block in the dynamic tail:

```
<workspace>
  changed: 3 files
    M src/geometry/mesh.cpp
    A src/engine/render.rs
    D src/old/legacy.rs
  untracked: 2 files
    TODO.md
    notes.md
</workspace>
```

- File-version tracking: each `inspect`/`read` result records the file's current
  mtime+size hash.  Re-capturing the diff cross-references staleness: "your
  inspect of mesh.cpp is stale — re-run inspect".

### Memory

Simplify `RunStateStore`:

**Agent-recorded (manual):**
- `remember kind=decision "use quadtree for spatial index"`
- `remember kind=finding "MeshGenerator is hot on large inputs"`
- `remember kind=question "does the library support SIMD?"`

**Auto-tracked (harness, no agent calls needed):**
- What files were inspected / read (from tool call logs).
- What file versions were current at inspection time.
- What changed (from the workspace diff).

**Removed:**
- Read facts (automatically derivable from tool history).
- Search facts (automatically derivable from tool history).
- Change facts (replaced by workspace diff).
- Git change facts (same).
- Command facts (replaced by workspace diff for mutations).
- Open question answering / forgetting (low usage, high complexity).

---

## Phase 4 — Prompt Slimming

**Stable prefix (byte-identical across turns):**
```
[system prompt]
[assembled context]     ← curated brief
[tool guide]            ← tool policy
```

No map index, no module index — the model requests what it needs via `inspect`,
`map overview`, `search`, or `read`.

**Dynamic tail (changes every turn):**
```
[workspace]             ← git diff summary (compact)
[memory]                ← decisions + findings + questions
[transcript]            ← summarized tool call history
```

No working-context block, no ledger block.  If the model needs current file
content it calls `read` or `inspect file {path} source=full`.

---

## Phase 5 — LSP Integration (optional, ongoing)

The `inspect` tool uses LSP for symbol-level queries when available:

```
inspect target=symbol name=MeshGenerator
  → LSP definition + references (primary)
  → regex fallback if LSP unavailable
```

For file/directory queries, `inspect` uses CLI commands — no LSP dependency.

The system works without LSP installed.  LSP is a precision enhancement, not a
hard requirement.

---

## Non-Goals

- No LLM-powered research or inspection agent.  Every retrieval path is
  deterministic.
- No new databases, indexing frameworks, or heavyweight abstractions.
- No natural-language queries against the codebase.
- No per-file size rules in the assembled context — priority-based dropping is
  the only budget mechanism.