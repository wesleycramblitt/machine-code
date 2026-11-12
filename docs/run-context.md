# Run Context System

> How context flows from run start to each model turn.

---

## Prompt Render Order

The prompt is composed by `renderPromptMessages` in `src/context/render.ts`.
The section order is fixed for prompt-cache stability:

1. **System prompt** — role instructions for the agent.
2. **Assembled context** (`<context>`) — curated sources: issues, files, knowledge,
   skills, references, parent run index lines.
3. **Tool guide** (`<tool-policy>`) — tool selection policy.
4. **Command index** (`<commands>`) — name-only list of available typed commands.
5. **Transcript** — summarized tool-call history.
6. **Workspace** (`<workspace>`) — git diff summary (only when files changed).
7. **Run state** (`<run-state>`) — goal, decisions, findings, changes, questions.

**Stable prefix** (2–4): byte-identical across turns for prompt caching.
**Dynamic tail** (5–7): changes every turn after the first edit.

**Removed from the prompt per turn:** module index (~3 KB), repo map index (~1 KB),
working context (~8 KB), cached read ledger (~0-24 KB), Next:/Read coverage/
Working set lines (~1 KB). Total savings: ~13-37 KB per turn.

---

## 1. Assembled Context

**File:** `src/context/assemble.ts` — `assembleContext()`

Built before the run starts from curated sources:

| Source | Origin | Priority |
|---|---|---|
| Issue | explicit (composer) or inherited (research lists all) | Highest |
| Files | explicit includes, often from hints/suggestions | High |
| Knowledge | explicit includes or `config.context.knowledgeIndex` | Medium |
| Reference citations | explicit includes from central store | Medium |
| Skill descriptions | role defaults + composer overrides (body cold unless `mode=include`) | Low |
| Tool/script index | description-only, body on-demand | Lowest |
| Parent run index lines | inherited chain, depth-capped at 4, one-line summary only | Low |

### Assembly rules

- **Priority budget:** the model's input budget is the cap. No per-section caps.
  Whole sources are dropped lowest-priority-first with named omissions. A lone
  source that exceeds the budget is trimmed mid-content.
- **Deduplication:** by `(kind, ref)` and by normalized content hash.
- **Lost-in-the-middle recap:** when issue sources exist, a `<context-recap>` block
  restates the issue objective at the tail of the stable prefix.
- **Provenance tracking:** each block is
  `<context-block kind="…" source="…" origin="…" depth="…">`. The manifest is
  written to `context.json`.
- **Rendered order:** issue → file → knowledge → reference → skill → script →
  tool → parent-run.

---

## 2. Repo Map

**File:** `src/map/deterministic.ts`

A deterministic cache of structural facts about the repo: file paths, languages,
line counts, top-level symbols with line ranges, import edges, and doc headers.

The map is a **back-end index**, not rendered in the prompt. It powers:
- `inspect target=symbol` — symbol definitions and callers
- `inspect target=file` — file outlines with imports and doc
- `inspect target=directory` — directory listing with symbol counts
- `inspect target=references` — definition locations and import-based references
- `map overview` — directory listing with symbol counts
- `map outline` — one file's top-level symbols
- `map sections` — comment banners inside large files

The map rebuilds asynchronously after each changed turn with coalescing.

---

## 3. Run State

**File:** `src/context/state.ts` — `RunStateStore`

Durable per-run memory, backed by `state.jsonl`. The model interacts with it
through the `context` tool.

### Structured state

| Field | Description |
|---|---|
| `goal` | The run's objective |
| `phase` | `orient → target → act → verify → done` |
| `facts[]` | `finding \| decision \| change` — each with refs, turn, status |
| `open[]` | Unresolved questions |
| `counters` | `{turn, steps, artifacts}` |

### Rendered blocks

| Block | Tag | Cap | Contents |
|---|---|---|---|
| Run state | `<run-state>` | 10 KB | Goal, decisions, findings, changes, open questions |
| Workspace | `<workspace>` | varies | git diff --stat + untracked files (empty when clean) |

### Fact lifecycle

- **Read facts:** recorded automatically from `read`/`inspect` tool results.
- **Search facts:** recorded automatically from `search`/`grep`/`glob` results.
- **Change facts:** recorded from `edit`/`write` tool results.
- **Decision facts:** recorded from `context note kind=decision`.
- **Finding facts:** recorded from `context note kind=finding`.

**State is not the transcript.** Facts are consolidated summaries. The
transcript carries the raw call history. The workspace block replaces the old
three-way change tracking (edit facts + git fingerprints + working file ranges).

---

## 4. Transcript / Tool History

**File:** `src/context/render.ts` — `summarizeOldPayloads()`, `transcriptSteps()`

The raw turn-by-turn conversation (user + assistant + tool results).

- **Complete steps only:** orphan tool calls are dropped.
- **Summarized by default:** last 3 tool results and last 2 assistant messages
  stay verbatim. Older bulk content is head-summarized (first 6 lines) with a
  marker. The model can re-run any tool call for full bytes.
- **Full transcript** is available for resume/replay via checkpoint
  (`src/state/transcript.ts`).

---

## 5. Workspace Block

**File:** `src/context/state.ts` — `renderWorkspace()`

Rendered at prompt time from `git diff --stat` + `git ls-files --others
--exclude-standard`:

```
<workspace>
modified: 2 file(s)
  M src/engine/render.rs
  M src/geometry/mesh.cpp
untracked: 1 file(s)
  ? TODO.md
</workspace>
```

Returns empty string when nothing has changed (zero prompt overhead). Replaces
the old three-way change tracking system (edit facts + git fingerprints +
working file ranges).

---

## 6. Artifacts

**File:** `src/context/artifacts.ts`, `src/context/state.ts`

Content-addressed storage of all tool outputs and read results:

- Every tool result during `ingestTurn()` is stored as an artifact
  (`art_<sha256_prefix>.txt`).
- The model can recall artifacts via `context recall <id>`.
- `inspect` auto-stores its results as artifacts so the model can re-fetch
  without repeating the query.

---

## 7. Inspect Tool

**File:** `src/tools/inspect.ts`

Prefer over `read`/`search`/`map` for codebase queries.

| Target | Returns | LSP enhanced? |
|---|---|---|
| `symbol` | Definition location, kind, signature, source excerpt, callers | Yes — workspace symbols + definition location |
| `file` | Path, language, lines, symbols, imports, doc + optional full source | Yes — document symbols for nested outlines |
| `directory` | Subdirectories, child files with symbol/line counts | No |
| `references` | Definition locations + files that reference the symbol | Yes — references (file:line:col) |

Every LSP call is wrapped in try/catch. Falls back to the deterministic repo
map when LSP is unavailable. Results auto-stored as artifacts.

---

## 8. Context Tool

**File:** `src/tools/context.ts`

| Action | Purpose |
|---|---|
| `note` | Record a finding, decision, or open question |
| `recall` | Pull exact bytes from an artifact |
| `forget` | Resolve a fact or question |
| `state` | Get the full markdown state dump |
| `parent` | Load a parent run's record |

**Removed actions:** `focus` (harness auto-tracks), `expand` (folded into
`inspect`), `next` (removed — rely on the `todo` tool).

---

## 9. Budget System

**File:** `src/context/budget.ts`

- `contextBudget(windowTokens, outputTokens)` → `inputChars`.
- 4 chars per token estimate.
- 8 KB minimum output reserve + 4 KB provider overhead.
- No per-section caps — priority-based dropping only.

---

## Key Separations

| Component | Where | When Built | Contents |
|---|---|---|---|
| Assembled Context | `assemble.ts → <context>` | Pre-run | Issues, files, knowledge, skills, references, parents |
| Repo Map | `deterministic.ts` | Pre-run + async refresh | Structural index (not rendered) |
| Tool Guide | `policy.ts → <tool-policy>` | Static | Tool selection instructions |
| Command Index | `loop.ts → <commands>` | Pre-run | Command names list |
| Transcript | `render.ts` → summarized | Per-turn | Tool call history |
| Workspace | `state.ts → <workspace>` | Per-turn | git diff --stat, untracked files |
| Run State | `state.ts → <run-state>` | Per-turn | Goal, decisions, findings, changes, questions |
| Artifacts | `artifacts.ts` | Per-turn | Stored raw tool results |
| Tool Results | `state.ts` → ingestTurn | Per-turn | Content-addressed, artifact-referenced |

### Design constraints

- The **stable prefix** (assembled context + tool guide + command index) is
  byte-identical across turns for prompt caching.
- The **volatile tail** (transcript + workspace + run state) changes every turn
  and sits after the transcript so it never shifts the cache prefix.
- No git diff, no repo map content, no working context, no ledger is sent to
  the model as source text. The model pulls what it needs via `inspect`,
  `read`, `search`, etc.

---

## File Reference

| File | Role |
|---|---|
| `src/context/types.ts` | Types: `ContextBundle`, `ContextSource`, `ContextKind`, `ContextSection` |
| `src/context/assemble.ts` | `assembleContext()` — curated context block |
| `src/context/budget.ts` | `contextBudget()`, `sectionBudgets()` |
| `src/context/preview.ts` | `previewContext()` — TUI preview |
| `src/context/render.ts` | `renderPromptMessages()` — prompt composition |
| `src/context/state.ts` | `RunStateStore` — facts, workspace, state rendering |
| `src/context/references.ts` | Skill front-matter parsing, skill mode resolution |
| `src/context/git-status.ts` | `readGitStatus()`, `parseStatusPorcelain()` |
| `src/context/artifacts.ts` | `putArtifact()`, `getArtifact()` |
| `src/map/deterministic.ts` | `buildRepoMap()`, `renderMapIndex()` |
| `src/map/modules.ts` | `renderModuleGraph()` (module index removed) |
| `src/map/sections.ts` | Section heading extraction |
| `src/tools/inspect.ts` | `inspectTool()` — codebase retrieval with LSP |
| `src/tools/context.ts` | `contextTool()` — state and parent run inspection |
| `src/tools/policy.ts` | `TOOL_GUIDE` — tool policy block |
| `src/loop.ts` | `runLoop()` — main agent loop |
| `src/orchestrate.ts` | `orchestrate()`, `executeIssue()` |
| `src/state/runs.ts` | `RunRecorder` — run directory management |
| `src/state/run-schema.ts` | `RunSummary` — run.json schema |
| `src/state/progress.ts` | `EvidenceTracker` — loop detector |
| `src/state/transcript.ts` | Transcript checkpoint/resume |