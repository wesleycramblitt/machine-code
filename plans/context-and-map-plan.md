# machine_code — run context, repository maps, and surgical tools

> **Status: implementation complete (Phases 0-5); live replay evaluation remains as testing.**
>
> Baseline: `ef748e9` (2026-11-02). Evidence run: `20261102-173114-etdx`.
>
> Phase 0 landed on 2026-11-02: byte-accurate `read` paging; `search files`
> ignore/secret fix; `search text` `paths`; current/peak context accounting;
> total-vs-context display in run detail and `machine_code show`.
>
> Phase 1 landed on 2026-11-02: deterministic map and cache; `core:map`;
> `core:status` map/LSP health; `search map/outline`; map-first `symbols`;
> `read { symbol | around }`; bare-large-read outline; map TOC in the first
> prompt.
>
> Phase 2 landed on 2026-11-02: `RunStateStore` and `state.jsonl`/`state.md`;
> content-addressed artifacts; automatic turn ingestion; `context`
> note/focus/recall/forget/state; prompt rendering from state + last step;
> `context_state`/`context_ingested` events.
>
> Prompt condensation landed on 2026-11-02: shared `data/prompts/base.md`
> (1,447 chars), role deltas 138-221 chars, base + deltas 2,349 chars, every
> rendered prompt 1,713-1,794 chars, `machine_code prompts`, and prompt lint
> tests.
>
> Phase 3 landed on 2026-11-02: semantic module annotations, dirty-path
> tracking on edit/write plus a git-status safety net for command-side changes,
> bounded change digest, incremental dirty-module refresh, validation and
> 16 KiB cap, coalesced refresh after changed turns, writer lock, manual
> `machine_code map --semantic --refresh`, spend/event recording, and semantic
> status/index rendering. The full test suite passes (192 tests).
>
> This plan makes a run's prompt a rendered view of a small run state instead
> of a growing replay of every tool call. It adds a mandatory deterministic
> repository map, a bounded semantic layer, surgical read/search tools, an
> artifact-backed run state, a `context` memory tool, and new agent prompts
> that use the map first and write in ASD-STE100. It does not prune history;
> it never admits unnecessary history in the first place.

## 1. Why

The `20261102-173114-etdx` run consumed **735,207 reported tokens** for a
small TUI request and never made an edit.

| Measure | Value |
|---|---|
| Successful provider calls | 24 (27 attempts, 3 retries) |
| Turns | 25 (stopped by `MAX_TURNS`) |
| Fresh input | 63,583 tokens |
| Output | 5,064 tokens |
| Cache read | 666,560 tokens |
| Total | 735,207 tokens |
| Peak context | 144,408 chars (~36k tokens) |
| Sum of all request contexts | 2,237,444 chars (~730k tokens) |
| Tool output in final transcript | 125,954 chars |
| `src/tui.ts` reads | 77,894 chars in 14 non-contiguous reads |
| Cost | $0.0043 |
| Edits | 0 |

The 735k is not one context. It is the same growing transcript sent 24 times.
The fix is **not pruning**. Pruning means we admitted context we did not need
and paid to carry it until it became a problem. The fix is to make the prompt a
rendered view of a small run state, built fresh for each request, so there is
nothing to prune.

The growth came from exploration:

- `read` produced 96,044 chars in 22 calls. `src/tui.ts` alone was 77,894
  chars (62% of all tool output) across 14 probes covering about 1,700 of its
  2,622 lines.
- `search` produced 24,580 chars in 10 calls. `search files "*"` returned a
  truncated 12 KiB listing.
- `command` produced 5,330 chars in 6 calls.
- The run switched models at call 6 for a **0.0011** score difference
  (`ling-3.1-flash` 0.298243 vs `deepseek-v4.1-flash` 0.297148). Call 6 paid
  18,345 fresh input tokens with **0 cache read**. The switch cost cache and
  changed model behavior for no meaningful gain.

Two defects found while tracing the run:

1. **`read` silently skips lines on large files.** It slices lines first
   (`limit` default 2000), then caps at 24 KiB, but computes the continuation
   offset from the line slice (`src/tools/index.ts:74-82`). On `src/tui.ts`
   (2,622 lines, 118,473 bytes), a default read delivers about 500 lines, then
   says `[622 more lines; call read with offset 2001]`. Lines between the byte
   cut and 2000 are never shown.
2. **`search files` bypasses ignore rules.** `args = ["--files",
   ...excludeGlobs(), "--glob", params.pattern]` (`src/tools/index.ts:226-230`).
   Positive `rg` globs override ignore logic. `pattern: "*"` lists `.env` and
   `node_modules`. Confirmed: `rg --files --glob '*'` returns 14,488 paths and
   includes `.env`; plain `rg --files` hides it.

Also:

- `pruneTranscript` exists and has tests (`src/state/transcript.ts:120`,
  `test/lifecycle.test.js:80`) but is **never called by the run loop**. The
  200,000-char transcript budget is not enforced. This plan does not wire it
  in; it retires it from the prompt path. The audit transcript can grow on
  disk without being sent to the model.
- Before Phase 1, `search map` was only `rg --files`. `search symbols` hard-failed
  without LSP. There was no deterministic map.
- `plans/plan.md:61` already promises a filtered repo map of ≤32 KiB, built on
  demand and never auto-loaded. `plans/plan.md:126` lists a bounded repo map
  and semantic fallback as M1 deliverables. They are missing.

## 2. Goals

- Make the prompt a **rendered view of run state**, not a replay of history.
  The run accumulates facts, references, and decisions, never raw transcripts.
- Keep the live prompt **small by construction**. It grows with active facts,
  not with turns. There are no arbitrary caps. The hard limits are the task
  envelope and the model's 90% window. If a run approaches either, the task is
  too big and must become smaller runs.
- Build a **deterministic repository map** for every run. It is generated from
  git and source structure, not hand-maintained.
- Build a **semantic map** from the deterministic map with one bounded LLM
  call. Refresh it incrementally at run start and after changed turns without
  an unmanageable build system.
- Make reads, searches, and edits **surgical**. Never read a large file when an
  outline, a symbol, or a range is enough.
- Make all agents **map-first and low-loop**. Use better prompts, not hardcoded
  turn counts.
- Make every agent answer in **ASD-STE100 Simplified Technical English**.
- Show **LSP, map, context, and total-vs-current-token status** in commands and
  the TUI.
- Cut the replay cost of the evidence run by at least 65% while producing the
  edit it never made.

## 3. Non-goals

- **No post-hoc context pruning.** If a prompt needs eviction, the design
  selected the wrong context. Fix selection, not history.
- No transcript replay into the model. The transcript stays as an audit log.
- No embedding database, vector store, or external index server.
- No cross-project global memory.
- No new shell. Commands remain typed manifests run with `execFile`.
- No `ctags`, tree-sitter CLI, or new language-index dependency.
- No automatic model escalation.
- No fixed tool count. Add a tool only when it removes more calls or tokens
  than it costs.

## 4. Principles

1. **Context is a view, not a log.** The prompt is `render(run_state)` for the
   current step. History is not the input.
2. **Facts are the state.** Paths, symbols, ranges, hashes, decisions, changes,
   and open questions are the durable memory. Raw tool output is evidence for
   one step, then becomes a fact plus a cached artifact.
3. **Selection, not eviction.** A result enters the prompt only when it is
   needed for the current step or is in the working set. There is no later
   cleanup pass.
4. **Deterministic first, LLM second.** Git and source structure produce the
   facts. The model adds prose annotations. Annotations never override facts.
5. **The map is generated state.** It lives under `.machine_code/local/cache/`,
   never in git, never in the repo root.
6. **Coalesced refresh, not per edit.** No background daemon and no watcher.
   Mark dirty per edit, then refresh once at run start and once after a changed
   turn. At most one refresh is in flight; further changed turns queue one
   follow-up. A burst of edits never becomes a burst of model calls.
7. **Read the smallest unit.** Symbol, then outline, then range. Full-file reads
   are an explicit exception.
8. **One hard limit: the run envelope and 90% of the model's context.** No
   soft caps, no max-fact counts, no step budgets, no configurable prompt
   ceilings. If a run reaches either limit, the setup is wrong. Block it and
   split it into smaller runs.
9. **No silent truncation.** When the limit is hit, the run stops with a
   decomposition report. It never sends a shortened prompt and pretends the
   task is complete.
10. **Advisory semantic map.** Never edit from an annotation. Read the target
    range before a mutation.
11. **No new failure modes.** Missing LSP, no git, stale map, or failed semantic
    call all degrade to a working run.

## 5. Architecture

```text
git ls-files + working tree + policy excludes
  -> deterministic map (JSON + rendered text, cached by HEAD/dirty/version)
       -> semantic map (module summaries, one bounded LLM call per refresh)
            -> run state (facts + working set + last step)
                 -> prompt = render(system, state, working set, last step)
                      -> tools (map, outline, read symbol, search paths, edit, context)
                           -> ingest step: turn evidence into facts + cached artifacts
                                -> next prompt (rebuilt, not appended)
```

The invariant:

```text
prompt_tokens <= 0.90 * model.contextWindow     // the only hard limit
prompt_tokens != f(number_of_turns)             // no accumulation
```

If the first line fails, the run does not send. It blocks with
`context_exceeded` and a split report. A build or review run should never get
near a 1M-token model. An epic plan that does is a signal to create smaller
planning runs.

Storage:

```text
.machine_code/local/cache/
  map.json                # deterministic facts, no timestamps
  map/
    semantic.json         # annotations + provenance
    semantic.dirty        # paths edited since the last refresh
    changes.jsonl         # bounded change digest for semantic refreshes
    semantic.lock         # best-effort writer lock
.machine_code/local/runs/<run-id>/
  state.jsonl             # append-only facts, decisions, changes, opens
  state.md                # rendered snapshot for humans and resume
  artifacts/<id>          # content-addressed tool output, re-injected on demand
  split.md                # decomposition report when the 90% limit is hit
  transcript.json         # audit log only; never sent as prompt history
```

Why a cache, not a committed file: the map must reflect the working tree, and
it must never add diff noise or merge conflicts.

## 6. Deterministic repository map

### 6.1 Inputs

- Tracked files: `git -C <root> ls-files -z`.
- Working tree: `git status --porcelain -z` for dirty and untracked paths.
- Non-git fallback: `rg --files` with the same excludes.
- Excludes: `SEARCH_EXCLUDES` (`src/tools/safety.ts:12-26`), repo policy
  `[map].exclude`, and new secret patterns:
  `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`,
  `.npmrc`, `.netrc`, `.git-credentials`.
- Binary files are skipped by extension and by a NUL-byte probe.

### 6.2 Extraction

Per file:

- `path`, `lang`, `bytes`, `lines`, `mtime` (mtime used only for cache
  validation; not rendered).
- Top-level symbols with line numbers:
  - TypeScript/JavaScript: `function`, `class`, `interface`, `type`, `enum`,
    `const`, and exported variants.
  - Python: `def`, `async def`, `class`.
  - Rust: `fn`, `struct`, `enum`, `trait`, `impl`.
  - Go: `func`, `type`.
  - Shell: `name()`.
- Regex extraction is the deterministic baseline. It is stable across machines
  and does not require a language server.
- LSP enrichment is separate and on demand. `textDocument/documentSymbol`
  gives exact member ranges and symbol kinds. Results are cached per
  `sha256(file content)`. Enrichment never changes the deterministic file
  bytes.

### 6.3 Schema

```json
{
  "schema": 1,
  "mapVersion": 1,
  "root": "/home/wes/code/extropian/repos/machine-code",
  "head": "ef748e9",
  "dirty": ["src/config.ts"],
  "files": [
    {
      "path": "src/tui.ts",
      "lang": "ts",
      "bytes": 118473,
      "lines": 2622,
      "symbols": [
        { "name": "runTui", "kind": "function", "line": 549, "end": 2606 }
      ]
    }
  ]
}
```

No timestamps in this file. The cache key is
`sha256(mapVersion + "\0" + head + "\0" + sorted(dirty))`. A mismatch forces a
rebuild.

### 6.4 Render

Human and model readable, grouped by directory:

```text
src/ (42 files)
  tui.ts (2622) — runTui 549, draw 996, handleKey 2200, wrapText 242
  tools/index.ts (461) — readTool 59, searchTool 212, commandTool 344
test/ (27 files)
  ...
```

Rules:

- Sort directories and files. Sort symbols by line, then name.
- Cap at 32 KiB.
- When over cap, keep one line per file and at most 8 symbols per file. If still
  over, drop files in reverse path order and add a truncation note.
- The render is deterministic for the same input.

### 6.5 Cache

- Read `deterministic.json` when the key matches; otherwise rebuild.
- Write atomically: temp file + `rename`.
- Cold build target: <2 s for 500 files. Cached read target: <50 ms.
- `core:map --refresh` forces a rebuild.
- Never block a run on map failure. Log `map_built { ok: false, error }` and
  fall back to `rg --files`.

### 6.6 Public surface

- CLI: `machine_code map [--path <p>] [--depth N] [--symbols] [--semantic]
  [--json] [--refresh] [status]`.
- Core command: `core:map` with the same typed arguments.
- `search mode "map"` delegates to the same module.
- `search mode "outline"` requires `path` and returns one file's symbols.
- `read` with `symbol` or `around` uses LSP first, then the deterministic map.

### 6.7 Injection

Every run gets a tiny table of contents, never the full map:

```text
<repo-map>
root: /home/wes/code/extropian/repos/machine-code
head: ef748e9 · files: 412 · deterministic map: fresh
src/ (TS, 42): cli, loop, tools, context, tui, catalogue, state, lsp
test/ (JS, 27) · data/ · plans/ · knowledge/
Call core:map --path <dir> for a full slice. Call search outline <file> for symbols.
</repo-map>
```

Target ≤1 KiB. This block is stable for the whole run, which keeps prompt
caching useful.

## 7. Semantic map

### 7.1 Granularity

Module-level annotations, plus optional file notes for large or central files.
A "module" is a top-level directory or a `src/<dir>` pair. Per-file notes are
limited to files over 300 lines and known entry points.

This avoids a per-file LLM call on a 400-file repository.

### 7.2 Input

One bounded call per refresh:

- Rendered deterministic map for the target modules, clipped to 12 KiB.
- `README.md`, clipped to 2 KiB.
- Recent bounded change digest, clipped to 2 KiB: path, turn, agent, model,
  tool result, line/byte delta, and the changing assistant's one-line intent.
- For a dirty-only refresh: the current annotations for affected modules.
- No transcript, no raw tool bodies, no full diff.

### 7.3 Output

```json
{
  "schema": 1,
  "baseCommit": "ef748e9",
  "mapHash": "sha256:...",
  "generatedAt": "2026-11-02T18:00:00.000Z",
  "model": "provider/id",
  "modules": {
    "src/context": {
      "summary": "Assembles run context and previews sources for the TUI.",
      "keyFiles": ["assemble.ts", "preview.ts"],
      "editHints": ["Add new context kinds in types.ts first."]
    }
  },
  "files": {
    "src/tui.ts": {
      "summary": "Terminal UI: four pages, run detail, new-run composer.",
      "entryPoints": ["runTui"],
      "editHints": ["Composer input is handled by newRunInsert."]
    }
  }
}
```

Validation:

- Every `path` must exist in the deterministic map.
- Every symbol in an `entryPoint` must exist in that file's symbol list, or the
  note is dropped.
- Cap: 12 KiB total; 240 chars per summary; 3 hints per file.
- Sort keys. Store `generatedAt` in this file only.
- Reject or drop anything that does not validate. Never invent paths.

### 7.4 Refresh policy

This is the "simple way" to keep it current:

1. On run start, compare `semantic.baseCommit` with `HEAD` and `mapHash` with
   the deterministic map hash.
2. Read `semantic.dirty`. An edit/write appends its path there and one bounded
   entry to `changes.jsonl`. After any mutating tool, a git-status delta also
   catches deletes, renames, formatters, and command-side writes. The status
   snapshot stores codes and fingerprints only, never content.
3. If clean and current, reuse. No model call.
4. If dirty, refresh only the affected modules and files in one call. If more
   than 50% of modules are dirty, rebuild the whole semantic map.
5. On success, atomically write `semantic.json` and clear the handled dirty
   paths. On failure, keep the old map, keep `dirty`, and log the error.
6. After a turn that changed files, schedule a refresh. It runs after the turn,
   not inside the edit. At most one refresh is in flight; a changed turn while
   one runs queues a single follow-up. The refreshed index is used by later
   prompts in the same run.
7. `core:map --semantic --refresh` forces one synchronous refresh.

This gives at most one in-flight semantic call, only when something changed,
with no watcher and no per-edit cost.

### 7.5 Model and cost

- `[map].semantic_model` pins a model. Empty means "cheapest eligible model
  with enough context", selected through the existing catalogue.
- Record the call as `agent: "map"` in the spend ledger and as a
  `map_semantic` event with usage and cost. Spend groups it as
  `map (semantic)`.
- No automatic retry. Failure degrades to the deterministic map, keeps the
  dirty paths, and a later changed turn or run start can retry.
- No tool calls. One JSON response, bounded at 2,000 output tokens.

### 7.6 Use

- Inject only a module index, ≤1 KiB:
  `src/context — run context assembly and TUI preview`.
- Full annotations are available through `core:map --semantic [--path]`.
- Treat annotations as hints. Read the target range before editing.

## 8. Surgical tools

### 8.1 `read`

New parameters:

```ts
{
  path: string,
  offset?: number,
  limit?: number,
  symbol?: string,   // resolve a symbol's full range
  around?: number,   // expand to the enclosing symbol
  maxBytes?: number
}
```

Behavior:

- `symbol`: LSP `documentSymbol` first, deterministic map second. Return the
  complete range and a `path:start-end (symbol)` header.
- `around`: resolve the enclosing symbol for a line.
- Large-file guard: if no `offset`, `limit`, `symbol`, or `around` is given and
  the full file would exceed the existing 24 KiB read cap, return the outline
  and a one-line instruction. Do not return the body. This reuses the current
  cap; it is not a new threshold.
- Byte-accurate paging: emit lines until the byte cap. `nextOffset` is the line
  after the last delivered line. Never point past a line that was not
  delivered.
- Result header: `id=art_... path=src/tui.ts range=2216-2256 symbol=newRunInsert bytes=2014`.
- Error messages name the recovery call, e.g.
  `file is large; call read { path, symbol } or search { mode: "outline", path }`.

Every read body is stored as a run artifact and referenced by a fact. It is
not appended to a conversation history. If the range is still in the working
set, the renderer re-injects it from the artifact on the next step. If the
model needs it later, it calls `context recall` or reads the range again. If
the file changed, the hash differs and the old ref is stale.

### 8.2 `search`

- **Fix `files`.** Run `rg --files` without a user positive glob, then filter in
  process with a small glob matcher. Never pass `--glob '*'`. Reject `"*"` with
  a pointer to `map`. Always exclude secret patterns.
- **Add `outline`.** `path` required. LSP document symbols first, deterministic
  regex symbols second. Output `line kind name` sorted by line.
- **`map`.** Return a deterministic map slice, or the semantic annotations with
  `semantic: true`.
- **`symbols`.** Use the deterministic map first. It is fast and has no server
  dependency. LSP workspace symbols can enrich this later; a missing LSP never
  fails the mode.
- **`text`.** Add `paths?: string[]` for a specific file list. Trim long lines
  to 200 columns. Cap matches per file. Keep `limit` as the global cap.
- **Semantic modes.** Keep `definition`, `references`, and `info`. When LSP is
  missing, return a fallback suggestion (`outline` or `text`), not a dead end.
- Every result starts with a compact header: mode, match count, bytes, and
  whether it was truncated. The full match list is an artifact; the fact keeps
  the top 10 refs.

### 8.3 `edit`

- Keep the exact-match uniqueness rule.
- Return `path:start-end (symbol) — N replacement(s)`.
- Emit a `change` fact with `path`, `range`, `symbol`, `oldHash`, and `newHash`.
- Mark older refs to the same path stale.
- Reject excluded and secret paths.

### 8.4 `command`

- Add `core:map` (status, render, refresh).
- Add `core:outline` for a single file if `search outline` is not enough.
- Extend `core:status` with the header described in section 11.

### 8.5 `context`

Add the memory-control tool described in section 9.9. It is the explicit
counterpart to automatic ingestion:

- The runner always ingests tool results.
- The model uses `context note` for decisions that tool metadata cannot express.
- The model uses `context focus` to keep a range in the working set.
- The model uses `context recall` to re-inject an artifact without a file read.

This is one new core tool. It replaces a hidden summarizer and prevents the
"re-read to remember" loop. Register it for every role, including `general`
and `review`: it writes run state only, never the worktree, so it does not
weaken a read-only role.

## 9. Run state and context materialization

### 9.1 Why not pruning

Pruning is a deferred cost. Every token pruned was first sent in every request
between selection and eviction. The evidence run paid 666,560 cache-read tokens
because it carried a 78 KB file probe for 20 turns. A better policy never
admits the 78 KB in the first place.

The rule:

> The prompt is `render(run_state, last_step)`. The run state is facts. The
> last step is the only raw evidence. The prompt never contains the history of
> steps.

The last step is not history. It is the evidence for the action the model is
about to take. It is replaced at the next step, not appended to a history. This
is why the prompt size stays flat.

Therefore:

- Prompt size is a function of the state, not the number of turns.
- There is no soft cap, hard cap, elision pass, or summary-of-summary.
- A fact that is no longer needed is removed from state. That is state
  maintenance, not context pruning.

### 9.2 State model

```ts
interface RunState {
  version: 1;
  runId: string;
  envelopeTokens: number;       // max prompt tokens for this run
  goal: string;                 // <= 2 KiB, verbatim request
  phase: "orient" | "target" | "act" | "verify" | "done";
  nextAction?: string;          // <= 240 chars, replaces the previous value
  facts: Fact[];
  workingSet: Ref[];
  open: OpenQuestion[];
  counters: { turn: number; steps: number; artifacts: number };
}

interface Fact {
  id: string;                   // stable, deterministic
  kind: "finding" | "decision" | "change" | "open" | "resolved";
  text: string;                 // <= 240 chars
  refs: Ref[];
  turn: number;
  status: "active" | "stale";
  key: string;                  // dedupe key
}

interface Ref {
  path: string;
  range?: [number, number];
  symbol?: string;
  hash: string;                 // sha256 of the content at read time
  artifact?: string;            // artifact id
  bytes?: number;
}

interface OpenQuestion {
  id: string;
  text: string;
  turn: number;
  status: "open" | "answered";
}
```

Dedupe keys:

- Read ref: `read:<path>:<range>:<hash>`.
- Search: `search:<query>:<scope>`.
- Finding: `finding:<sha1(normalized text)>`.
- Decision: `decision:<sha1(normalized text)>`.
- Change: `change:<path>` (latest wins).
- Open: `open:<id>`.

On edit or write:

- Add a `change` fact for the path.
- Mark every fact whose `refs` include that path and an older hash as `stale`.
- Stale facts are not rendered. They stay in `state.jsonl` for audit.
- The change fact records `path`, `range`, `symbol`, `oldHash`, `newHash`.

Facts leave state for three reasons only: they are superseded by a newer fact
with the same key, they become stale because the file changed, or an open
question is answered. There is no maximum fact count. A large state is a
correctness signal, not a number to tune down.

### 9.3 Step lifecycle

A step is one assistant response plus the tool calls and results it produced.

For step N, the prompt is:

```text
[system role prompt]
<run-state>
  Goal: ...
  Phase: ...
  Next: ...
  Decisions: ...
  Findings: ...
  Working set: <refs + byte counts>
  Changes: ...
  Open: ...
</run-state>
[working-set content]        # only refs not already in the last step
<last-step>
  assistant text + tool calls
  tool results                # the only raw evidence
</last-step>
```

The original request is `state.goal`. It is always present.

After step N ends:

1. **Ingest.** The assistant text becomes a `finding`, clipped to 240 chars
   (or the model used `context note`). Tool metadata becomes refs, search
   facts, command facts, or change facts. Tool bodies go to the artifact cache.
2. **Focus.** The working set becomes the refs touched by this step, plus any
   refs the model explicitly focused. Auto-refs older than two steps drop out.
3. **Render.** The next prompt is rebuilt from state. The raw step is not
   appended to a history. It is gone unless it became a fact, a ref, or an
   artifact.

The model is told this explicitly:

> You will not see earlier tool output. It is in the facts and the working set.
> Record decisions with `context note`. If you need exact bytes again, use
> `context recall` or read the range again.

### 9.4 Tool result contract

Every tool result starts with a machine-readable header:

```text
id=art_000042 kind=read path=src/tui.ts range=2216-2256 symbol=newRunInsert hash=sha256:abc bytes=2014 focus=true
```

Then the body. The runner:

- Stores the body at `.machine_code/local/runs/<id>/artifacts/art_000042`.
- Records a ref fact with the path, range, symbol, hash, and artifact id.
- Renders the body only in the current step. Later renders show the ref and a
  one-line summary, not the body.
- Re-injects the body only when the ref is in the working set or the model
  calls `context recall`.

This is one read, one artifact, many references. The bytes are not duplicated in
the prompt history.

Tool-specific ingestion:

| Tool | Fact after the step | Artifact |
|---|---|---|
| `read` | ref `path:range (symbol) @ hash`, bytes | full body |
| `search` | query, scope, top 10 `path:line` refs | full match list |
| `outline` | file path, symbol count, first 20 symbols | full outline |
| `command` | name, exit, 5-line summary | full log |
| `edit` / `write` | change fact, path, range, old/new hash | 1-line result |
| `context note` | finding or decision | none |

### 9.5 The 90% rule and decomposition

The hard limit is the smaller of two values:

```text
runEnvelopeTokens                                  # the run's declared max
floor(0.90 * model.contextWindow) - maxOutputTokens # the model's usable max
```

There is no step budget, no max-fact count, no max-prompt constant, and no
soft cap. The run envelope is a property of the run, not a global tuning
knob. Section 9.6 explains where it comes from.

- Before every request, compute `promptTokens` from the rendered prompt, the
  system prompt, and the tool schemas. Use the actual token count when
  available; otherwise use the calibrated estimate.
- `limit = min(runEnvelopeTokens, floor(0.90 * model.contextWindow) - maxOutputTokens)`.
- If `promptTokens <= limit`, send.
- If `promptTokens > limit`, do not send. Emit `context_exceeded` and block the
  run with a split report.

The split report is deterministic and readable:

```text
context_exceeded: 91,240 / 100,000 tokens
run envelope: 100,000 · model limit: 128,000 · model: openrouter/...
largest contributors:
  working set  src/tui.ts:1-900 (24 KB), src/loop.ts:1-779 (18 KB)
  last step     read src/tui.ts:1-900 (24 KB)
  facts         24 findings, 6 changes, 2 opens
suggested split:
  run A: src/tui.ts composer (new-run input range)
  run B: src/loop.ts transcript state
  run C: tests
```

Role response:

- **Build / Review:** the run stops `blocked`. The Orchestrator marks the task
  `needs_planning`. The Planner splits it into features and tasks. Each becomes
  a separate run.
- **Planner:** stops and creates smaller planning runs per feature or task. An
  epic plan does not continue in one context.
- **Sudo:** stops and asks the human for a narrower scope. Sudo never splits
  silently.
- **General:** stops and asks a narrower question.

Build and Review use the packet envelope. They are expected to stay far below
the model's 90% window. A build or review run that grows large is an eval
failure and a split signal, even when it is still under the envelope.

Planning follows the issue hierarchy. An epic planning run loads the epic and
creates feature planning runs. A feature run loads the feature and its parent
summary and creates task runs. No planning run loads the whole tree. This is
the intended use of `context:inherit`: each level passes a summary, not a
transcript.

Tool behavior at the limit:

- Tools keep their existing output caps (read 24 KiB, search 12 KiB, command
  8 KiB). These are usability caps, not context budgets.
- Before a tool returns a body, it compares the current prompt size plus the
  expected result with the `limit` above. If the result would cross it, the
  tool returns a short `context_exceeded` result and names a smaller unit (a
  symbol, a range, a lower search limit). This is the same single limit, not a
  second budget.
- No tool truncates a body the model asked for and then hides the truncation.
  It either returns a complete smaller unit or refuses.

Implementation: `ToolContext` gains `contextLimit` and `artifacts`. The check
uses `min(runEnvelopeTokens, 0.90 * model.contextWindow - maxOutputTokens)`.
There is no per-step reservation math and no remaining-budget counter. If a
tool can return a complete result within the limit, it does. If not, it returns
the refusal.

At request time, `prepareRequest` checks the rendered prompt against the same
limit. If it fails, it throws a non-retryable `ContextLimitError`. `runLoop`
catches it, sets the run to `blocked`, writes the `context_exceeded` event and
`split.md`, and does not call the provider. The existing retry rotation must
not treat this as a model failure.

Why this is better:

- No arbitrary numbers to tune.
- A run that cannot fit is a task-shape problem, not a context-management
  problem.
- The decomposition report gives the next run a precise starting point.

### 9.6 Model switching and the run context envelope

A run must switch models when a provider rate-limits. It must not change its
context contract when it does.

Every run carries a **run context envelope**: the maximum prompt tokens that
run may use. It is a property of the run invocation, set when the run is
created. It is not a property of a GitHub issue, an Epic, a Feature, a Task, or
a packet. It is not a global cap and not a per-call heuristic.

The envelope belongs to the run:

- A GitHub issue or packet can **propose** an envelope with `context_tokens`.
  The run resolves it, records it in `run.json`, and uses that recorded value.
- One issue or task can have several runs: build, review, retry, and split
  children. Each run has its own envelope. A Review run gets its own envelope
  for the diff; it does not inherit the Build run's envelope.
- Resume keeps the envelope recorded at run creation. Do not recompute it from
  the current model or the current issue state.
- A manual change is explicit and logs `envelope_override`. It is not
  automatic.

Where it comes from:

- **Build / Review:** the packet compiler proposes it from the packet's
  `context` paths, using the deterministic map to resolve symbols and ranges.
  Review adds the diff. The Planner may override it with `context_tokens`. The
  run records the resolved value.
- **Planner:** the node scope proposes it. Epic planning can use a large
  envelope, up to the model limit. Feature planning is smaller. Task planning
  is smaller still. Each child run records its own envelope.
- **Sudo / General:** optional `--context-tokens`. If absent, the envelope is
  the initial selected model's usable 90% window. The run records it and is
  explicit and human-owned.

Definition:

- `runEnvelopeTokens` is the maximum **prompt** tokens, including system, state,
  working set, last step, and tool schemas. Output is separate.
- The model pool is every model with
  `runEnvelopeTokens + maxOutputTokens <= 0.90 * model.contextWindow`.
- The run limit is
  `min(runEnvelopeTokens, floor(0.90 * model.contextWindow) - maxOutputTokens)`.
  If the prompt exceeds it, block and split.

Switching:

- Select the best-scored model in the pool at run start.
- On a retryable failure (rate limit, outage, malformed), remove that model and
  select the next best in the pool. The envelope does not change. The switch
  may change cost; record the new model and its pricing. Do not hide it.
- Never switch outside the pool. A 32K model cannot take over a 128K build.
  A 1M planning model cannot rescue a too-big build.
- If the pool is empty, block with `no_model_for_envelope` and a report: lower
  the run envelope, choose a larger context class, or split.
- If all pool models are cooling, pause or block. Do not leave the pool.

No marginal switching:

- Do not switch for a small score difference while the current model is
  healthy. The evidence run switched for 0.0011 and lost 18,345 fresh tokens
  with 0 cache read. The pool exists for rate limits, not score chasing.
- A human may switch explicitly; the target must be in the pool. Log `manual`.

Envelope examples:

- A build task touching two functions and their tests: the packet compiler sums
  the named ranges and adds the system/state/tool overhead. The result might be
  32K or 64K; it comes from the footprint, not a global default.
- A review of that diff: the same, plus the diff and acceptance commands.
- Epic planning: up to 1M if the model pool allows. Feature planning: smaller.
  Task planning: smaller still.
- The numbers are task properties. The Planner records the envelope in the
  packet or issue metadata, so it is visible and reviewable. The eval can tune
  the derivation, not a hidden global.

Token estimate:

- Use actual `usage.input + usage.cacheRead` after each call to calibrate
  `charsPerToken` for the current model.
- On a model switch, reset the ratio to the conservative default for the new
  model and recalibrate from its first call. Do not reuse the old model's ratio;
  tokenizers differ.
- Before the first call, use a conservative default of 3.0 chars/token for
  code. The evidence run was ~3.06 chars/token; `chars/4` undercounts code.
- Use the calibrated estimate for both the envelope check and the 90% check.
- `maxOutputTokens` is the actual `maxTokens` the loop will request
  (`MAX_REQUESTED_OUTPUT_TOKENS`, the configured ceiling, or the model max),
  not the optimistic 2k `expectedOutputTokens`.

Implementation:

- `src/select.ts`: `PickInput` gains `runEnvelopeTokens`, `charsPerToken`,
  `maxOutputTokens`, and `excludedModelKeys`. `pick` filters on the envelope and
  returns a ranked pool. The reject reason is `insufficient-context-envelope`.
  A row with unknown context (`0`) is ineligible.
- Inside the pool, score headroom against the envelope, not the raw window.
  A model that barely fits and a 1M model both pass. Do not reward unused
  window; let cost and capability decide.
- `src/loop.ts`: read the envelope; build the pool at run start; select the
  best. On retry, exclude the failed model and select the next in the pool.
  Never re-pick on context growth. Pass the current rendered prompt size, not
  the original request size.
- `src/packet.ts` and issue metadata: add `context_tokens` (optional). The
  packet compiler computes a default from the `context` paths and the map's
  symbol ranges.
- `src/state/run-schema.ts`: record `contextEnvelopeTokens`, `modelPoolSize`,
  and `modelSwitches`.
- TUI: the Overview `model` line shows the model and `ctx/envelope` only when
  context is within 20% of the envelope. The concise header stays
  `36.1K ctx   735K total`.
- Events: `model_pool { size, envelope, models }` and
  `model_switch { from, to, reason, envelope }`.

Why this is better:

- Rate limits are handled without breaking the task's context contract.
- Build and Review stay in their class; planning can be large; child runs are
  smaller.
- A switch cannot hide a too-big task.

### 9.7 Rendering and caching

- `state.md` is the human view (run detail, `machine_code show`).
- `renderPrompt(state, lastStep)` is the model view. It is deterministic.
- Section order is stable: system, run-state, working-set, last-step.
- Omit empty sections. Use one blank line between sections.
- The system prompt is the stable prefix. The run-state block changes only for
  the current step. The last step changes every step. Prompt caching helps on
  the system prompt only; that is acceptable because the prompt is small.
- The model can call `context state` to see the exact render it will receive.
  This is a self-check, not a required call.

### 9.8 Resume and inheritance

- Resume loads `state.jsonl`, `state.md`, and `artifacts/`. It does not replay
  the transcript into the prompt.
- If the state is missing (old run), rebuild it from the transcript with the
  deterministic ingester as a one-time migration.
- If the transcript tail has an unanswered tool call, repair it as today, then
  ingest it as the last step.
- Child runs with `context:inherit` receive the parent's `state.md` (≤2 KiB),
  not the parent transcript.
- The committed `knowledge/` directory stays the curated cross-run knowledge
  base. Run state is ephemeral and local.

### 9.9 The `context` tool

Add one tool that gives the model explicit control of its memory:

```ts
{
  action: "note" | "focus" | "recall" | "forget" | "state",
  kind?: "finding" | "decision" | "open" | "next",
  text?: string,
  refs?: string[],       // path, path:line, path:start-end, symbol
  id?: string            // recall/forget
}
```

- `note`: add a finding, decision, or open question. `kind: "next"` replaces
  `state.nextAction`. One call per phase or decision, not per tool result.
- `focus`: replace the working set with the given refs. Use when switching
  files or keeping a range for an edit.
- `recall`: re-inject an artifact body by id. If the re-injection would cross
  the 90% limit, return a `context_exceeded` result with a smaller suggestion.
- `forget`: mark a fact resolved or stale.
- `state`: return the current `state.md` render.

The tool is small and deterministic. It replaces the need for a hidden
summarizer and gives the model a way to say "this is what matters" in one call.

The prompt uses it sparingly:

- Record a decision once, in one sentence.
- Focus the exact range before an edit.
- Do not narrate tool output.

### 9.10 Why this is simpler

- One state schema, one renderer, one artifact store.
- No prune thresholds, no hysteresis, no summary-of-summary.
- Prompt size is bounded by the run envelope and 90% of the model context,
  independent of run length. A run that crosses either stops and splits.
- The audit transcript can grow on disk without affecting the model.
- The model sees the smallest context that can support the next action.

## 10. Prompt revamp: condense and specialize

### 10.1 Audit

Current role prompts (`data/agents/*.toml`):

| Role | Chars | Words |
|---|---:|---:|
| architect | 1,162 | 165 |
| build | 922 | 145 |
| general | 516 | 91 |
| review | 533 | 83 |
| sudo | 516 | 79 |
| **total** | **3,649** | **563** |

Problems:

- Every role repeats identity, permissions, verification, and output rules.
- Several rules restate tool-schema behavior: path bounds, binary rejection,
  exact-match edits, no shell.
- Long prose and JSON examples add tokens to every request.
- Stale text: Sudo says "six tools"; the tool set is capability-based.
- No shared instruction for the map, run state, or `context` tool.
- Rules drift between roles because each file is edited alone.

Targets. These are maintainability targets, enforced by a test, not runtime
context caps:

- Shared base: ≤1,500 chars.
- Each role delta: ≤300 chars.
- Base + all five role deltas: ≤2,400 chars.
- Each rendered role prompt: ≤1,800 chars.
- No rule duplicated between the base and a role.
- No hardcoded turn or call counts.

Landed values:

| Measure | Value |
|---|---:|
| Base | 1,447 chars |
| Architect delta | 214 chars |
| Build delta | 221 chars |
| Review delta | 189 chars |
| General delta | 138 chars |
| Sudo delta | 140 chars |
| Base + all deltas | 2,349 chars |
| Rendered prompts | 1,713–1,794 chars |

### 10.2 Structure

- `data/prompts/base.md`: shared identity placeholder, context/memory, work
  loop, tool discipline, output format.
- `data/agents/<role>.toml`: role delta only: objective, permissions,
  workflow, stop condition, safety.
- `src/agents.ts` prepends the base to every role. A repo or machine override
  replaces the role delta only. `base_prompt = false` is a machine-only debug
  opt-out.

### 10.3 Condensed base prompt

```text
You are the <role> agent of machine_code.

## Context
- The run-state block is your memory: goal, next, decisions, findings, working set, changes, open.
- You will not see earlier tool output. The next request has the run state and the last step only.
- The repository map is generated. Do not list every file.

## Work loop
1. Orient with core:map or search { mode: "map" }.
2. Target with search { mode: "outline" } or read { symbol }.
3. Act with edit or write when your role permits. One logical change per call.
4. Verify with core:check and the one gate that proves the change.
5. Stop when the request is met.

## Memory
- Record a decision with context note.
- Set the next action with context note kind "next".
- Keep needed ranges with context focus.
- Use context recall only for missing bytes.
- State conclusions, not tool output.

## Tools
- Read the smallest unit: symbol, then outline, then range.
- Do not read a whole large file.
- Do not reread unchanged ranges.
- Keep the read that justifies an edit in the last step.
- If a result exceeds the context limit, ask for a smaller unit or stop and report a split.
- Ask one precise question only when a wrong change is likely.

## Output
Use ASD-STE100. Short sentences. Active voice. One idea per sentence.
Keep paths, code, and commands exact.
Format:
Result: ...
Changes: <path:symbol> ...
Evidence: <command and outcome>
Next: <only when blocked or a human decision is needed>
```

### 10.4 Role deltas

| Role | Delta |
|---|---|
| Architect | Architect agent. Plan one self-contained packet. Map first. Name exact `path:symbol` ranges and acceptance commands. Do not edit code. Stop when the packet is complete. For reference work, load the reference skill. |
| Build | Build agent. Implement one packet. Read only its named ranges. Edit. In verified/redundant, add focused tests; in direct, rely on existing tests. Run each acceptance command once. Do not re-plan. Stop when the gates pass. |
| Review | Review agent. Judge one build against its packet and diff. Read-only. Check each acceptance criterion. Judge the packet and diff, not the gates alone. Cite `path:line`. Stop with a verdict. |
| General | General agent. Answer from the repository. Read-only. Use map and outline. Read a mentioned file before you answer. Cite every path. Stop. |
| Sudo | Sudo agent. Do the explicit task with all allowed tools. Map first. Commands are typed manifests: no shell, no host-root. Verify once. Stop. |

### 10.5 Condensation rules

- Delete rules the runtime or tool schema already enforces.
- Delete duplicates. A rule lives in the base or in one role, never both.
- One instruction per bullet. Use 20 words or fewer.
- No JSON examples. The tool schema is the reference.
- No tool counts or stale names.
- No hardcoded turn or call counts. The task decides.
- Add a rule only when an eval failure justifies it.

### 10.6 ASD-STE100 output

- Procedure sentence: ≤20 words. Descriptive sentence: ≤25 words.
- Active voice. Imperative for instructions.
- One instruction per sentence.
- Common words. One term for one concept.
- State the result first.
- Keep code, paths, and commands exact.
- Avoid idioms, Latin abbreviations, and semicolons that join instructions.

### 10.7 Prompt tests and inspection

- `machine_code prompts [--agent <role>] [--json]` prints the rendered prompt,
  its chars, and its words. This is the audit surface.
- `test/prompts.test.js` checks:
  - the base exists and every role has a stop condition;
  - each role delta is ≤300 chars; base + all deltas ≤2,400 chars; each
    rendered role prompt ≤1,800 chars;
  - required strings: `run-state`, `core:map`, `context note`, `ASD-STE100`,
    `Result:`, `Evidence:`;
  - no `six tools`, no hardcoded turn/call counts, no duplicate rule;
  - every role has the output format.
- Add `promptChars` to `context_state` so the prompt's share of context is
  visible in the TUI and `machine_code show`.
- The eval records prompt chars, turns, and calls. Condensing must not increase
  turns or calls.

## 11. Status indicators

### 11.1 `core:status` header

Keep the existing git status first, so current callers that read the first line
do not break. Append a blank line and a compact block:

```text
map     deterministic: fresh · HEAD ef748e9 · 412 files · 31 KiB
        semantic: fresh · 12 modules · 3.2 KiB · 2h old
lsp     typescript: ready · python: unavailable (pyright-langserver not found)
tools   rg 14.1 · ast-grep 0.40 · git 2.45 · jq 1.7
context 7 facts · 1.8 KiB · 36.1K ctx / 128K envelope · 735K total · peak 40.2K
```

`core:status` accepts `section: "git" | "map" | "lsp" | "context" | "all"`.
Default is `all` with git first. `core:map status` prints only the map block.

### 11.2 TUI

- Run detail header, one line, concise:
  ```text
  36.1K ctx   735K total
  ```
- Run detail, Overview: keep the existing map/LSP lines. The `model` line shows
  the current model. Add `ctx/envelope` only when context is within 20% of the
  envelope. If a retry switched the model, show a small `switched` marker there,
  not in the header. Do not repeat the context numbers in the header.
- Run detail, Timeline: render `context_state` events as a small context
  sparkline. This makes a spike visible without opening raw events.
- Runs list: `735K total` only. The detail view shows context.
- Settings: a `Repository map` section with deterministic status, semantic
  on/off, refresh action, and semantic model.
- Do not spawn an LSP on the draw path. `lspStatuses()` reads cached state only.

### 11.3 Total tokens vs current context

The run summary must carry both values. They measure different things:

- **Total tokens** is the cumulative provider usage across all calls
  (`input + output + cacheRead`). It is the billing/quota number.
- **Current context** is the prompt size for the most recent request. It is the
  number that tells you whether the run is accumulating context.
- **Peak context** is the maximum current context over the run. It exposes a
  spike even if the final request is small.

Add to `RunUsage`:

```ts
interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  // New:
  contextChars: number;        // live prompt size, estimated or actual
  contextTokens: number;       // input + cacheRead for the last request
  peakContextChars: number;
  peakContextTokens: number;
  stepChars: number;           // raw tool output admitted in the last step
  stateChars: number;          // rendered facts + working set
}
```

Sources:

- Before a request, `renderPrompt` knows the exact chars. Add the system
  prompt and the tool-schema estimate (`tools.length * 1_500`) to get the full
  prompt size. Record `contextChars` and a `chars/4` estimate.
- After a request, `usage.input + usage.cacheRead` is the actual prompt token
  count. Record it as `contextTokens` and update the peak.
- `stepChars` is the sum of the admitted tool bodies for the step.
- `stateChars` is the rendered run-state block.

Display rules:

- Run detail header, one line, concise:
  ```text
  36.1K ctx   735K total
  ```
- Runs list: `735K total` only. The detail view shows context.
- Use actual provider prompt tokens (`input + cacheRead`) when present; use
  `chars/4` only as a fallback. The examples above are labels, not fixed values.
- `machine_code show`: `ctx: 36.1K`, `envelope: 128K`, `model limit: 900K`,
  `total: 735K`, `peak: 40.2K` on separate lines.
- Never label `totalTokens` as "context". It is cumulative usage.
- The context value is `contextTokens`; the limit is
  `min(runEnvelopeTokens, 0.90 * model.contextWindow - maxOutputTokens)`. Show
  the limit only when context is within 20% of it.

Schema:

- Add the usage fields to `run-schema.ts` as optional. Existing runs read as 0
  or undefined.
- Add `model`, `contextEnvelopeTokens`, `contextLimitTokens`, `modelPoolSize`,
  and `modelSwitches` to the run summary. Existing runs read as undefined.
- Bump `SCHEMA_VERSION` only if a migration is needed.
- `RunRecorder.recordCall` writes the existing usage; add
  `RunRecorder.recordContext` for the per-request values.
- `model_call_end` gains `context: { chars, tokens, stepChars, stateChars }`.
- `model_request` already has `chars`; keep it and add the estimate.

### 11.4 Events

Record in `events.jsonl`:

- `map_built { files, symbols, bytes, cached, head, ok }`
- `map_stale { paths }`
- `map_refresh_scheduled { turn }`
- `map_refresh { turn, ok, modules, error }`
- `map_semantic { model, modules, refreshed, bytes, cost, durationMs, ok }`
- `lsp_status { language, state, binary, version }`
- `context_state { turn, chars, tokens, promptChars, stateChars, stepChars, limit }`
- `context_ingested { turn, facts, refs, artifacts, staleFacts }`
- `context_recall { id, bytes }`
- `context_exceeded { tokens, envelope, modelLimit, model, contributors, suggestion }`
- `model_pool { size, envelope, models }`
- `model_switch { from, to, reason, promptTokens, envelope }`
- `state_note { turn, kind, bytes }`

`machine_code show`, the TUI detail view, and future evals read these without
parsing tool output.

## 12. Configuration

Machine `config.toml`:

```toml
[map]
enabled = true
deterministic = true
semantic = true
max_map_bytes = 32768
max_semantic_bytes = 16384
semantic_model = ""          # empty = cheapest eligible model
semantic_max_input_bytes = 12288
refresh = "on-change"        # on-change | manual | always
```

There is no `[state]` section and no context caps. The 90% model limit is a
constant in code, not a tunable. Tool output caps stay as they are today
(read 24 KiB, search 12 KiB, command 8 KiB); they are ergonomics, not context
budgets.

The map has no file-count cap. `deterministic.json` may be large; the rendered
view and every model-facing slice are bounded, and the model pages through it.

Repo `policy.toml` may add `[map] exclude = [...]` and `semantic = false` for
privacy. It may not set a model or a price. Unknown keys stay ignored.

## 13. Code plan

New modules:

- `src/map/deterministic.ts` — inventory, symbol extraction, cache, render.
- `src/map/semantic.ts` — input build, LLM call, validation, merge, dirty set.
- `src/map/status.ts` — freshness, sizes, LSP/tool status.
- `src/map/symbols.ts` — regex extractor and LSP enrichment.
- `src/context/state.ts` — `RunState`, facts, refs, dedupe, stale marking,
  turn ingestion, and `state.md`.
- `src/context/artifacts.ts` — content-addressed tool output and recall.
- `src/context/render.ts` — prompt view from state + the last step.
- `src/tools/context.ts` — `note`, `focus`, `recall`, `forget`, `state`.
- `src/commands/map.ts` — `core:map` and `core:outline` handlers.
- `data/prompts/base.md` — shared prompt.

Modified:

- `src/tools/index.ts` — read symbol/around/large-file guard, byte paging,
  search outline/map/paths, files fix, artifact headers; add `context` to
  `CoreToolName` and `coreTools`.
- `src/tools/safety.ts` — secret excludes, byte-aware paging helper.
- `src/lsp/client.ts` — `documentSymbol`; `src/lsp/index.ts` — status cache.
- `src/select.ts` — envelope eligibility, headroom against the envelope, model
  pool, calibrated `charsPerToken`, `insufficient-context-envelope`.
- `src/loop.ts` — build the model pool from the run envelope; select the
  best; retry within the pool only; `transformContext` renders state + last step; ingest at turn
  end; `ContextLimitError`; `model_switch` and context events; remove the prune
  path.
- `src/state/transcript.ts` — audit log only; keep resume repair and the
  one-time state migration. `pruneTranscript` leaves the prompt path.
- `src/packet.ts` — optional `context_tokens`; compile a default from the
  `context` paths and the deterministic map's symbol ranges.
- `src/state/run-schema.ts` — `contextChars`, `contextTokens`,
  `peakContextChars`, `peakContextTokens`, `stepChars`, `stateChars`, `model`,
  `contextEnvelopeTokens`, `contextLimitTokens`, `modelPoolSize`,
  `modelSwitches`.
- `src/state/runs.ts` — `recordContext` and `recordModel`.
- `src/agents.ts` — prepend the base prompt.
- `src/config.ts` — map config.
- `src/cli.ts` — build map at run start, `map` and `prompts` commands, status,
  show context, `--context-tokens` for Sudo/General.
- `src/orchestrate.ts` — propose a run envelope and parent state to child
  runs; each child records its own envelope.
- `src/tools/task.ts` — pass the parent `state.md` and a proposed child
  envelope; the child records its own.
- `src/tui.ts`, `src/tui/status.ts`, `src/tui/settings.ts` — indicators and
  total-vs-context display.
- `data/agents/*.toml` — role prompts and `context` in every `tools` list.
- `README.md`, `plans/plan.md` — document the new behavior.

## 14. Phases and acceptance

### Phase 0 — Safety, correctness, and token visibility (complete)

- Fix `read` byte-accurate paging and the skipped-line continuation.
- Fix `search files` ignore bypass and secret exposure.
- Reject `*`; add `paths` to `text`.
- Add `contextChars`, `contextTokens`, and peak fields from the existing
  `model_request`/`model_call_end` events.
- Show **total tokens and current context** in run detail and
  `machine_code show`. This is independent of the state redesign and lands
  first so the effect is measurable.
- Add tests.

Acceptance: no `.env` or `node_modules` in any file listing; a default read of
`src/tui.ts` reports the correct next offset; a synthetic 3,000-line file with
long lines has zero skipped lines across pages; run detail and `show` print both
total and current context.

### Phase 1 — Deterministic map and surgical reads (complete)

- Map module, cache, render, `core:map`, `search outline`, `search map`,
  `read symbol/around`, large-file guard, LSP status.
- Inject the ≤1 KiB TOC.
- Fix `search symbols` fallback.

Acceptance: map bytes are identical across two runs at the same HEAD; a cached
build is under 50 ms; `read { path: "src/tui.ts", symbol: "runTui" }` returns
the exact range; the evidence task needs no more than 5 `src/tui.ts` reads.

### Phase 2 — Run state and context materialization (complete)

- State model, artifact store, ingester, renderer, `context` tool, events.
- `transformContext` renders state + last step. No pruning path.
- Resume from state; one-time migration from old transcripts.
- Extend the Phase 0 token display with `stateChars` and `stepChars`.

Acceptance: every rendered prompt is under the run envelope and 90% of the
selected model's context.
A synthetic run that would exceed it blocks with `context_exceeded` and a split
report; it never sends a shortened prompt. A 25-turn replay has no raw tool body
older than the last step in any prompt. No `context_pruned` event exists. The
facts and changes survive; every assistant tool-call/result pair stays valid;
resume works from state alone.

### Phase 3 — Semantic map (complete)

- Generation, validation, incremental refresh, dirty marker, lock, status.
- One coalesced refresh at run start and after changed turns; at most one in
  flight plus one queued follow-up.
- Bounded change digest carries the changing model's intent without its
  transcript.

Acceptance: unknown paths are rejected; a clean run makes zero semantic calls;
a dirty run refreshes only affected modules; a changed turn refreshes without
blocking on every edit; a failed call leaves the deterministic map usable.

### Phase 4 — Prompts, STE100, and eval (prompts complete; replay pending)

- Add the shared base prompt and condense every role to a short delta.
- Add `machine_code prompts` and the prompt lint tests.
- Replay the evidence run and record the metrics.

Acceptance for the prompts: base + all role deltas ≤2,400 chars; each rendered
role prompt ≤1,800 chars; no rule duplicated between base and role; every role
has a stop condition; no hardcoded turn or call counts.

Acceptance for the replay: the task produces an edit; ≤12 turns; ≤10 model
calls; ≤250,000 total reported tokens (≤35% of baseline); gates pass; the model
switches only on retry within the envelope pool; a context-growth block never
switches; the final answer follows the Result/Changes/Evidence format and the
STE checklist.

### Phase 5 — Polish (complete; optional artifact compression/read memory declined)

- Artifact compression and unchanged-range stubs.
- Tune the split report and the Planner's decomposition behavior from eval data.
- TUI badges, settings section, docs.
- Remove dead code (`pruneTranscript` from the live path) and update
  `plans/plan.md`.

## 15. Tests and eval

Unit tests:

- Map determinism, cache key, dirty invalidation, render cap.
- Symbol extraction for TS, JS, Python, Rust, Go, shell.
- Semantic schema validation, unknown-path rejection, size caps, merge.
- State: fact dedupe, stale marking on edit, bounded state, deterministic ids,
  `nextAction` replacement.
- Ingest: assistant text, read/search/command/edit metadata, artifacts.
- Render: exact section order, only one raw step, honest byte accounting,
  deterministic output, no old tool body leak.
- 90% rule: a request over the limit does not send; it emits `context_exceeded`
  with contributors and a split suggestion. A tool that would cross the limit
  returns a complete smaller unit or a refusal. No truncation.
- Model selection: envelope eligibility; ranked pool; retry switches inside the
  pool; no switch outside the pool; context growth blocks instead of switching;
  `--model` pin blocks instead of switching; `charsPerToken` calibration;
  planned output uses the requested `maxTokens`, not `expectedOutputTokens`.
- Loop: a context-growth block has no `model_switch`; a retry switch logs
  `reason: "retry"` and stays in the pool; `modelSwitches` counts only
  retry/manual switches.
- Artifacts: content-addressed store, recall, hash mismatch -> stale ref.
- Read: byte paging, next offset, symbol resolution, large-file guard.
- Search: files ignore rules, secret exclusion, `paths` filter, outline
  fallback.
- Total-vs-context: `run.json` fields, schema migration, TUI/CLI formatting.
- Status output and events.
- Prompt lint: base exists; every role has a stop condition; each role delta
  ≤300 chars; base + all deltas ≤2,400 chars; each rendered role prompt
  ≤1,800 chars; required strings; no `six tools`, no hardcoded turn/call
  counts, no duplicated rule; output format present.
- `machine_code prompts` prints the rendered prompt and sizes for every role.

Integration tests:

- A synthetic 30-turn transcript with large tool results. Assert that the
  rendered prompt at turn 30 is no more than 1.5× the turn-10 prompt, is under
  the run envelope, and contains no tool body from turns 1-28.
- Resume from state; resume from an old transcript via one-time migration.
- Child run inheritance.
- Map build with no git and with LSP missing.
- A tool-call/result pair remains valid after ingestion; no orphan calls.

Eval replay:

- Fixture: the `20261102-173114-etdx` request and repository state.
- Record: turns, calls, tool calls, peak context, total tokens, cost, edits,
  gate result, wall time.
- Compare against the baseline table in section 1.

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The model loses nuance between steps | Facts carry decisions; `state.nextAction` carries the thread; `context note` is explicit; `context recall` restores exact bytes. If this is not enough, the task is too broad; split it. |
| A one-step window causes re-reads | Working set keeps active ranges; auto-focus the last read; measure repeated reads in the eval. |
| State grows over a long run | Facts are keyed and deduped; edits mark old refs stale; resolved opens leave state. There is no cap. If state alone approaches the run envelope or the model's 90% window, the task is too broad; split it. |
| Prompt caching is limited | The system prompt is the stable prefix. The prompt is small, so the cache loss is bounded. |
| A tool returns a body that crosses the limit | The tool checks the same envelope/model limit before returning. It returns a complete smaller unit or a refusal; never a hidden truncation. Contract test. |
| Context crosses the limit | The run blocks with `context_exceeded` and a split report. Build/Review -> `needs_planning`; Planner -> smaller planning runs; Sudo/General -> ask the human. No truncation. |
| Model switch mid-run loses cache and changes behavior | Run envelope + model pool. Switch only on a retryable failure, inside the pool. No marginal or context-growth switch. Log every switch. |
| No model fits the run envelope | The pool is empty. Block with `no_model_for_envelope` and a report; lower the envelope, choose a larger context class, or split. |
| Every pool model is rate-limited | Pause or block. Do not leave the pool and do not shrink the context contract. |
| Tokenizers differ across models | Calibrate `charsPerToken` from actual usage; start conservative at 3.0 for code. |
| Semantic map is wrong or stale | Advisory only. Validate paths and symbols. Read before edit. Show freshness. |
| LSP is slow or crashes | Lazy start, timeout, per-file cache, regex fallback, status indicator. |
| Map build adds latency | Cache by HEAD/dirty, 50 ms warm target, never block the run on failure. |
| Determinism differs by machine | Deterministic map uses regex only. LSP enrichment is tagged and cached separately. |
| Secret leak through map/search | Git-only inventory, secret patterns, `.env` never listed, tests assert it. |
| Concurrent map writes | Atomic rename plus a best-effort lock. Skip on lock contention. |
| Scope creep | Phase gates. Each phase ships value alone. No phase requires a daemon. |

## 17. Decisions and defaults

| Decision | Default | Reason |
|---|---|---|
| Index type | Deterministic structural map + LLM annotations | Cheap, local, no vector DB |
| Map location | `.machine_code/local/cache/map/` | Generated state, no git noise |
| Semantic granularity | Module-level with file hints | One call per repo, not per file |
| Semantic refresh | Run start + coalesced after a changed turn | Current semantics without per-edit calls |
| Map injection | TOC only, ≤1 KiB | Full map is on demand |
| Context model | `render(state, last_step)`; no history | Small by construction, no pruning |
| Raw steps | Always 1: the current step | No variable to tune; more means split or recall |
| State ingestion | Deterministic from assistant text + tool metadata | No extra model call |
| Change detection | Edit/write intent + git-status delta | Precise intent, complete coverage |
| Raw evidence | One step only; older evidence is facts + artifacts | No accumulation |
| Continuity | `state.nextAction` plus facts | The thread survives the dropped step |
| Artifact storage | Content-addressed per run | Recall without re-reading |
| Model selection | Run envelope + model pool; retry switch inside the pool | Handles rate limits without changing the run's context contract |
| Context growth | Block + split; never leave the pool | A bigger window would hide a too-big task |
| `--model` pin | No switch; block if it does not fit the envelope | The pin is a promise |
| Token estimate | Calibrated `charsPerToken`, default 3.0 for code | `chars/4` undercounts code |
| Hard context limit | Run envelope, then 90% of the selected model | Each run and each model differs |
| Over the limit | Block + split report | The task is too big, not the context |
| Arbitrary caps | None: no max facts, step budget, or prompt ceiling | Caps hide a task-shape problem |
| Read guard | A full read over the existing 24 KiB cap returns an outline | Surgical reads; no new threshold |
| Prompt structure | Shared base + short role delta | Remove duplication; one place per rule |
| Prompt size | Base + deltas ≤2,400; each rendered prompt ≤1,800 | Prompt is context; keep it small |
| Prompt rules | Add only when an eval failure justifies it | Stable, concise, no rule sprawl |
| Turn and call counts | Never hardcoded | The task decides |
| Prompt base | Always prepended; machine-only opt-out | Consistent behavior |
| Output style | ASD-STE100 + Result/Changes/Evidence | Clear, short, testable |
| New tool | `context` (note/focus/recall/forget/state) | Explicit memory control; replaces hidden summarizer |
| Pruning | Not used | Pruning hides a selection error |
| TUI tokens | `36.1K ctx   735K total` | Concise; both measures matter |

## 18. Open questions

1. Who owns a split: the Orchestrator or the Planner? Default: Build/Review
   report `needs_planning`; the Planner creates the smaller feature/task runs.
2. Should the working set auto-drop refs after two steps, or keep them until
   the model calls `context focus`? Default: auto-drop after two steps, with
   explicit focus as an override. This is behavior, not a size cap.
3. How should the split report choose boundaries? Default: by module, then by
   symbol cluster, then by test surface. It suggests, it does not cut.
4. Should artifacts be compressed on disk after ingestion? Default: no in v1;
   store raw bytes. Disk is not context.
5. Should the semantic map cover every file in small repositories (<100 files)
   instead of only modules? Default: no; module-level is enough.
6. Should `read` return a diff for a changed file instead of the full range?
   Default: no in v1; add only if evals show repeated large re-reads.
7. Should the map be shared per worktree or per repository? Default: per
   worktree root, because tool roots differ. Use the repository cache only for
   read-only runs if needed.
