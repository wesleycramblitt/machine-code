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
  "- Find + read: inspect {query} is the only read/search path — file path, path:line range, symbol name, free keywords, or regex:true for raw pattern search. Turn-1 orientation is one keyword inspect, not many. detail=outline for signatures, summary (default) for matched bodies, full for file bytes. If you will edit a file, read it whole once; never page a file under ~200 lines. The holdings block carries current bytes every turn; the transcript only abbreviates old results. Never re-run a tool to recover bytes — use context recall {id}.",
  "- Change: command run {name, args} for typed commands only (no shell); command describe {name} for one schema. edit {path, oldString, newString} for edits; write {path, content} for new files. Batch edits across files with edit {files: [{path, edits: [{oldString, newString}]}]}: one entry per file, all hunks in that entry. The edit result shows the diff — this is the confirmation, never re-read to check.",
  "- Runs: command run {name: run:list} / {name: run:show, args: {id}} reads other runs (read-only). reference:find / reference:read reads the shared reference store.",
  "- Record: context note {kind: finding|decision|open, text} for conclusions the codebase doesn't capture. context recall {id} to fetch stored artifacts. context state to view the full run state.",
  "- Finish: finish {outcome, summary} when the change is ready for gates. outcome=completed|blocked|failed. summary is one or two sentences: what changed, or why the run stopped. If gates fail, the harness returns their output — keep fixing and finish again.",
  "</tool-policy>",
].join("\n");
