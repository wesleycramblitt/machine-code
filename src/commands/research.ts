/**
 * machine_code — research verification command.
 *
 * A deterministic gate for research runs: checks that the run produced at
 * least one new file in the research output paths (issues/, docs/,
 * .machine_code/references/). Replaces the fragile "Outcome: researched"
 * text-match system with a hard git check.
 */
import { execFileSync } from "node:child_process";
import type { CommandSpec } from "./registry.js";

const RESEARCH_PATHS = ["issues/", "docs/", ".machine_code/references/"];

export const researchVerifyCommand: CommandSpec = {
  name: "research:verify",
  description:
    "Verify that a research run produced at least one new file in issues/, docs/, or .machine_code/references/. " +
    "Exit 0 if new files exist, 1 if nothing was created.",
  binary: "git",
  args: () => [],
  schema: {},
  readonly: true,
  timeoutMs: 10_000,
  handler: async (_args, ctx) => {
    try {
      // New (untracked + staged) files in research output paths.
      const untracked = execFileSync("git", [
        "-C", ctx.root,
        "ls-files", "--others", "--exclude-standard", ...RESEARCH_PATHS,
      ], { encoding: "utf8", timeout: 5_000 }).trim();
      // Also check for files that were staged but not yet committed.
      const staged = execFileSync("git", [
        "-C", ctx.root,
        "diff", "--cached", "--name-only", "--diff-filter=A", "--", ...RESEARCH_PATHS,
      ], { encoding: "utf8", timeout: 5_000 }).trim();
      // Files committed during the run (research commit workflow).
      const committed = execFileSync("git", [
        "-C", ctx.root,
        "diff", "HEAD~1", "--name-only", "--diff-filter=A", "--", ...RESEARCH_PATHS,
      ], { encoding: "utf8", timeout: 5_000 }).trim()
        .split("\n")
        .filter(Boolean)
        .filter((f) => RESEARCH_PATHS.some((p) => f.startsWith(p)));

      const all = [
        ...untracked.split("\n").filter(Boolean),
        ...staged.split("\n").filter(Boolean),
        ...committed,
      ];
      const unique = [...new Set(all)].filter(Boolean);

      if (unique.length === 0) {
        return {
          text: "research:verify failed — no new files created in issues/, docs/, or .machine_code/references/",
          isError: true,
        };
      }
      return { text: `research:verify passed — ${unique.length} new file(s) created:\n${unique.join("\n")}`, isError: false };
    } catch (error) {
      return {
        text: `research:verify error: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
