# Context System — Simplification Plan (Implementation Progress)

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
| **Workspace** | What changed? | Git diff summary (auto-rendered) |
| **Memory** | What did I learn that isn't in the source? | Agent-recorded decisions, findings, questions |
| **Artifacts** | Retrieve exact previous evidence | Content-addressed artifact store |

The harness manages retrieval, freshness, storage, and context assembly.  The
agent focuses on understanding the problem and engineering the solution.

---

## Phase 1 — Remove Dead Weight ✅

| Item | Files Changed | Status |
|---|---|---|
| Remove module index | 12 files | ✅ |
| Simplify git status safety net | 2 files | ✅ |
| Remove `nextAction` / `nextActionTurn` state | 4 files | ✅ |

### What was removed
- **Module index** from the prompt (~3 KB/turn saved). The `semantic` search mode
  was removed; the `graph` search mode was retained using only the repo map.
- **`map.semantic`** config option.
- **Per-file git fingerprint tracking** (mtime + size). Replaced with string
  comparison of `git status --porcelain` output.
- **`nextAction` / `nextActionTurn` state**, `Next:` line in the run state,
  `context note kind=next`, first-todo seeding at run start.

---

## Phase 2 — New Tool Surface ✅

| Tool | Status | Change |
|---|---|---|
| `map` (overview/outline/sections) | **Kept** | Lightweight directory + file outline via CLI |
| `read` (path/symbol/section/around) | **Kept** | Raw file content |
| `search` (text/files/symbol) | **Kept** | Text/pattern search |
| `inspect` | **Added** | Deterministic code retrieval via repo map + filesystem |
| `context expand` | **Removed** | Folded into `inspect` |
| `context focus` | **Removed** | Harness auto-tracks working set from tool calls |
| `context recall` | **Renamed** → `recall` | Cleaner name |

### `inspect` tool

```
inspect({
  target: "symbol" | "file" | "directory" | "references",
  name?: string,       // symbol name (for symbol/references)
  path?: string,       // file or directory path (for file/directory)
  detail: "summary" | "full"
})
```

- Uses repo map for structure, filesystem for source.
- Results auto-stored as artifacts for re-fetch via `recall`.
- Registered for both `engineer` and `research` agents.

### Context tool simplified

5 actions remaining: `note`, `recall`, `forget`, `state`, `parent`.
The `focus`, `expand`, and `next` actions were removed.

---

## Phase 3 — Workspace + Memory ✅

### Workspace block

New `<workspace>` block auto-rendered in the dynamic tail:

```
<workspace>
modified: 2 file(s)
  M src/engine/render.rs
  M src/geometry/mesh.cpp
untracked: 1 file(s)
  ? TODO.md
</workspace>
```

- Runs `git diff --stat` + `git ls-files --others --exclude-standard` at
  prompt time.  Returns empty when nothing changed.
- Replaces the three parallel change-tracking systems (edit facts, git status
  fingerprints, working-file ranges).

### Memory simplified

`<run-state>` block now shows only:
- **Goal**
- **Decisions** (agent-recorded)
- **Findings** (agent-recorded only — read/search/command facts removed)
- **Changes** (from edit/write)
- **Open questions**

Removed from the block:
- `Next:` line
- `Read coverage:` section (derivable from tool history)
- `Working set:` section (harness auto-tracks it)

Removed from internals:
- `syncGitChanges()` — workspace diff is authoritative
- `addGitChangeFact()` — no longer needed
- `gitBaseline` field and `readGitStatus` import

---

## Phase 4 — Prompt Slimming ✅

### Stable prefix (byte-identical across turns)
```
[system prompt]
[assembled context]     ← curated brief
[tool guide]            ← tool policy
[command index]         ← command names
```

The **map index** was removed from the stable prefix. The model requests what
it needs via `inspect`, `map overview`, `search`, or `read`.

### Dynamic tail (changes every turn)
```
[workspace]             ← git diff summary
[memory]                ← decisions + findings + changes + questions
[transcript]            ← summarized tool call history
```

The **working-context block** was removed. The model calls `read` or
`inspect file {path} source=full` for current file content.

### Token savings per turn
| Removed item | Approximate savings |
|---|---|
| Module index | ~3 KB |
| Map index | ~1 KB |
| Working context block | ~8 KB |
| Read coverage / Working set / Next in run state | ~1 KB |
| Ledger block (when present) | ~24 KB |
| **Total per turn** | **~13-37 KB** |

Over 20 turns: ~260-740 KB of tokens saved.

---

## Phase 5 — LSP Integration ✅

The `inspect` tool uses LSP for symbol-level queries when a language server is
available:

```
inspect target=symbol name=MeshGenerator
  → LSP workspace symbols (primary)
  → repo map regex fallback if LSP unavailable

inspect target=references name=MeshGenerator
  → LSP references (primary)
  → import-based reference detection as fallback

inspect target=file path=src/mesh.ts
  → LSP document symbols for outline (summary)
  → repo map file outline as fallback
```

Three lazy-loaded LSP helpers were added to `src/tools/inspect.ts`:
- **`lspSymbolLookup`** — `workspaceSymbols()` to locate a symbol across all
  open languages, with definition location appended.
- **`lspReferencesLookup`** — `workspaceSymbols()` + `references()` for
  precise reference locations (file:line:col).
- **`lspFileOutline`** — `documentSymbols()` for nested container-aware
  outlines (classes, methods, interfaces with children).

The system works without LSP installed — every LSP call is wrapped in a
`try/catch` and falls back to the deterministic map.  LSP is a precision
enhancement, not a hard requirement.

---

## Non-Goals

- No LLM-powered research or inspection agent.  Every retrieval path is
  deterministic.
- No new databases, indexing frameworks, or heavyweight abstractions.
- No natural-language queries against the codebase.
- No per-file size rules in the assembled context — priority-based dropping is
  the only budget mechanism.