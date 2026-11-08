/**
 * machine_code — delete confirmation keys.
 *
 * `D` runs the deletion in the background (the run record, worktree, and
 * branch); `Esc` backs out. Returns true when the key was consumed.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trunc } from "../format.js";
import { layout } from "../../paths.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleDeleteKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  if (data === "\x1b") { s.deleteRunTarget = undefined; s.screen = s.deleteReturn; ctx.draw(); return true; }
  if (data === "D" && s.deleteRunTarget) {
    const run = s.deleteRunTarget;
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
    s.deleteRunTarget = undefined;
    s.selectedRunId = null;
    s.screen = "list";
    s.page = "runs";
    ctx.draw();
    return true;
  }
  ctx.draw();
  return true;
}
