/**
 * machine_code — issue detail keys.
 *
 * `n` starts the run the issue needs (research for ideas, engineer for
 * features/bugs), `e` edits the issue file, `a` approves and merges,
 * `d` opens the delete confirmation page.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findIssue } from "../../plan/issues.js";
import { layout } from "../../paths.js";
import { isApprovable } from "../../tasks/issue.js";
import { issueDeleteTarget } from "./delete-keys.js";
import { probeIssueBranch } from "./issue.js";
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
  const startForIssue = (): void => {
    if (!slug) return;
    const issue = findIssue(l, slug);
    if (issue?.status === "done" || issue?.status === "needs-human-review") {
      ctx.notify(`${slug} is ${issue.status}; approve it with a`);
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
    ctx.startEditIssue(slug, l.repoRoot);
    ctx.draw();
    return true;
  }
  if (data === "a" && slug) {
    const issue = findIssue(l, slug);
    if (!issue) { ctx.draw(); return true; }
    if (issue.status !== "needs-human-review" && issue.status !== "done") {
      ctx.notify(`${slug} is ${issue.status}; build it before approving`);
      ctx.draw();
      return true;
    }
    // Approve only what was built: probe the issue's branch first. A missing
    // branch or a branch without changes never reaches the CLI; the probe
    // also refreshes the branch status shown on this screen.
    void (async () => {
      const state = await probeIssueBranch(l, slug);
      if (s.issueBranch?.slug === slug && s.issueBranch.repoRoot === l.repoRoot) {
        s.issueBranch = { ...s.issueBranch, state };
      }
      ctx.draw();
      if (!state || !isApprovable(state)) {
        const why = !state || state.state.code === "missing"
          ? `no branch for ${slug}`
          : `${state.branch} has no changes`;
        ctx.notify(`nothing to approve — ${why}`);
        return;
      }
      spawnCli(["approve", slug], `approve ${slug} queued`);
    })();
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
