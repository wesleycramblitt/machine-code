# Run Context System — Overview

> How context flows from run start to each model turn: what we keep, what we build
> over time, and how the pieces separate.

---

## Prompt Render Order

The prompt is composed by `renderPromptMessages` in `src/context/render.ts`.  The
section order is fixed for prompt-cache stability:

1. **System prompt** — role instructions for the agent.
2. **Assembled context** (`<context>`) — up-front curated sources (stable prefix).
3. **Repo map index** — directory-level file/symbol index.
4. **Module index** — query-biased module info derived from the map.
5. **Tool guide** (`<tool-policy>`) — policy block (`src/tools/policy.ts`).
6. **Command index** (`<commands>`) — name-only list of available commands.
7. **Transcript** — summarized tool-call history (last 3 results verbatim, last 2
   assistant messages verbatim, older bulk summarized).
8. **Working context** (`<working-context>`) — current file content from disk for
   files that were changed, focused, or fully read.
9. **Run state** (`<run-state>`) — facts, decisions, changes, next action,
   working set — rendered last.

The stable prefix (2–6) is byte-identical across turns for prompt caching.  The
volatile tail (7–9) changes every turn.

---

## 1. Assembled Context

**File:** `src/context/assemble.ts` — `assembleContext()`

Built **before the run starts** from curated sources:

| Source | Origin | Priority |
|---|---|---|
| **Issue** | explicit (composer) or inherited (research lists all) | Highest |
| **Files** | explicit includes, often from hints/suggestions | High |
| **Knowledge** | explicit includes or `config.context.knowledgeIndex` | Medium |
| **Reference citations** | explicit includes from central store | Medium |
| **Skill descriptions** | role defaults + composer overrides (body cold unless `mode=include`) | Low |
| **Tool/script index** | description-only, body on-demand | Lowest |
| **Parent run index lines** | inherited chain, depth-capped at 4, one-line summary only | Low |

### Assembly rules

- **Priority budget:** the model's input budget is the cap.  No per-section caps.
  Whole sources are dropped lowest-priority-first with named omissions.  Only a
  lone source that exceeds the budget is trimmed mid-content.
- **Deduplication:** by `(kind, ref)` and by normalized content hash (near-duplicate
  blocks collapse).
- **Lost-in-the-middle recap:** when issue sources exist, a `<context-recap>` block
  restates the issue objective at the tail of the stable prefix.
- **Provenance tracking:** each block is
  `<context-block kind="…" source="…" origin="…" depth="…">`.  The manifest is
  written to `context.json`.
- **Rendered order (fixed):** issue → file → knowledge → reference → skill →
  script → tool → parent-run.

---

## 2. Repo Map

**File:** `src/map/deterministic.ts`

A **deterministic cache** of structural facts about the repo:

- File paths, languages, line counts, byte counts.
- Top-level symbols with line ranges and doc comments.
- Import edges between files.
- File-level doc headers and comment section headings.
- Small literal strings (UI labels, command names, error text) extracted for
  task-phrase matching.

Rendered as a **compact index** (~1 KB): directory counts, git HEAD, total
symbols — plus hints to drill via `map overview`, `map outline`, `map sections`
tool calls.

The map is **separate from the assembled context** — it is a structural index,
not source content.  It **rebuilds asynchronously** after each changed turn, with
coalescing (`mapRefreshInFlight` / `mapRefreshQueued`).

---

## 3. Module Index

**File:** `src/map/modules.ts`

A **query-biased** module overlay on the repo map.  Contains per-module
summaries, key files, keywords, and dependency edges — all derived
deterministically from the map.  Rendered alongside the map index with a token
budget (3,072 chars), biased toward the request phrase.

---

## 4. Run State

**File:** `src/context/state.ts` — `RunStateStore`

The **durable per-run memory**, backed by `state.jsonl`.  The model interacts
with it via the `context` tool.

### Structured state

| Field | Description |
|---|---|
| `goal` | The run's objective |
| `phase` | `orient → target → act → verify → done` |
| `nextAction` | The current step (set via `todo` or `context note kind=next`) |
| `facts[]` | `finding | decision | change` — each with refs, turn, status (`active | stale`) |
| `workingSet[]` | Files the model explicitly focused |
| `open[]` | Unresolved queries |
| `counters` | `{turn, steps, artifacts}` |

### Rendered blocks

| Block | Tag | Cap | Contents |
|---|---|---|---|
| Run state | `<run-state>` | 10 KB | Goal, decisions, next action, read coverage, findings, working set, changes, open questions |
| Working context | `<working-context>` | 8 KB total / 6 KB per file / max 6 files | Current file content re-read from disk for changed/focused/full-read files |
| Ledger | `<ledger>` | 24 KB | Cached read results from earlier turns (200-entry LRU) |

### Fact lifecycle

- **Read facts:** recorded from `read` tool results — tracks which file ranges
  and symbols the model has seen.
- **Search facts:** recorded from `search`, `glob`, `grep`, and `map` tool
  results — tracks queries and hit paths.
- **Command facts:** recorded from `command run` tool results.
- **Change facts:** recorded from `edit`/`write` tool results and from the git
  status safety net.  Changes mark overlapping read facts as stale.
- **Decision facts:** recorded from `context note kind=decision` — the model's
  own recorded plans.

**State is NOT the transcript** — facts are consolidated summaries, not raw
replays.  The transcript carries the raw call history; the state carries what
the model decided was important.

---

## 5. Transcript / Tool History

**File:** `src/context/render.ts` — `summarizeOldPayloads()`, `transcriptSteps()`

The raw turn-by-turn conversation (user messages + assistant messages + tool
results).

### Handling

- **Complete steps only** — orphan tool calls are dropped (protocol validity).
- **Summarized by default** — the last 3 tool results and last 2 assistant
  messages stay verbatim; older bulk content is head-summarized (first 6 lines)
  with an honest marker.  The model is told it can re-run any tool call for full
  bytes.
- The **full transcript** is available for resume/replay via the checkpoint
  system (`src/state/transcript.ts`).

---

## 6. Git Status

**File:** `src/context/git-status.ts`

This is **not a diff in the prompt** — it is an internal safety net.

- A baseline snapshot is taken at run construction.
- After each turn, `syncGitChanges()` detects new/changed paths since the last
  snapshot.
- Detected changes become `kind:change` facts with `key:change:git:…` in the run
  state.
- The model sees these as "Tree changes (not from this run)" in the run-state
  block.
- The model **never sees raw git diff output** — it is told to use
  `command run core:status` for git state.

---

## 7. Artifacts / Ledger

**File:** `src/context/artifacts.ts`, `src/context/state.ts` (`rememberRead`)

Content-addressed storage of all tool outputs and read results:

- Every tool result during `ingestTurn()` is stored as an artifact
  (`art_<sha256_prefix>.txt`).
- Reads are cached in a `ledger` (`Map<string, LedgerEntry>`, 200-entry LRU).
- The model can recall artifacts via `context recall <id>`.
- The ledger renders as `<ledger>` only if there are entries the working context
  does not already cover.

---

## 8. Context Tool

**File:** `src/tools/context.ts`

The model's remote control for the context system:

| Action | Purpose |
|---|---|
| `note` | Record a finding, decision, open question, or next action |
| `focus` | Pin files into the working set |
| `recall` | Pull exact bytes from an artifact |
| `forget` | Resolve a fact or question |
| `state` | Get the full markdown state dump |
| `expand` | Drill into a file/symbol using the repo map (source, imports, callers, tests) |
| `parent` | Load a parent run's record (request, status, result/error) |

---

## 9. Budget System

**File:** `src/context/budget.ts`

- `contextBudget(windowTokens, outputTokens)` → `inputChars`.
- 4 chars per token estimate.
- 8 KB minimum output reserve + 4 KB provider overhead.
- No per-section caps — priority-based dropping only.
- A `ContextBudget` includes `{contextWindowTokens, outputReserveTokens,
  inputTokens, inputChars}`.

---

## Key Separations

| Component | Where | When Built | Contents |
|---|---|---|---|
| **Assembled Context** | `assemble.ts → <context>` | Pre-run | Issues, files, knowledge, skills, references, parents (index lines) |
| **Repo Map Index** | `deterministic.ts` → inline | Pre-run + async refresh | Directory counts, symbol totals |
| **Module Index** | `modules.ts` → inline | Pre-run + async refresh | Query-biased module summaries |
| **Tool Guide** | `policy.ts → <tool-policy>` | Static | Instructions for what to call |
| **Command Index** | `loop.ts → <commands>` | Pre-run | Names of available commands |
| **Transcript** | `render.ts` → summarized inline | Per-turn | Tool call history (no working context, no run state) |
| **Working Context** | `state.ts → <working-context>` | Per-turn | Current file content from disk |
| **Run State** | `state.ts → <run-state>` | Per-turn | Facts, decisions, changes |
| **Ledger** | `state.ts → <ledger>` | Per-turn | Cached read bytes |
| **Git Diff** | N/A | Not rendered | Only safety-net facts in run state |
| **Tool Results** | `artifacts.ts` | Per-turn | Stored raw, artifact-referenced for recall |

### Design constraints

- Git diffs are **never sent to the model** — only change summaries in the state
  block.
- The stable prefix (assembled context + map index + tool guide + command index)
  is designed for **prompt caching** — it does not change across turns.
- The volatile tail (transcript + working context + run state) changes every
  turn — working context and run state sit **at the very end** so they do not
  shift the cache prefix.
- No git diff and no "repo map content" is sent as source text — the model pulls
  what it needs via tool calls.

---

## File Reference

| File | Role |
|---|---|
| `src/context/types.ts` | Types: `ContextBundle`, `ContextSource`, `ContextKind`, `ContextSection` |
| `src/context/assemble.ts` | `assembleContext()` — builds the curated context block |
| `src/context/budget.ts` | `contextBudget()`, `sectionBudgets()` — budget calculations |
| `src/context/preview.ts` | `previewContext()` — synchronous TUI preview |
| `src/context/render.ts` | `renderPromptMessages()` — prompt composition |
| `src/context/state.ts` | `RunStateStore` — facts, working set, ledger, state rendering |
| `src/context/references.ts` | Skill front-matter parsing, skill mode resolution |
| `src/context/git-status.ts` | `readGitStatus()` — git baseline + delta detection |
| `src/context/artifacts.ts` | `putArtifact()`, `getArtifact()` — content-addressed storage |
| `src/map/deterministic.ts` | `buildRepoMap()`, `renderMapIndex()` — repo structural map |
| `src/map/modules.ts` | `buildModuleIndex()`, `renderModuleIndex()` — query-biased module overlay |
| `src/map/sections.ts` | `sectionHeadings()`, `markdownHeadings()` — comment/MD heading extraction |
| `src/tools/context.ts` | `contextTool()` — model-facing context action tool |
| `src/tools/policy.ts` | `TOOL_GUIDE` — tool policy block |
| `src/loop.ts` | `runLoop()` — main agent loop, prompt assembly orchestration |
| `src/orchestrate.ts` | `orchestrate()`, `executeIssue()` — multi-phase run orchestration |
| `src/state/runs.ts` | `RunRecorder` — run directory management, events, control |
| `src/state/run-schema.ts` | `RunSummary`, `RunSettingsSnapshot` — run.json schema |
| `src/state/progress.ts` | `EvidenceTracker` — loop detector |
| `src/state/transcript.ts` | Transcript checkpoint/resume |