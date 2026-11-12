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
  "- Find: inspect target=symbol <name> for definition + source; inspect target=references <name> for usages; inspect target=file <path> for outline + imports + doc; inspect target=directory <path> to list a dir. For text patterns: search <query> (smart dispatch: identifier → symbol, file path → outline, regex → grep-like). grep {pattern, path, ignoreCase} for raw text search scoped to a path.",
  "- Read: read {path} returns numbered lines. Use read {symbol}, read {around}, or read {offset+limit} for one block. Never re-read what inspect already returned — use the artifact id via context recall {id}.",
  "- Change: command run {name, args} for typed commands only (no shell); command describe {name} for one schema. edit {path, oldString, newString} for edits; write {path, content} for new files. Batch edits across files in one call with edit {files: [...]}. The edit result shows the diff — this is the confirmation, never re-read to check. Changes are summarized in the workspace block.",
  "- Record: context note {kind: finding|decision|open, text} for conclusions the codebase doesn't capture. context recall {id} to fetch stored artifacts. context state to view the full run state.",
  "- Finish: finish {outcome, summary} when the change is ready for gates. outcome=completed|blocked|failed. summary is one or two sentences: what changed, or why the run stopped. If gates fail, the harness returns their output — keep fixing and finish again.",
  "</tool-policy>",
].join("\n");
