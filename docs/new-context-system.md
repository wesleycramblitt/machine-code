# Simplify and Consolidate the Context System

## Objective

Simplify the existing context engine into a small, efficient system that gives agents accurate, relevant codebase information with minimal tool calls and context overhead.

Preserve existing functionality where useful, but eliminate redundant representations, duplicated tracking, and unnecessary agent-facing operations.

Do not introduce an LLM-powered research or inspection agent. Codebase retrieval must be deterministic.

## 1. Brief — Task Context

**Purpose:** Give the agent everything it needs to understand its assignment and constraints.

Retain and refine the existing assembled context system.

Include:
- Issue and task description.
- Explicitly supplied files and references.
- Relevant knowledge and architecture documentation.
- Mode instructions and required skills.
- Relevant starting hints where available.

Keep the stable prompt prefix optimized for prompt caching.

Do not automatically inject the entire repository map or module index into the prompt.

## 2. Codebase Index — Repository Structure

**Purpose:** Provide a reusable, repository-level structural index.

Retain the deterministic repo map as an internal retrieval resource.

Use existing capabilities to provide:
- File paths and metadata.
- Languages and directory structure.
- Symbols, definitions, and line ranges.
- Imports and dependency relationships.
- Documentation and section headings.

Use existing LSP, Ctags, and CLI capabilities where available rather than implementing duplicate indexing.

Keep the index deterministic, refreshable, and independent of individual runs.

Evaluate whether the separate module index provides enough value to justify retaining it. Prefer removing it if its functionality can be covered by the repo map and inspection operations.

## 3. Inspect — Deterministic Code Retrieval

**Purpose:** Give the agent one efficient, structured interface for understanding code.

Implement a deterministic `inspect` tool that combines existing map, symbol, LSP, search, and file-reading capabilities.

No natural-language questions, LLM calls, or autonomous research.

Use explicit targets, for example:

- `symbol`: Inspect a symbol and its structural relationships.
- `file`: Inspect a file's outline, imports, documentation, and source.
- `directory`: Inspect directory contents and structure.
- `references`: Find definitions, usages, callers, and implementations.

Support a compact summary by default and full source retrieval when requested.

Return predictable, structured results containing:
- Resolved target and location.
- Relevant symbols and signatures.
- Definitions and relationships.
- Dependencies and references where available.
- Source excerpts or full source when requested.
- Clear indications when information is unavailable.
- Artifact reference for retrieving the complete result.

Use the best available source for each query:
- Repo map / Ctags for structural lookup.
- LSP for semantic information.
- Existing search tools for textual discovery.
- Filesystem reads for actual source.
- Git where historical information is relevant.

Do not invent relationships or claim semantic completeness when the underlying tools cannot establish it.

Automatically store complete inspection results in the existing content-addressed artifact store.

## 4. Workspace — Current Run Evidence

**Purpose:** Track what the agent has inspected and what has changed during the run.

Keep workspace information separate from the repository-level codebase index.

Track:
- Initial worktree baseline.
- Current cumulative Git changes against that baseline.
- Added, modified, deleted, and renamed files.
- Inspection targets and source versions.
- Artifact references for previously inspected content.
- Whether inspected source is still current.

Use Git diff as the authoritative source of changes. Include untracked files separately.

Do not build a custom change journal or duplicate Git's change tracking.

Retain inspection evidence as compact metadata, not duplicated source content.

When source changes, mark corresponding inspection evidence stale. Preserve the historical artifact for reference, but never present stale source as current.

Do not automatically inject entire changed files into the prompt.

## 5. Memory — Durable Run Knowledge

**Purpose:** Preserve information that cannot reliably be reconstructed from the codebase.

Refine the existing RunStateStore.

Keep:
- Findings.
- Decisions.
- Unresolved questions.

Do not require agents to manually record:
- Files they read.
- Searches they performed.
- Symbols they inspected.
- Changes that Git can detect.
- Routine progress or next actions that the harness can infer.

The harness should automatically track inspection coverage and workspace changes.

Memory should contain conclusions, not copies of tool output.

## 6. Artifacts — Exact Retrieval

Retain the existing content-addressed artifact store.

Use it for:
- Complete inspection results.
- Source reads and other substantial tool results.
- Exact historical evidence that may need to be recalled.

Keep `recall` available for retrieving previously stored results.

Avoid maintaining separate caches or duplicated copies of the same information in working context and ledger.

## 7. Prompt Rendering

Consolidate the prompt into a stable prefix and a dynamic tail.

**Stable prefix:**
- System and mode contract.
- Brief / assembled context.
- Tool guide.

**Dynamic tail:**
- Workspace changes.
- Compact inspection evidence and freshness.
- Run memory.
- Recent transcript and tool results.

Keep the stable prefix byte-identical across turns where possible.

Remove automatic full-file working-context injection and separate ledger rendering if artifact retrieval and inspection evidence make them redundant.

Keep recent tool results available through the transcript.

## 8. Agent-Facing Tool Surface

Converge on four primary operations:

1. `inspect` — Deterministic codebase retrieval.
2. `remember` — Record findings, decisions, and open questions.
3. `context` — View current task, workspace changes, inspection evidence, and memory.
4. `recall` — Retrieve exact artifact contents.

Remove or internalize redundant operations such as `focus` and `expand`. Lower-level map, search, read, and LSP operations may remain available internally to `inspect`.

### Inspect tool implementation example
Just an example, wouldn't have to work just like this.

inspect({
  symbol?: string,
  file?: string,
  directory?: string,
  detail?: "summary" | "full"
})

#### Symbol
symbol: MeshGenerator
definition:
  file: src/geometry/mesh.cpp
  lines: [42, 108]
  signature: "Mesh generate(const Geometry&, const MeshOptions&)"
  documentation: "..."

containing:
  symbol: GeometryPipeline
  file: src/geometry/pipeline.cpp

dependencies:
  - symbol: Geometry
    file: src/geometry/geometry.hpp
  - symbol: MeshOptions
    file: src/geometry/mesh.hpp

references:
  count: 7
  locations:
    - file: src/geometry/pipeline.cpp
      lines: [82, 82]

artifact: art_123

#### File
file: src/geometry/mesh.cpp

outline:
  - name: MeshGenerator
    kind: class
    lines: [20, 108]
  - name: generate
    kind: function
    lines: [42, 108]

imports:
  - src/geometry/geometry.hpp
  - src/geometry/mesh.hpp

documentation: "..."

artifact: art_456

#### Directory
directory: src/geometry

files:
  - path: mesh.cpp
    language: cpp
    symbols: 12
  - path: geometry.hpp
    language: cpp
    symbols: 8

dependencies:
  incoming: [...]
  outgoing: [...]
  
#### References
references: MeshGenerator

definitions:
  - file: src/geometry/mesh.cpp
    lines: [20, 108]

references:
  - file: src/geometry/pipeline.cpp
    lines: [82, 82]

callers:
  - symbol: GeometryPipeline::build
    file: src/geometry/pipeline.cpp

inspect({ "symbol": "MeshGenerator" })

inspect({ "file": "src/geometry/mesh.cpp" })

inspect({ directory: "src/geometry" })

inspect({ references: "MeshGenerator" })

## Implementation Requirements

- Inspect the existing codebase and identify reusable components before modifying anything.
- Prefer refactoring and consolidating existing functionality over creating new subsystems.
- Avoid introducing new databases, indexing frameworks, or unnecessary abstractions.
- Preserve artifact provenance and source-version tracking.
- Ensure stale inspection results are never represented as current.
- Keep retrieval deterministic and independently testable.
- Maintain prompt-cache stability.
- Minimize agent-facing tool calls and manual context management.
- Update relevant tests, types, documentation, and tool contracts.

## Desired Outcome

A small context system with clear responsibilities:

- **Brief:** What am I supposed to do?
- **Codebase Index:** What exists?
- **Inspect:** Show me the relevant code and relationships.
- **Workspace:** What have I inspected, and what has changed?
- **Memory:** What have I learned that isn't obvious from the source?
- **Artifacts:** Where can I retrieve exact previous evidence?

The harness manages retrieval, freshness, storage, and context assembly. The agent focuses on understanding the problem and engineering the solution.
