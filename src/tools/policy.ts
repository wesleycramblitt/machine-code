/**
 * machine_code — tool selection policy.
 *
 * The model should reach for the most direct tool first. This guide is small
 * and always in context; it is not an enforcement layer.
 */
export const TOOL_GUIDE = [
  "<tool-policy>",
  "Smartest tool first; read is the last resort, not the first move.",
  "- Find: search <identifier> for definitions + references; map outline <file> for its symbols; context expand path#symbol for callers and imports. grep is for strings, glob for paths.",
  "- Read: one symbol, section, or small file. Never re-read what you already hold; jump to the definition instead.",
  "- Change: command run core:status / core:diff for git state (typed args only — no shell, no bash, no git CLI); exact-match edits scoped by symbol/section, batched; write only for new files; a signature change starts by locating callers.",
  "- Verify: you don't. Never run, read, or reason about build/test/lint tooling to check your work, and don't re-grep what you just wrote to reassure yourself. The runner verifies after finish and returns any failure; your job ends at the edit.",
  "- Finish: finish outcome=completed|blocked|failed, then stop calling tools. Build/test scripts are runner-owned; gates run after finish.",
  "- Plan: todo mirrors the issue's ## Todo in 2-4 steps.",
  "</tool-policy>",
].join("\n");
