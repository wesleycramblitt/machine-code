/**
 * machine_code — bounded VCS commands for merge-conflict repair.
 *
 * The runner owns the sync itself (`vcs:sync`, injected as a gate). The agent
 * only gets the small surface needed to inspect and resolve the conflicts the
 * sync produces: list unmerged paths, mark a path resolved (or take one side),
 * and abort a genuinely unresolvable merge. None of these can reset arbitrary
 * history or touch paths outside the worktree.
 */
import { runProc } from "../proc.js";
import { resolveWithin, toRelative } from "../tools/safety.js";
import { syncWorktreeWithMain } from "../tasks/sync.js";
import type { CommandSpec } from "./registry.js";

type GitResult = Awaited<ReturnType<typeof runProc>>;

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return runProc("git", args, { cwd, timeoutMs });
}

function ok(result: GitResult): boolean {
  return result.outcome === "exit" && result.code === 0;
}

async function mergeInProgress(cwd: string): Promise<boolean> {
  return ok(await git(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]));
}

async function unmergedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["diff", "--name-only", "--diff-filter=U"], 15_000);
  if (!ok(result)) return [];
  return result.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
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
      "Use strategy \"ours\" or \"theirs\" only when one side is wholly correct. If the conflict is genuinely unresolvable, run vcs:merge-abort and report blocked with the exact files and reason.",
    ];
    return { text: lines.join("\n"), isError: true };
  },
};

export const vcsConflictsCommand: CommandSpec = {
  name: "vcs:conflicts",
  description: "List files with unresolved merge conflicts and the current merge status.",
  binary: "git",
  args: () => [],
  schema: {},
  readonly: true,
  timeoutMs: 15_000,
  handler: async (_args, ctx) => {
    if (!(await mergeInProgress(ctx.root))) {
      return { text: "vcs:conflicts: no merge in progress", isError: false };
    }
    const files = await unmergedFiles(ctx.root);
    const status = await git(ctx.root, ["status", "--short"]);
    const body = status.stdout.trim();
    if (files.length === 0) {
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
    "strategy=ours|theirs takes that side of the whole file. Only works during an in-progress merge.",
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
    const files = await unmergedFiles(ctx.root);
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
    "Use only when the conflict is genuinely unresolvable; the branch keeps its committed work.",
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
    return { text: "vcs:merge-abort: merge aborted; branch restored to its pre-sync state", isError: false };
  },
};
