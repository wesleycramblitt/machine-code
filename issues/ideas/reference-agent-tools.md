Create a dedicated `reference` agent role with three new tools: web fetch, web search, and browser MCP (browse). This agent captures external information and curates it into the reference store at `.machine_code/references/`, producing bundled reference documents the research and engineer agents can consume.

## Current state

- No agent has web access. The research agent can read existing references via `reference:find`/`reference:read` but cannot create them.
- The `reference:find` command searches bundles by keyword — but bundles must exist first.
- External workflows (comparing coding agents, researching libraries, investigating APIs) require reading live web content and transforming it into structured references.

## Deliverables

1. **New tools:**
   - **`web-fetch`** — Fetch a single URL and return its rendered text content. Accept URL, optional CSS selector for scoping. Return markdown or text. Cap at ~50KB response. Timeout after 30s.
   - **`web-search`** — Search the web via a configurable search engine (Brave, Google Custom Search, or similar). Accept query string, optional site/domain filter, max results (1-10). Return titles, snippets, and URLs.
   - **`browse`** — Drive a headless browser (via browser MCP or Puppeteer/Playwright) for pages that require interaction: filling forms, accepting cookies, clicking through to content, waiting for JS-rendered content. Accept URL + optional action sequence (click, type, wait). Return page text content.

2. **`reference` agent role:**
   - New role in `data/agents/reference.md` with workflow: understand → plan → gather (web-fetch/search/browse) → curate → finish.
   - Tool list: `context`, `web-fetch`, `web-search`, `browse`, `write`, `skill`, `finish` (read-only tools too: `inspect`, `glob`, `command run` for `reference:*`).
   - Write-restricted to `.machine_code/references/` for reference bundles, plus `issues/` and `docs/` for derived artifacts.
   - No code edits allowed — reference-only.
   - Gates: `research:verify` (same check — at least one new or modified file in `.machine_code/references/`, `issues/`, or `docs/`).

3. **Reference bundle format:**
   - Each reference is a `.md` file under `.machine_code/references/` with YAML front matter including `source_url`, `fetched_at`, `tags`.
   - The `links.toml` index maps topics to bundle filenames.
   - Bundles are plain markdown — summaries, extracts, and analysis written by the agent.

4. **Integration:**
   - `reference:find` searches existing bundles only — it already works for this.
   - The research agent prompt already says it can read references but not create them. No change needed.
   - The reference agent is launched from the composer or CLI with `--agent reference`.

## Out of scope (for now)

- Persistent web crawler or scheduled fetches — one-shot per run only.
- PDF extraction or image analysis — text content only.
- Authentication or session management for browser MCP.

## Files to create

- `data/agents/reference.md` — role prompt
- `data/agents/reference.toml` — agent config (tools, capabilities)
- `src/tools/web-fetch.ts` — web fetch tool
- `src/tools/web-search.ts` — web search tool
- `src/tools/browse.ts` — browser MCP tool

## Files to modify

- `src/tools/index.ts` — register new tools
- `src/commands/registry.ts` — ensure the reference agent has access to `reference:*` commands
- `src/agents.ts` — register the `reference` role
- `src/loop.ts` — handle the reference agent's tool list

## Acceptance

- `script:build` compiles with no errors
- Create a reference by running the reference agent with `command run {name: "web-search", args: {query: "..."}}`
- The created `.machine_code/references/*.md` is findable by `reference:find`
- Research agent can read the created reference with `reference:read`
