/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer. It is the sole
 * owner of tool-routing syntax — role prompts must not duplicate it.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "### 0. Argument format",
  "Pass objects and arrays as JSON values, not strings. Example: {\"path\": \"src/a.ts\", \"pattern\": \"foo\"}.",
  "After a validation error, fix the arguments; never retry unchanged.",
  "",
  "### 1. Holdings first — bytes are already in context",
  "Every turn includes a `<holdings>` block: metadata for every file the run has seen, body bytes for files",
  "the model recently inspected or edited. If the file and range you need are in holdings, skip inspect.",
  "Holdings is current from disk — never re-read what is already there.",
  "",
  "### 2. Inspect for discovery",
  "`inspect {query}` finds definitions, symbols, outlines, and keyword matches — everything not in holdings.",
  "One call per distinct concern.",
  "- **Symbol reads** are cheapest: `detail=outline` lists signatures; then target a symbol by name.",
  "- **Pinned anchor reads** for a precise range: `{query: \"src/file.ts:83-116\"}` or `{path: \"src/file.ts\", symbol: \"Name\"}`.",
  "- **Full file** (`detail=full`) only for files under ~200 lines that are not in holdings.",
  "- **Regex mode** (`regex: true`) for raw pattern searches over contents.",
  "",
  "### 3. Change with intent",
  "`edit {path, symbol/section + newString}` for whole-block replacement (no anchor drift).",
  "`edit {path, oldString, newString}` for exact-match hunks. Batch independent files in one `edit {files: [...]}`.",
  "`write {path, content}` for new files. `command run {name, args}` for typed commands (no shell).",
  "The edit result diff is the confirmation — never re-read to check.",
  "",
  "### 4. Plan, record, and finish",
  "`context plan {steps: [{text, done}, ...]}` sets a durable plan checklist.",
  "There is always exactly one plan; calling it again replaces the old one.",
  "It renders as checkboxes in `<run-state>` every turn. Update `done: true` as you complete each step.",
  "`context note {kind: finding|decision|open, text}` for conclusions and observations.",
  "`context recall {id}` for stored artifacts. `finish {outcome, summary}` when ready for gates.",
  "",
  "### Holdings vs. artifacts vs. re-reading",
  "- **Holdings**: current bytes every turn for files the run has engaged with. Check here first.",
  "- **Artifacts**: stored results of past tool calls (`inspect`, `grep`, `search`). Use `context recall {id}`.",
  "- **Re-reading**: only when the file is not in holdings AND you need the full body, or when holdings shows",
  "  metadata-only (the file is >= 500 lines or was evicted by recency). Prefer symbol or anchor reads",
  "  over full file reads for large files — `detail=outline` first, then one symbol.",
  "</tool-policy>",
].join("\n");
