/**
 * machine_code — issue detail keys.
 *
 * `n` starts the run the issue needs (research for ideas, engineer for
 * features/bugs), `e` edits the issue file, `o` orchestrates the batch, and
 * gate/approve act on the issue. `d` opens the delete confirmation page.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findIssue, kindTag, updateIssueReview } from "../../plan/issues.js";
import { layout } from "../../paths.js";
import { commitPlanningFiles } from "../../tasks/planning.js";
import { listRuns, reconcileRun } from "../../state/runs.js";
import { runItemId } from "../../plan/lifecycle.js";
import { issueDeleteTarget } from "./delete-keys.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleIssueKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const slug = s.selectedIssueSlug;
  const l = layout(s.selectedIssueRepo ?? ctx.repoRoot);
  const spawnCli = (args: string[], note: string): void => {
    const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
    spawn(process.execPath, [cliPath, ...args], { cwd: l.repoRoot, detached: true, stdio: "ignore" }).unref();
    ctx.notify(note);
    ctx.draw();
  };
  const activeRun = (): boolean =>
    listRuns(l).some(
      (run) =>
        runItemId(run) === slug &&
        ["created", "running", "awaiting_input"].includes(reconcileRun(run).status),
    );
  const startForIssue = (): void => {
    if (!slug) return;
    const issue = findIssue(l, slug);
    if (issue?.status === "done" || issue?.status === "needs-human-review") {
      ctx.notify(`${slug} is ${issue.status}; finish review/approval before a new run`);
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
  if (data === "o") { spawnCli(["batch"], "orchestration started (batch)"); return true; }
  if (data === "g" && slug) {
    const issue = findIssue(l, slug);
    if (issue) {
      const next = issue.review === "none" ? "human" : "none";
      updateIssueReview(l, slug, next);
      void commitPlanningFiles(l, `[${kindTag(issue.kind)} REVIEW] ${slug} ${next}`);
      ctx.notify(`review ${next}`);
    }
    ctx.draw();
    return true;
  }
  if (data === "a" && slug) {
    const issue = findIssue(l, slug);
    if (activeRun()) {
      ctx.notify(`${slug} has an active run; wait for it before approving`);
      ctx.draw();
      return true;
    }
    if (issue?.status !== "needs-human-review" && issue?.status !== "done") {
      ctx.notify(`${slug} is ${issue?.status ?? "missing"}; approve requires needs-human-review`);
      ctx.draw();
      return true;
    }
    spawnCli(["approve", slug], `approve ${slug} queued`);
    return true;
  }
  if (data === "x" && slug) {
    const issue = findIssue(l, slug);
    if (issue?.status !== "needs-human-review") {
      ctx.notify(`${slug} is ${issue?.status ?? "missing"}; reject requires needs-human-review`);
      ctx.draw();
      return true;
    }
    spawnCli(["issue", "reject", slug], `reject ${slug} queued`);
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
