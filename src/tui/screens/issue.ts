/**
 * machine_code — issue detail screen.
 *
 * One page per issue: its status directory, prompt, dependencies, tags,
 * review mode, body, and every run attached to it. Actions move the issue
 * forward (run/orchestrate/gate/approve/delete/edit); Back lives in the header.
 */
import { B, C, D, G, GR, M, R, RED, W, WHITE, Y, statusColor, icon, agentTone, command, joinCommands, trunc, fmtMoney, fmtRunTokens, wrapText } from "../format.js";
import { sortRuns } from "../status.js";
import type { RunSummary } from "../../state/runs.js";
import { runItemId } from "../../plan/lifecycle.js";
import { ISSUE_STATUS_LABELS, type DisplayStatus, type IssueKind } from "../../plan/issues.js";
import { isApprovable, issueBranchState, type IssueBranchState } from "../../tasks/issue.js";
import type { Layout } from "../../paths.js";
import type { TuiState } from "../state.js";
import { issueTone, kindBadge } from "./tones.js";
import { windowedBody, type Viewport } from "./types.js";

export interface IssueHeader {
  slug: string;
  kind: IssueKind;
  /** Effective status (raw directory status, or in-progress while a run is live). */
  status: DisplayStatus;
  rel: string;
  priority: string;
  tags: string[];
  depends: string[];
  files: string[];
  branch: string;
  commit?: string;
  /** The issue file's prompt: the whole body text. */
  prompt: string;
  acceptance: string[];
}

export interface IssueProps extends Viewport {
  slug: string | null;
  issue: IssueHeader | null;
  runs: readonly RunSummary[];
  /** Probe result for the issue's feature branch; null while pending or failed. */
  branchState: IssueBranchState | null;
  scroll: number;
}

export interface IssueFrame {
  body: string[];
  actions: string;
  secondary: string;
  scroll: number;
}

/** Branch/worktree of the newest attached run; both are optional on RunSummary. */
function worktreeOf(runs: readonly RunSummary[], slug: string, fallbackBranch?: string): { branch: string; worktree: string } {
  const attached = sortRuns(runs.filter((run) => runItemId(run) === slug), "activity");
  const newest = attached[0];
  return {
    branch: newest?.branch ?? fallbackBranch ?? `mc/${slug}`,
    worktree: newest?.worktree ?? "—",
  };
}

/** The prompt body: full text wrapped to the terminal, headings bold white.
 * The leading `# Title` line is skipped — line 1 already carries the identity. */
function promptLines(prompt: string, cols: number): string[] {
  const lines = prompt.split("\n");
  if (/^#\s+/.test(lines[0] ?? "")) lines.shift();
  while ((lines[0] ?? "") === "") lines.shift();
  const out: string[] = [];
  for (const line of wrapText(lines.join("\n"), Math.max(20, cols))) {
    if (line.trim() === "") { out.push(""); continue; }
    if (/^#{1,6}\s/.test(line)) out.push(`${B}${W}${line}${R}`);
    else out.push(`${D}${line}${R}`);
  }
  return out;
}

/** Suffix for the Branch line: green when the branch carries work or is merged,
 * yellow with no changes, red when the branch is missing, dim while unknown. */
function branchNote(state: IssueBranchState | null): string {
  if (!state) return ` ${D}?${R}`;
  switch (state.state.code) {
    case "ahead": return ` ${G}${state.state.ahead} ahead${R}`;
    case "merged": return ` ${G}merged${R}`;
    case "unchanged": return ` ${Y}no changes${R}`;
    case "missing": return ` ${RED}no branch${R}`;
  }
}

export function renderIssue(props: IssueProps): IssueFrame {
  const { bodyH, toast, slug, issue, runs, branchState, scroll, cols } = props;
  const lines: string[] = [];
  if (!slug) {
    lines.push("", ` ${Y}issue not found${R}`);
  } else {
    // Line 1: kind badge, slug, [Status] — runs-page tones.
    const tone = issue ? issueTone(issue.status, issue.kind) : D;
    const badge = issue ? kindBadge(issue.kind, issue.kind === "ideas" ? "Idea" : issue.kind === "features" ? "Feature" : "Bug") : "";
    const statusText = issue ? ISSUE_STATUS_LABELS[issue.status] : "unknown";
    lines.push(` ${badge}  ${tone}${slug}${R}  ${tone}[${statusText}]${R}`);
    if (issue) {
      // Line 2: branch/worktree with a color-encoded probe of the branch state.
      const work = worktreeOf(runs, slug, issue.branch);
      lines.push(` ${B}${WHITE}Branch:${R} ${D}${branchState?.branch ?? work.branch}${R}${branchNote(branchState)}    ${B}${WHITE}Worktree:${R} ${D}${work.worktree}${R}`);
      // Line 3: priority.
      lines.push(` ${B}${WHITE}Priority:${R} ${D}${issue.priority}${R}`);
      if (issue.commit) {
        lines.push(` ${B}${WHITE}Landed:${R} ${D}${issue.commit.slice(0, 12)}${R}`);
      }
      // Prompt: the whole body, wrapped to the terminal width.
      lines.push(` ${B}${W}Prompt:${R}`);
      lines.push(...promptLines(issue.prompt, cols));
      // Acceptance / Tags / Depends / Verification.
      lines.push(` ${B}${WHITE}Acceptance:${R} ${D}${issue.acceptance.length > 0 ? issue.acceptance.join(", ") : "defaults"}${R}`);
      const meta: string[] = [];
      if (issue.tags.length > 0) meta.push(`${B}${WHITE}Tags:${R} ${D}${issue.tags.join(", ")}${R}`);
      if (issue.depends.length > 0) meta.push(`${B}${WHITE}Depends:${R} ${D}${issue.depends.join(", ")}${R}`);
      if (issue.files.length > 0) meta.push(`${B}${WHITE}Files:${R} ${D}${issue.files.join(", ")}${R}`);
      if (meta.length > 0) lines.push(` ${meta.join("    ")}`);
    }
    const attached = runs.filter((run) => runItemId(run) === slug);
    lines.push("", ` ${B}Runs${R} ${D}(${attached.length})${R}`);
    for (const run of sortRuns(attached, "activity")) {
      const cost = typeof (run as any).cost?.actual === "number" ? (run as any).cost.actual : 0;
      const tokens = typeof (run as any).usage?.totalTokens === "number" ? (run as any).usage.totalTokens : 0;
      lines.push(`   ${icon(run.status)} ${W}${run.id.slice(-8)}${R} ${agentTone(run.agent)}${run.agent}${R} ${statusColor(run.status)}${run.status.toUpperCase()}${R}${run.error ? ` ${Y}${trunc(run.error, 40)}${R}` : ""}${cost ? ` ${Y}${fmtMoney(cost)}${R}` : ""}${tokens ? ` ${M}${fmtRunTokens(tokens)}${R}` : ""}`);
    }
  }
  const w = windowedBody(lines, scroll, scroll, bodyH);
  return {
    ...w,
    actions: joinCommands([
      command("n", "Run", undefined, C),
      // Approve is only offered for built work: the issue is in a reviewable
      // status and the branch probe found changes worth merging.
      ...(issue && (issue.status === "needs-human-review" || issue.status === "done")
        && branchState !== null && isApprovable(branchState)
        ? [command("a", "Approve", undefined, G)]
        : []),
      command("d", "Delete", undefined, RED),
    ]),
    secondary: slug ? `${D}${issue?.rel ?? `issues/${slug}`}${toast ? ` · ${Y}${toast}${R}` : ""}${R}` : "",
  };
}

/** Fresh branch state for an issue; null when the probe fails (no git root). */
export async function probeIssueBranch(issueLayout: Layout, slug: string): Promise<IssueBranchState | null> {
  try {
    return await issueBranchState(issueLayout, slug);
  } catch {
    return null;
  }
}

/** Cache key for the branch probe: the ids + statuses of the runs attached to
 * the issue, so a status change (a run finishing) triggers a fresh probe. */
function issueRunsSig(runs: readonly RunSummary[], slug: string): string {
  return sortRuns(runs.filter((run) => runItemId(run) === slug), "activity")
    .map((run) => `${run.id}:${run.status}`)
    .join("|");
}

/** Probe the issue's branch state in the background and cache it on the TUI
 * state: git queries must not block the synchronous render loop, so the next
 * draw after the probe picks the result up. Skipped while a probe for the
 * same slug+repo+runs signature is already cached. */
export function refreshIssueBranch(
  s: TuiState,
  issueLayout: Layout,
  slug: string | null,
  runs: readonly RunSummary[],
  draw: () => void,
): void {
  if (!slug) {
    s.issueBranch = null;
    return;
  }
  const runsSig = issueRunsSig(runs, slug);
  const cached = s.issueBranch;
  if (cached?.slug === slug && cached.repoRoot === issueLayout.repoRoot && cached.runsSig === runsSig) return;
  s.issueBranch = { slug, repoRoot: issueLayout.repoRoot, runsSig, state: null };
  void probeIssueBranch(issueLayout, slug).then((state) => {
    // Ignore probes that land after the screen moved to another issue.
    if (s.issueBranch?.slug !== slug) return;
    s.issueBranch = { slug, repoRoot: issueLayout.repoRoot, runsSig, state };
    draw();
  });
}
