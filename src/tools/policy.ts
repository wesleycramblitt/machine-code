/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer. It is the sole
 * owner of tool-routing syntax — role prompts must not duplicate it.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "Fewest calls that get it right. Decide from the context you hold; every re-fetch is a call spent learning nothing new.",
  "- Find + read: inspect {query} does both in one call — file path, path:line range, symbol name, or free keywords. Turn-1 orientation is one inspect call with keywords, not many. Match kind (symbol | path | keyword | regex) is named per file with line numbers. detail=outline for signatures, summary (default) for matched bodies, full for capped bodies; symbol/offset/limit/around page a file. Never re-fetch held bytes — the holdings block re-sends what changed, context recall {id} fetches the rest (stale artifacts are flagged).",
  "- Change: command run {name, args} for typed commands only (no shell); command describe {name} for one schema. edit {path, oldString, newString} for edits; write {path, content} for new files. Batch edits across files in one call with edit {files: [...]}. The edit result shows the diff — this is the confirmation, never re-read to check. Changes are summarized in the workspace block.",
  "- Runs: command run {name: run:list} / {name: run:show, args: {id}} reads other runs (read-only). reference:find / reference:read reads the shared reference store.",
  "- Record: context note {kind: finding|decision|open, text} for conclusions the codebase doesn't capture. context recall {id} to fetch stored artifacts. context state to view the full run state.",
  "- Finish: finish {outcome, summary} when the change is ready for gates. outcome=completed|blocked|failed. summary is one or two sentences: what changed, or why the run stopped. If gates fail, the harness returns their output — keep fixing and finish again.",
  "</tool-policy>",
].join("\n");
