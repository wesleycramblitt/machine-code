/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "Use the most direct tool first.",
  "- Locate: outline or symbols (LSP) before text search. Use text search for strings.",
  "- Read: symbol or section first; batch several symbols/sections in one call; full file if small; offset paging only for a large unindexed file.",
  "- Expand: context expand path#symbol for the symbol plus imports, callers, and tests.",
  "- Search: search auto for a symbol or file path; rg/git grep for text, ast-grep for structure, LSP references for callers.",
  "- Edit: exact-match edit scoped by symbol/section; batch all hunks in one call; write only for a new file or a full replacement.",
  "- Verify: use the packet's acceptance command, not an ad-hoc probe.",
  "- Repeated work: create or reuse an artifact script instead of repeating a command.",
  "</tool-policy>",
].join("\n");
