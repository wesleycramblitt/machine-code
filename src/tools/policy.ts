/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "Smartest tool first; read is the last resort, not the first move.",
  "- Find: map symbols <name> for where it lives, search <identifier> when you also need its call sites; map outline <file> for its symbols; context expand path#symbol for callers and imports. grep is for strings and always takes path or glob — never repo-wide.",
  "- Read: one symbol, section, or small file — a bare read of a big file returns its outline, which is the hint to read { symbol }. Never re-read what you already hold; jump to the definition instead.",
  "- Change: command runs core:status for git state (typed args only — no shell, no bash, no git CLI); prior work, if any, is quoted in the branch report, so never history/show/describe to re-derive it; a function-scale change is one edit { symbol, newString } replacing the whole block (no anchor, no drift); small hunks batch in edits scoped by symbol/section; write only for new files, never to rewrite one you hold; a signature change starts by locating callers.",
  "- Verify: you don't. Never run, read, or reason about build/test/lint tooling to check your work, and don't re-grep what you just wrote to reassure yourself. The runner verifies after finish and returns any failure; your job ends at the edit.",
  "- Finish: finish outcome=completed|blocked|failed, then stop calling tools. No post-edit re-reads, no diff, no test hunting. Build/test scripts are runner-owned; gates run after finish.",
  "- Plan: todo mirrors the issue's ## Todo in 2-4 steps; skip it for a change you can hold in one edit.",
  "</tool-policy>",
].join("\n");
