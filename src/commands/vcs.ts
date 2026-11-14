/**
 * machine_code — bounded VCS commands for merge-conflict repair.
 *
 * The runner owns the sync itself (`vcs:sync`, injected as a gate). The agent
 * only gets the small surface needed to inspect and resolve the conflicts the
 * sync produces: list unmerged paths, mark a path resolved (or take one side),
 * and abort a genuinely unresolvable merge. None of these can reset arbitrary
 * history or touch paths outside the worktree.
 */
import { resolveWithin, toRelative } from "../tools/safety.js";
import {
  conflictedFiles,
  git,
  mergeInProgress,
  ok,
  stagedConflictMarkers,
  syncWorktreeWithMain,
} from "../tasks/sync.js";
import type { CommandSpec } from "./registry.js";

/** Line-start conflict markers still in a file's worktree content. */
async function fileHasMarkers(cwd: string, rel: string): Promise<boolean> {
  const result = await git(cwd, ["grep", "-l", "-e", "^<<<<<<< ", "-e", "^>>>>>>> ", "--", rel], 15_000);
  return ok(result) && result.stdout.trim().length > 0;
}

/** The runner-owned gate. Not exposed to the agent's command map. */
export const vcsSyncCommand: CommandSpec = {
  name: "vcs:sync",
  description:
    "Runner gate: merge the base branch (origin/main) into this worktree before build/test. " +
    "On conflict, leaves markers in place and returns the unmerged paths for the agent to resolve.",
  binary: "git",
  args: () => [],
  schema: {
    base: { type: "string", description: "Base branch to merge (default: the repo's base branch)." },
  },
  readonly: false,
  timeoutMs: 180_000,
  handler: async (args, ctx) => {
    const baseBranch = typeof args.base === "string" && args.base.trim() ? args.base.trim() : undefined;
    const result = await syncWorktreeWithMain(ctx.root, baseBranch ? { baseBranch } : {});
    if (result.ok) return { text: `vcs:sync: ${result.detail}`, isError: false };
    if (result.conflicts.length === 0) {
      return { text: `vcs:sync: ${result.detail}`, isError: true };
    }
    const lines = [
      `vcs:sync: ${result.detail}`,
      "",
      "Conflicted files:",
      ...result.conflicts.map((file) => `  ${file}`),
      "",
      "Resolve the <<<<<<< / ======= / >>>>>>> markers in each file by combining both sides into the correct final code.",
      "Then mark each path resolved:",
      ...result.conflicts.map((file) => `  vcs:resolve {path: "${file}", strategy: "edited"}`),
      "",
      "Call finish again when every conflict is resolved. vcs:sync will commit the merge and the build/test gates will run on the synced tree.",
      "Use strategy \"ours\" (your branch) or \"theirs\" (origin/main) only when one side is wholly correct. If the conflict is genuinely unresolvable, run vcs:merge-abort and report blocked with the exact files and reason.",
    ];
    return { text: lines.join("\n"), isError: true };
  },
};

export const vcsConflictsCommand: CommandSpec = {
  name: "vcs:conflicts",
  description: "List files with unresolved merge conflicts and the current merge status. If every path is resolved, says so (call finish to commit the merge).",
  binary: "git",
  args: () => [],
  schema: {},
  readonly: true,
  timeoutMs: 15_000,
  handler: async (_args, ctx) => {
    if (!(await mergeInProgress(ctx.root))) {
      return { text: "vcs:conflicts: no merge in progress", isError: false };
    }
    const files = await conflictedFiles(ctx.root);
    const status = await git(ctx.root, ["status", "--short"]);
    const body = status.stdout.trim();
    if (files.length === 0) {
      // Staged-but-still-marked files look resolved to git; call them out so
      // the agent edits them instead of finishing a marker-filled tree.
      const marked = await stagedConflictMarkers(ctx.root);
      if (marked.length > 0) {
        return {
          text:
            `vcs:conflicts: ${marked.length} staged path(s) still contain conflict markers — keep editing, then vcs:resolve each again:\n${marked.join("\n")}` +
            (body ? `\n\n${body}` : ""),
          isError: false,
        };
      }
      return {
        text: "vcs:conflicts: merge in progress, all paths resolved. Call finish to complete the merge." +
          (body ? `\n${body}` : ""),
        isError: false,
      };
    }
    return {
      text: `vcs:conflicts: ${files.length} unresolved path(s):\n${files.join("\n")}${body ? `\n\n${body}` : ""}`,
      isError: false,
    };
  },
};

export const vcsResolveCommand: CommandSpec = {
  name: "vcs:resolve",
  description:
    "Mark one conflicted path resolved after editing it. strategy=edited stages your merged file; " +
    "strategy=ours takes your branch's side, strategy=theirs takes origin/main's side (the sync merges " +
    "origin/main INTO your branch, so ours = yours). Only works during an in-progress merge.",
  binary: "git",
  args: () => [],
  schema: {
    path: { type: "string", required: true, description: "Conflicted path, relative to the worktree root." },
    strategy: { type: "string", description: "edited (default) | ours | theirs" },
  },
  readonly: false,
  timeoutMs: 30_000,
  handler: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) return { text: "vcs:resolve requires path", isError: true };
    if (!(await mergeInProgress(ctx.root))) {
      return { text: "vcs:resolve: no merge in progress", isError: true };
    }
    let rel: string;
    try {
      rel = toRelative(ctx.root, resolveWithin(ctx.root, path));
    } catch (error) {
      return { text: `vcs:resolve: ${(error as Error).message}`, isError: true };
    }
    if (!rel || rel === "." || rel === ".git" || rel.startsWith(".git/")) {
      return { text: `vcs:resolve: refusing to operate on ${rel || "(worktree root)"}`, isError: true };
    }
    const files = await conflictedFiles(ctx.root);
    if (!files.includes(rel)) {
      return {
        text:
          `vcs:resolve: ${rel} is not an unmerged path.` +
          (files.length > 0 ? ` Unresolved: ${files.join(", ")}` : " All paths are already resolved; call finish."),
        isError: true,
      };
    }
    const rawStrategy = typeof args.strategy === "string" ? args.strategy.trim().toLowerCase() : "edited";
    const strategy = rawStrategy === "ours" || rawStrategy === "theirs" ? rawStrategy : "edited";
    if (strategy !== "edited") {
      const checkout = await git(ctx.root, ["checkout", `--${strategy}`, "--", rel]);
      if (!ok(checkout)) {
        return { text: `vcs:resolve: could not take ${strategy} for ${rel}: ${checkout.stderr.trim() || checkout.stdout.trim()}`, isError: true };
      }
    } else if (await fileHasMarkers(ctx.root, rel)) {
      // Staging a still-marked file would clear its unmerged state while the
      // conflict text remains — the merge would then commit markers as
      // resolved. Refuse and send the agent back to the editor.
      return {
        text:
          `vcs:resolve: ${rel} still contains conflict markers — finish editing it first (remove every <<<<<<< / ======= / >>>>>>> line), ` +
          `then run vcs:resolve again.`,
        isError: true,
      };
    }
    const add = await git(ctx.root, ["add", "--", rel]);
    if (!ok(add)) {
      return { text: `vcs:resolve: could not stage ${rel}: ${add.stderr.trim() || add.stdout.trim()}`, isError: true };
    }
    return { text: `vcs:resolve: ${rel} marked resolved (${strategy})`, isError: false };
  },
};

export const vcsMergeAbortCommand: CommandSpec = {
  name: "vcs:merge-abort",
  description:
    "Abort the in-progress merge and restore the branch to its pre-sync state. " +
    "Use only when the conflict is genuinely unresolvable. After aborting, do NOT call finish with completed " +
    "(that re-runs the sync and returns the same conflicts) — report blocked with the exact files and reason instead.",
  binary: "git",
  args: () => [],
  schema: {},
  readonly: false,
  timeoutMs: 30_000,
  handler: async (_args, ctx) => {
    if (!(await mergeInProgress(ctx.root))) {
      return { text: "vcs:merge-abort: no merge in progress", isError: true };
    }
    const result = await git(ctx.root, ["merge", "--abort"]);
    if (!ok(result)) {
      return { text: `vcs:merge-abort failed: ${result.stderr.trim() || result.stdout.trim()}`, isError: true };
    }
    return { text: "vcs:merge-abort: merge aborted; branch restored to its pre-sync state. Report blocked with the exact files and why — do not finish completed, the next sync would conflict the same way.", isError: false };
  },
};
