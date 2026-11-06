/**
 * machine_code — synchronous feature panel for the TUI run detail.
 *
 * Answers "is the feature branch merged / is the issue closed" without
 * network: issue state comes from the local issue cache, merge state from
 * local git, worktree dirt from the worktree checkout. Stage rules mirror
 * featureStatus in tasks/lifecycle.ts, but PRs come from run records only
 * (no live provider lookup) so draw stays synchronous and offline-safe.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Layout } from "../paths.js";
import type { Issue, IssueRef } from "../issues/provider.js";
import { acceptanceEvidence } from "../issues/completion.js";
import { parseReviewVerdict } from "../orchestrator/outcome.js";
import { isReadyPlan, parsePlanMarker } from "../plan/schema.js";
import { featureRuns, type FeatureStage } from "../tasks/lifecycle.js";
import { featureBranchFor } from "../worktree.js";
import type { RunSummary } from "../state/runs.js";

export interface FeaturePanelBuild {
  id: string;
  status: string;
}

export interface FeaturePanelReview {
  id: string;
  status: string;
  verdict?: string;
}

export interface FeaturePanel {
  number: number;
  issueState: "open" | "closed" | "unknown";
  /** "unknown" when the issue is not in the local cache (no plan/body to judge). */
  stage: FeatureStage | "unknown";
  branch: string;
  baseBranch?: string;
  branchExists: boolean;
  /** undefined when the branch or base ref is missing locally. */
  merged?: boolean;
  ahead?: number;
  behind?: number;
  worktree?: string;
  worktreeExists: boolean;
  dirtyCount: number;
  commit?: string;
  build?: FeaturePanelBuild;
  review?: FeaturePanelReview;
  acceptance: boolean;
}

function gitOut(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim();
  } catch {
    return undefined;
  }
}

function refExists(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(cwd: string, branch: string, base: string): boolean | undefined {
  if (!refExists(cwd, `refs/heads/${branch}`) || !refExists(cwd, base)) return undefined;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, base], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch (error) {
    // Exit 1 means "not an ancestor"; anything else is an environment failure.
    const status = (error as { status?: unknown }).status;
    return status === 1 ? false : undefined;
  }
}

function aheadBehind(
  cwd: string,
  branch: string,
  base: string,
): { ahead: number; behind: number } | undefined {
  const out = gitOut(cwd, ["rev-list", "--left-right", "--count", `${base}...${branch}`]);
  if (!out) return undefined;
  const [behindRaw, aheadRaw] = out.split("\t");
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return undefined;
  return { ahead, behind };
}

function dirtyCount(worktree: string | undefined): { exists: boolean; count: number } {
  if (!worktree || !existsSync(worktree)) return { exists: false, count: 0 };
  const out = gitOut(worktree, ["status", "--porcelain"]);
  if (out === undefined) return { exists: true, count: 0 };
  return { exists: true, count: out.length === 0 ? 0 : out.split("\n").filter((line) => line.trim()).length };
}

/**
 * Stage without git: plan + run records only. Cheap enough for per-row list
 * badges. Pass the worktree dirty count when known (the full panel does);
 * otherwise a completed run with a commit still resolves correctly and only
 * the dirty-without-commit edge stays conservative ("blocked").
 */
export function featureStageLite(
  issue: Issue | undefined,
  runs: readonly RunSummary[],
  opts: { dirtyCount?: number } = {},
): FeatureStage | "unknown" {
  if (!issue) return "unknown";
  const plan = parsePlanMarker(issue.body).plan;
  const latest = runs[0];
  const build = runs.find((run) => run.agent === "build" || run.phase === "build");
  const prOwner = build ?? latest;
  const prState =
    prOwner?.prNumber !== undefined
      ? prOwner.prState === "merged"
        ? "merged"
        : prOwner.prState === "closed"
          ? "closed"
          : "open"
      : undefined;
  const dirty = opts.dirtyCount ?? 0;
  if (issue.state === "closed") return "closed";
  if (!plan || !isReadyPlan(plan) || issue.acceptance.length === 0) return "planning";
  if (!latest) return "ready";
  if (latest.status === "created" || latest.status === "running" || latest.status === "awaiting_input") {
    return latest.phase === "review" ? "reviewing" : "building";
  }
  if (latest.status === "blocked" || latest.status === "failed" || latest.status === "interrupted") {
    return "blocked";
  }
  if (prState === "open") return "needs-human-review";
  if (prState === "closed") return "blocked";
  if (latest.status === "completed" && (dirty > 0 || build?.commit || latest.commit)) {
    return (issue.approval ?? "human") === "human" ? "needs-human-review" : "ready";
  }
  if (latest.status === "completed") return "blocked";
  return "blocked";
}

/**
 * Describe the feature behind an issue-attached run. Returns null when the
 * run carries no issue ref. Never throws and never touches the network.
 */
export function featurePanel(layout: Layout, issue: Issue | undefined, ref: IssueRef): FeaturePanel | null {
  const runs = featureRuns(layout, ref);
  const latest = runs[0];
  const build = runs.find((run) => run.agent === "build" || run.phase === "build");
  const review = runs.find((run) => run.agent === "review" || run.phase === "review");
  const branch =
    (typeof build?.branch === "string" && build.branch) ||
    (typeof latest?.branch === "string" && latest.branch) ||
    (issue ? featureBranchFor(ref.number, issue.title) : `mc/feature/${ref.number}`);
  const baseBranch =
    (typeof build?.baseBranch === "string" && build.baseBranch) ||
    (typeof latest?.baseBranch === "string" && latest.baseBranch) ||
    undefined;
  const rawWorktree = build?.worktree ?? latest?.worktree;
  const worktree = typeof rawWorktree === "string" && rawWorktree.length > 0 ? rawWorktree : undefined;
  const { exists: worktreeExists, count } = dirtyCount(worktree);
  const commit = build?.commit ?? latest?.commit;
  const cwd = layout.repoRoot;

  const branchExists = refExists(cwd, `refs/heads/${branch}`);
  let merged: boolean | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  if (baseBranch) {
    merged = isAncestor(cwd, branch, baseBranch);
    const counts = aheadBehind(cwd, branch, baseBranch);
    if (counts) ({ ahead, behind } = counts);
  }

  // Stage mirrors featureStatus, with run-record PR state only.
  const stage = featureStageLite(issue, runs, { dirtyCount: count });
  const acceptance = issue ? acceptanceEvidence(layout, ref).verified : false;

  return {
    number: ref.number,
    issueState: issue ? issue.state : "unknown",
    stage,
    branch,
    ...(baseBranch ? { baseBranch } : {}),
    branchExists,
    ...(merged !== undefined ? { merged } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    ...(worktree ? { worktree } : {}),
    worktreeExists,
    dirtyCount: count,
    ...(typeof commit === "string" && commit ? { commit: commit.slice(0, 12) } : {}),
    ...(build ? { build: { id: build.id, status: build.status } } : {}),
    ...(review
      ? {
          review: {
            id: review.id,
            status: review.status,
            ...(review.finalText && parseReviewVerdict(review.finalText)
              ? { verdict: parseReviewVerdict(review.finalText)! }
              : {}),
          },
        }
      : {}),
    acceptance,
  };
}
