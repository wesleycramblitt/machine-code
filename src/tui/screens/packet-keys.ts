/**
 * machine_code — issue detail keys.
 *
 * `n` starts the run the issue needs (research for ideas, engineer for
 * features/bugs), `e` edits the issue file, `o` orchestrates the batch, and
 * build/gate/approve/delete act on the issue like they did on the packet.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findIssue } from "../../plan/issues.js";
import { layout } from "../../paths.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handlePacketKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const slug = s.selectedPacketSlug;
  const l = layout(ctx.repoRoot);
  const spawnCli = (args: string[], note: string): void => {
    const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
    spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: "ignore" }).unref();
    ctx.notify(note);
    ctx.draw();
  };
  const startForIssue = (): void => {
    if (!slug) return;
    const issue = findIssue(l, slug);
    const agent = issue?.kind === "ideas" ? "research" : "engineer";
    ctx.startNewRun(undefined, l.repoRoot, { agent, item: slug });
  };
  if (data === "\x1b" || data === "q") { s.screen = "list"; ctx.draw(); return true; }
  if (data === "\x1b[A" || data === "k") { s.packetScroll = Math.max(0, s.packetScroll - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.packetScroll += 1; ctx.draw(); return true; }
  if (data === "n") { startForIssue(); ctx.draw(); return true; }
  if (data === "v" && slug) {
    const issue = findIssue(l, slug);
    if (!issue) {
      ctx.notify(`no issue ${slug}`);
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
  if (data === "b" && slug) { spawnCli(["build", slug], `build ${slug} started`); return true; }
  if (data === "a" && slug) { spawnCli(["approve", slug], `approve ${slug} queued`); return true; }
  if (data === "d" && slug) { spawnCli(["delete", slug], `delete ${slug} queued`); return true; }
  ctx.draw();
  return true;
}
