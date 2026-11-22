/**
 * machine_code — research verification command.
 *
 * A deterministic gate for research runs: checks that the run produced at
 * least one new, modified, or deleted file in the research output paths
 * (.machine_code/issues/, docs/, references/). Issue changes are tracked in the run dir;
 * docs/references use a hard git check.
 */

/**
 * Which issue a changed research path belongs to. Exact rel first; then kind
 * dir + exact filename — never a bare slug suffix, which collides across
 * kinds (features/todo/foo.md vs bugs/todo/foo.md).
 */
export function matchChangedIssue(allIssues: Issue[], file: string): Issue | undefined {
  const exact = allIssues.find((issue) => issue.rel === file);
  if (exact) return exact;
  const parts = file.split("/");
  if (parts[0] !== ".machine_code" || parts[1] !== "issues" || parts.length < 4) return undefined;
  const name = parts[parts.length - 1] ?? "";
  return allIssues.find(
    (issue) =>
      issue.kind === parts[2] &&
      issue.rel.split("/").pop() === name,
  );
}
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandSpec } from "./registry.js";
import { layout } from "../paths.js";
import { listIssues, type Issue } from "../plan/issues.js";
import { overlapFootprints } from "../plan/overlap.js";

const GIT_PATHS = ["docs/", "references/"];
const ISSUE_PREFIX = ".machine_code/issues/";

export const researchVerifyCommand: CommandSpec = {
  name: "research:verify",
  description:
    "Verify that a research run produced at least one new, modified, or deleted file in .machine_code/issues/, docs/, or references/. " +
    "Exit 0 if changes exist, 1 if nothing was created, changed, or deleted.",
  binary: "git",
  args: () => [],
  schema: {},
  readonly: true,
  timeoutMs: 10_000,
  handler: async (_args, ctx) => {
    try {
      // Issue changes are tracked by the issue commands in the run dir
      // (issues live outside git). Docs/references still use git.
      let trackedIssues: string[] = [];
      if (ctx.runDir) {
        const log = join(ctx.runDir, "issues-changed.json");
        if (existsSync(log)) {
          try {
            const parsed: unknown = JSON.parse(readFileSync(log, "utf8"));
            if (Array.isArray(parsed)) {
              trackedIssues = parsed.filter((e): e is string => typeof e === "string");
            }
          } catch {
            trackedIssues = [];
          }
        }
      }
      const gitRoot = ctx.root;
      const gitOut = (argv: string[]): string => {
        try {
          return execFileSync("git", ["-C", gitRoot, ...argv], { encoding: "utf8", timeout: 5_000 }).trim();
        } catch {
          return "";
        }
      };
      const untracked = gitOut(["ls-files", "--others", "--exclude-standard", ...GIT_PATHS]);
      const staged = gitOut(["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "--", ...GIT_PATHS]);
      const unstaged = gitOut(["diff", "--name-only", "--diff-filter=ACMRD", "--", ...GIT_PATHS]);
      // Files committed during the run (research commit workflow). Compare
      // against the merge-base with origin/main so a sync merge commit does
      // not hide the branch's own changes; fall back to HEAD~1 offline.
      let committed: string[] = [];
      try {
        let committedRange = "HEAD~1";
        try {
          const base = execFileSync("git", ["-C", gitRoot, "merge-base", "HEAD", "origin/main"], {
            encoding: "utf8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (base) committedRange = `${base}..HEAD`;
        } catch {
          // No origin/main (offline or no remote): keep the HEAD~1 fallback.
        }
        committed = execFileSync("git", [
          "-C", gitRoot,
          "diff", committedRange, "--name-only", "--diff-filter=ACMRD", "--", ...GIT_PATHS,
        ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim()
          .split("\n")
          .filter(Boolean)
          .filter((f) => GIT_PATHS.some((p) => f.startsWith(p)));
      } catch {
        // Single-commit repos have no HEAD~1; untracked/staged checks still work.
        committed = [];
      }

      const all = [
        ...trackedIssues,
        ...untracked.split("\n").filter(Boolean),
        ...staged.split("\n").filter(Boolean),
        ...unstaged.split("\n").filter(Boolean),
        ...committed,
      ];
      const unique = [...new Set(all)].filter(Boolean);

      // Tool-guarded curation: issue files must live in a status directory.
      // A bare kind dir (e.g. .machine_code/issues/features/foo.md) is misplaced.
      const allowedIssuePrefixes = [
        ".machine_code/issues/ideas/",
        ".machine_code/issues/features/todo/",
        ".machine_code/issues/features/needs-human-review/",
        ".machine_code/issues/features/failed-gates/",
        ".machine_code/issues/features/failed-human-review/",
        ".machine_code/issues/features/blocked/",
        ".machine_code/issues/features/done/",
        ".machine_code/issues/bugs/todo/",
        ".machine_code/issues/bugs/needs-human-review/",
        ".machine_code/issues/bugs/failed-gates/",
        ".machine_code/issues/bugs/failed-human-review/",
        ".machine_code/issues/bugs/blocked/",
        ".machine_code/issues/bugs/done/",
        ".machine_code/issues/references/todo/",
        ".machine_code/issues/references/done/",
      ];
      const misplaced = unique.filter(
        (f) => f.startsWith(ISSUE_PREFIX) && !allowedIssuePrefixes.some((p) => f.startsWith(p)),
      );
      if (misplaced.length > 0) {
        return {
          text: `research:verify failed — issues must live in todo, needs-human-review, failed-gates, failed-human-review, blocked, done, or ideas dirs: ${misplaced.join(", ")}`,
          isError: true,
        };
      }

      if (unique.length === 0) {
        return {
          text: "research:verify failed — no new, modified, or deleted files in .machine_code/issues/, docs/, or references/",
          isError: true,
        };
      }

      // Same-file issues must be sequenced. Research creates issues in this
      // run; if a new/changed issue declares an overlapping `files:` footprint
      // with another pending issue and neither depends on the other, they
      // would race on parallel branches and conflict at merge time. Enforce
      // the edge while the research agent can still fix it.
      const allIssues = listIssues(layout(ctx.repoRoot ?? ctx.root));
      const changedIssues = [...new Set(unique.map((file) => matchChangedIssue(allIssues, file)).filter((issue) => issue !== undefined))];
      // Quality backstop: the issue:create handler rejects placeholders, but
      // issues can also arrive via other paths (CLI, self-scope). A blank,
      // untitled, file-less, or gate-less feature/bug must fail here while
      // the research agent can still fix it — not surface as done work.
      const quality: string[] = [];
      for (const changed of changedIssues) {
        if (changed.slug === "untitled") {
          quality.push(`${changed.rel}: slug is "untitled" — derive it from the behavior change`);
          continue;
        }
        // Only features/bugs carry the prompt/files/acceptance bar. Ideas
        // and references issues are verified by their own gates.
        if (changed.kind !== "features" && changed.kind !== "bugs") {
          continue;
        }
        const promptLen = changed.prompt.trim().length;
        if (promptLen < 200) {
          quality.push(
            `${changed.rel}: prompt is ${promptLen} chars, need at least 200 ` +
              `(observable change, current state with file:line anchors, verification)`,
          );
        }
        if (changed.files.length === 0) {
          quality.push(`${changed.rel}: missing files: — investigate and name the exact paths or globs`);
        }
        if (changed.acceptance.length === 0 && changed.verify.length === 0) {
          quality.push(`${changed.rel}: missing acceptance: — name the gate that proves it (e.g. script:build)`);
        }
      }
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
      if (quality.length > 0) {
        return {
          text: `research:verify failed — placeholder or under-scoped issues (fix with issue:update or rewrite, never raw-write):\n${[...new Set(quality)].join("\n")}`,
          isError: true,
        };
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
