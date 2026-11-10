/**
 * machine_code — delete confirmation keys.
 *
 * Both destructive routes out of the runs page land here and need a second
 * keypress. `D` runs the confirmed deletion — a run through `runs delete
 * --yes`, an issue through `delete <slug>` — and `Esc` backs out to the screen
 * the delete was opened from. Returns true when the key was consumed.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trunc } from "../format.js";
import { layout } from "../../paths.js";
import { findIssue } from "../../plan/issues.js";
import { runItemId } from "../../plan/lifecycle.js";
import { listRuns, reconcileRun } from "../../state/runs.js";
import type { IssueDeleteTarget, RunDeleteTarget } from "./delete.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

/** Statuses that keep an issue's delete from running, mirroring the CLI guard. */
const ACTIVE_RUN_STATUSES = new Set(["created", "running", "awaiting_input"]);

/** The delete target for an issue, or null when the file is gone. */
export function issueDeleteTarget(repoRoot: string, slug: string): IssueDeleteTarget | null {
  const l = layout(repoRoot);
  const issue = findIssue(l, slug);
  if (!issue) return null;
  const attached = listRuns(l).filter((run) => runItemId(run) === slug);
  const activeRuns = attached.filter((run) => ACTIVE_RUN_STATUSES.has(reconcileRun(run).status)).length;
  return { kind: "issue", issue, repoRoot: l.repoRoot, runs: attached.length, activeRuns };
}

export function handleDeleteKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const target = s.deleteTarget;
  if (data === "\x1b") { s.deleteTarget = undefined; s.screen = s.deleteReturn; ctx.draw(); return true; }
  if (data === "D" && target) {
    if (target.kind === "run") confirmRunDelete(s, ctx, target);
    else confirmIssueDelete(s, ctx, target);
    return true;
  }
  ctx.draw();
  return true;
}

/** Cancel a live run, then delete its record, worktree, and branch. */
function confirmRunDelete(s: TuiState, ctx: KeyServices, target: RunDeleteTarget): void {
  const run = target.run;
  s.deletingRuns.add(run.id);
  const l = layout(run.repoRoot);
  const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [cliPath, "runs", "delete", run.id, "--yes"],
    {
      cwd: l.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("close", (code) => {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    try {
      writeFileSync(join(l.localDir, "delete.log"), `${new Date().toISOString()} run ${run.id}\n${output}\n`, "utf8");
    } catch {
      // best-effort diagnostics
    }
    if (code === 0) {
      ctx.notify(`deleted run ${run.id}`);
    } else {
      s.deletingRuns.delete(run.id);
      const last = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
      ctx.notify(`delete failed for run ${run.id}: ${trunc(last, 80)}`);
    }
    ctx.draw();
  });
  ctx.notify(`deleting run ${run.id}`);
  s.deleteTarget = undefined;
  s.selectedRunId = null;
  s.screen = "list";
  s.page = "runs";
  ctx.draw();
}

/** Delete an issue file and branch, refusing while a run is still live on it. */
function confirmIssueDelete(s: TuiState, ctx: KeyServices, target: IssueDeleteTarget): void {
  const slug = target.issue.slug;
  // Re-read so a run started while the page was open still blocks the delete.
  const current = issueDeleteTarget(target.repoRoot, slug);
  if (current?.activeRuns) {
    s.deleteTarget = current;
    ctx.notify(`${slug} has ${current.activeRuns} active run(s); stop them before deleting`);
    ctx.draw();
    return;
  }
  s.deleteTarget = undefined;
  if (current) {
    ctx.launch(["delete", slug], target.repoRoot);
    ctx.notify(`delete ${slug} queued`);
  } else {
    ctx.notify(`no issue ${slug}`);
  }
  s.selectedIssueSlug = null;
  s.screen = "list";
  s.page = "runs";
  ctx.draw();
}
