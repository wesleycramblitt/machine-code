/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "Use the most direct tool first.",
  "- Read: symbol or section first; batch several symbols/sections in one call; full file if small; offset paging only for a large unindexed file.",
  "- Expand: context expand path#symbol for the symbol plus imports, callers, and tests.",
  "- Find: map locate <identifier> for definitions + references; map outline <file> for symbols; map overview for the repo map; grep for text; glob for paths.",
  "- Edit: exact-match edit scoped by symbol/section; batch all hunks in one call; write only for a new file or a full replacement; " +
    "changing a signature or option: locate the callers first.",
  "- Verify: run core:check for diagnostics; use the issue's acceptance command, not an ad-hoc probe.",
  "- Repeated work: create or reuse an artifact script instead of repeating a command.",
  "</tool-policy>",
].join("\n");
