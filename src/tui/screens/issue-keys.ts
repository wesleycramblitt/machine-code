/**
 * machine_code — issue detail keys.
 *
 * `n` starts the run the issue needs (research for ideas, engineer for
 * features/bugs), `e` edits the issue file, `d` opens the delete confirmation page.
 */
import { findIssue } from "../../plan/issues.js";
import { layout } from "../../paths.js";
import { issueDeleteTarget } from "./delete-keys.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleIssueKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const slug = s.selectedIssueSlug;
  const l = layout(s.selectedIssueRepo ?? ctx.repoRoot);
  const startForIssue = (): void => {
    if (!slug) return;
    const issue = findIssue(l, slug);
    if (issue?.status === "done") {
      ctx.notify(`${slug} is done`);
      return;
    }
    const agent = issue?.kind === "ideas" ? "research" : "engineer";
    ctx.startNewRun(undefined, l.repoRoot, { agent, item: slug });
  };
  if (data === "\x1b" || data === "q") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "\x1b[A" || data === "k") { s.issueScroll = Math.max(0, s.issueScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.issueScroll += 1; ctx.draw(); return true; }
  if (data === "n") { startForIssue(); ctx.draw(); return true; }
  if (data === "e" && slug) {
    const issue = findIssue(l, slug);
    if (issue) ctx.openEditor(issue.path);
    return true;
  }

  if (data === "d" && slug) {
    // Deleting an issue is destructive: confirm on the delete page first.
    const target = issueDeleteTarget(l.repoRoot, slug);
    if (!target) {
      ctx.notify(`no issue ${slug}`);
      ctx.draw();
      return true;
    }
    s.deleteTarget = target;
    s.deleteReturn = "issue";
    s.screen = "delete";
    ctx.draw();
    return true;
  }
  ctx.draw();
  return true;
}
