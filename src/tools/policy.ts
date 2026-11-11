/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "Fewest calls that get it right. Decide from the context you hold; every re-fetch is a call spent learning nothing new.",
  "- Find: the task files are already in context with line numbers — lift anchors straight out. If something is missing, discover in one parallel batch: map symbols <name> for where it lives, search <identifier> for its call sites, map outline <file> for its symbols. grep is for strings and always takes path or glob — never repo-wide.",
  "- Read: at most one block per file you will change — a bare read of a big file returns its outline, an offset window auto-expands to the enclosing block. Never re-read what you already hold; jump to the definition instead.",
  "- Change: command runs core:status for git state (typed args only — no shell, no bash, no git CLI); prior work, if any, is quoted in the branch report, so never history/show/describe to re-derive it; a function-scale change is one edit { symbol, newString } replacing the whole block (no anchor, no drift); edits across files go in one files call (all validate, then all apply); small hunks batch in edits scoped by symbol/section; results show a -/+ diff, or the whole numbered file when small — never re-read to confirm; write only for new files, never to rewrite one you hold; a signature change starts by locating callers.",
  "- Verify: you don't. Never run, read, or reason about build/test/lint tooling to check your work, and don't re-grep what you just wrote to reassure yourself. The runner verifies after finish and returns any failure; your job ends at the edit.",
  "- Finish: finish outcome=completed|blocked|failed, then stop calling tools. No post-edit re-reads, no diff, no status check, no test hunting. Build/test scripts are runner-owned; gates run after finish.",
  "- Plan: todo mirrors the issue's ## Todo in 2-4 steps; skip it for a change you can hold in one edit.",
  "</tool-policy>",
].join("\n");
