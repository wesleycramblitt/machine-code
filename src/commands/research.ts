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
import { layout } from "../paths.js";
import { listIssues } from "../plan/issues.js";
import { overlapFootprints } from "../plan/overlap.js";

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
      // Changed files (new + modified) in research output paths.
      const untracked = execFileSync("git", [
        "-C", ctx.root,
        "ls-files", "--others", "--exclude-standard", ...RESEARCH_PATHS,
      ], { encoding: "utf8", timeout: 5_000 }).trim();
      // Staged changes (new or modified files).
      const staged = execFileSync("git", [
        "-C", ctx.root,
        "diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", ...RESEARCH_PATHS,
      ], { encoding: "utf8", timeout: 5_000 }).trim();
      // Unstaged working-tree changes (modified files not yet staged).
      const unstaged = execFileSync("git", [
        "-C", ctx.root,
        "diff", "--name-only", "--diff-filter=M", "--", ...RESEARCH_PATHS,
      ], { encoding: "utf8", timeout: 5_000 }).trim();
      // Files committed during the run (research commit workflow). Compare
      // against the merge-base with origin/main so a sync merge commit does
      // not hide the branch's own changes; fall back to HEAD~1 offline.
      let committed: string[] = [];
      try {
        let committedRange = "HEAD~1";
        try {
          const base = execFileSync("git", ["-C", ctx.root, "merge-base", "HEAD", "origin/main"], {
            encoding: "utf8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (base) committedRange = `${base}..HEAD`;
        } catch {
          // No origin/main (offline or no remote): keep the HEAD~1 fallback.
        }
        committed = execFileSync("git", [
          "-C", ctx.root,
          "diff", committedRange, "--name-only", "--diff-filter=ACMR", "--", ...RESEARCH_PATHS,
        ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim()
          .split("\n")
          .filter(Boolean)
          .filter((f) => RESEARCH_PATHS.some((p) => f.startsWith(p)));
      } catch {
        // Single-commit repos have no HEAD~1; untracked/staged checks still work.
        committed = [];
      }

      const all = [
        ...untracked.split("\n").filter(Boolean),
        ...staged.split("\n").filter(Boolean),
        ...unstaged.split("\n").filter(Boolean),
        ...committed,
      ];
      const unique = [...new Set(all)].filter(Boolean);

      if (unique.length === 0) {
        return {
          text: "research:verify failed — no new or modified files in issues/, docs/, or .machine_code/references/",
          isError: true,
        };
      }

      // Same-file issues must be sequenced. Research creates issues in this
      // run; if a new/changed issue declares an overlapping `files:` footprint
      // with another pending issue and neither depends on the other, they
      // would race on parallel branches and conflict at merge time. Enforce
      // the edge while the research agent can still fix it.
      const allIssues = listIssues(layout(ctx.root));
      const changedIssues = allIssues.filter((issue) =>
        unique.some((file) => file === issue.rel || file.endsWith(`/${issue.slug}.md`)),
      );
      const pending = allIssues.filter((issue) => issue.kind !== "ideas" && issue.status !== "done");
      const violations: string[] = [];
      for (const left of changedIssues) {
        for (const right of pending) {
          if (left.slug === right.slug) continue;
          const overlap = overlapFootprints(left.files, right.files);
          if (overlap.length === 0) continue;
          if (left.depends.includes(right.slug) || right.depends.includes(left.slug)) continue;
          violations.push(
            `${left.slug} and ${right.slug} both touch ${overlap.join(", ")} — ` +
              `add depends: ${right.slug} to ${left.slug} (or the reverse)`,
          );
        }
      }
      if (violations.length > 0) {
        return {
          text: `research:verify failed — overlapping file footprints need a depends edge:\n${[...new Set(violations)].join("\n")}`,
          isError: true,
        };
      }

      return { text: `research:verify passed — ${unique.length} file(s) changed:\n${unique.join("\n")}`, isError: false };
    } catch (error) {
      return {
        text: `research:verify error: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
