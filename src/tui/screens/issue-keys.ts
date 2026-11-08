/**
 * machine_code — issue detail keys.
 *
 * `n` starts the run the issue needs (research for ideas, engineer for
 * features/bugs), `e` edits the issue file, `o` orchestrates the batch, and
 * build/gate/approve/delete act on the issue.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findIssue, updateIssueReview } from "../../plan/issues.js";
import { layout } from "../../paths.js";
import { commitPlanningFiles } from "../../tasks/planning.js";
import { listRuns, reconcileRun } from "../../state/runs.js";
import { runItemId } from "../../plan/lifecycle.js";
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
    if (issue?.status === "done") {
      ctx.notify(`${slug} is done; move it back to todo before a new run`);
      return;
    }
    const agent = issue?.kind === "ideas" ? "research" : "engineer";
    ctx.startNewRun(undefined, l.repoRoot, { agent, item: slug });
  };
  if (data === "\x1b" || data === "q") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "\x1b[A" || data === "k") { s.issueScroll = Math.max(0, s.issueScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.issueScroll += 1; ctx.draw(); return true; }
  if (data === "n") { startForIssue(); ctx.draw(); return true; }
  if (data === "v" && slug) {
    const issue = findIssue(l, slug);
    if (!issue) {
      ctx.notify(`no issue ${slug}`);
      ctx.draw();
      return true;
    }
    if (issue.kind === "ideas") {
      ctx.notify(`${slug} is an idea; research it first`);
      ctx.draw();
      return true;
    }
    if (activeRun()) {
      ctx.notify(`${slug} has an active run; wait for it before reviewing`);
      ctx.draw();
      return true;
    }
    spawnCli(["run", "--agent", "review", "--item", slug, issue.prompt], `review ${slug} started`);
    return true;
  }
  if (data === "e" && slug) {
    const issue = findIssue(l, slug);
    if (issue) ctx.openEditor(issue.path);
    return true;
  }
  if (data === "o") { spawnCli(["batch"], "orchestration started (batch)"); return true; }
  if (data === "b" && slug) {
    const issue = findIssue(l, slug);
    if (activeRun()) {
      ctx.notify(`${slug} has an active run; wait for it before building`);
      ctx.draw();
      return true;
    }
    if (issue?.status === "done") {
      ctx.notify(`${slug} is done; move it back to todo before building`);
      ctx.draw();
      return true;
    }
    spawnCli(["build", slug], `build ${slug} started`);
    return true;
  }
  if (data === "g" && slug) {
    const issue = findIssue(l, slug);
    if (issue) {
      const next = issue.review === "none" ? "agent" : issue.review === "agent" ? "human" : "none";
      updateIssueReview(l, slug, next);
      void commitPlanningFiles(l, `issues: ${slug} review ${next}`);
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
    if (issue?.status !== "done") {
      ctx.notify(`${slug} is ${issue?.status ?? "missing"}; build it before approving`);
      ctx.draw();
      return true;
    }
    spawnCli(["approve", slug], `approve ${slug} queued`);
    return true;
  }
  if (data === "d" && slug) {
    if (activeRun()) {
      ctx.notify(`${slug} has an active run; stop it before deleting (or use --force)`);
      ctx.draw();
      return true;
    }
    spawnCli(["delete", slug], `delete ${slug} queued`);
    return true;
  }
  ctx.draw();
  return true;
}
