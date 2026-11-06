/**
 * machine_code — issue completion: acceptance evidence and parent closure rules.
 *
 * A parent closes only when:
 *   - every child is closed,
 *   - an `acceptance_verified` event exists for the issue (child counts alone
 *     are never evidence), and
 *   - the approval policy allows it (human approval queues a request).
 */
import type { Issue, IssueProvider, IssueRef } from "./provider.js";
import { readRun, listRuns, type RunSummary } from "../state/runs.js";
import type { Layout } from "../paths.js";

export interface AcceptanceEvidence {
  verified: boolean;
  runId?: string;
  at?: string;
  by?: string;
}

/** Scan this repo's runs for an acceptance_verified event on the issue. */
export function acceptanceEvidence(layout: Layout, issue: IssueRef): AcceptanceEvidence {
  for (const summary of listRuns(layout)) {
    if (summary.issue && summary.issue.number === issue.number && summary.issue.repo === issue.repo) {
      const detail = readRun(layout, summary.id);
      const found = detail?.events.find(
        (e) => e.type === "acceptance_verified" && (e as { issue?: number }).issue === issue.number,
      ) as { t?: string; by?: string } | undefined;
      if (found) return { verified: true, runId: summary.id, at: found.t, by: found.by };
    }
  }
  // Acceptance may also be recorded by a coordinating run that did not carry
  // the issue itself (e.g. a feature-level orchestrator).
  for (const summary of listRuns(layout)) {
    const detail = readRun(layout, summary.id);
    if (!detail) continue;
    const found = detail.events.find(
      (e) => e.type === "acceptance_verified" && (e as { issue?: number }).issue === issue.number,
    ) as { t?: string; by?: string } | undefined;
    if (found) return { verified: true, runId: summary.id, at: found.t, by: found.by };
  }
  return { verified: false };
}

export interface CompletionCheck {
  ok: boolean;
  reason?: string;
  openChildren: number[];
  acceptance: AcceptanceEvidence;
}

function openIssuePr(layout: Layout, issue: IssueRef): { runId: string; pr: number } | undefined {
  const runs = listRuns(layout)
    .filter((summary) => {
      const assigned = summary.issue;
      return Boolean(assigned && assigned.repo === issue.repo && assigned.number === issue.number);
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const latestPr = runs.find((summary) => summary.prState !== undefined || summary.prNumber !== undefined);
  if (latestPr?.prState === "open" && latestPr.prNumber) {
    return { runId: latestPr.id, pr: latestPr.prNumber };
  }
  return undefined;
}

/** Validate parent closure: deliverable children closed + acceptance evidence. */
export async function checkCompletion(
  provider: IssueProvider,
  layout: Layout,
  issue: Issue,
): Promise<CompletionCheck> {
  const acceptance = acceptanceEvidence(layout, issue.ref);
  const children = await provider.children(issue.ref);
  const openChildren = children.filter((c) => c.state !== "closed").map((c) => c.ref.number);
  if (openChildren.length > 0) {
    return {
      ok: false,
      reason: `open children: ${openChildren.map((n) => `#${n}`).join(", ")}`,
      openChildren,
      acceptance,
    };
  }
  const pr = openIssuePr(layout, issue.ref);
  if (pr) {
    return {
      ok: false,
      reason: `PR #${pr.pr} is still open; merge it before closing (run ${pr.runId})`,
      openChildren,
      acceptance,
    };
  }
  if (!acceptance.verified) {
    return {
      ok: false,
      reason: `no acceptance verdict for #${issue.ref.number}; record one with "machine_code accept ${issue.ref.number}"`,
      openChildren,
      acceptance,
    };
  }
  return { ok: true, openChildren, acceptance };
}

/**
 * Close/reopen cascade for a parent issue. Reserved anchors were removed, so
 * there is nothing to cascade to; kept as a no-op for call-site compatibility.
 */
export async function cascadeReserved(
  _provider: IssueProvider,
  _issue: Issue,
  _action: "close" | "reopen",
): Promise<number[]> {
  return [];
}
