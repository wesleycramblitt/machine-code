/**
 * machine_code — runs list keys.
 *
 * Move/fold/open, `n`/`N` new runs, `D` delete, `!` attention filter, `g`
 * group cycle, `f` repo scope, `/` search, `a` answer. The index is rebuilt
 * per keypress like the draw path so navigation and rendering agree.
 */
import { layout } from "../../paths.js";
import { listAllRuns } from "../../state/runs.js";
import { buildRunIndex, repoOf, RUN_GROUPS, type RunRow } from "../runs.js";
import { listIssues } from "../../plan/issues.js";
import { runItemId } from "../../plan/lifecycle.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleRunsListKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const l = layout(ctx.repoRoot);
  const allRuns = listAllRuns(l.home).filter((run) => !s.deletingRuns.has(run.id));
  const scopeFiltered = s.runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
  const index = buildRunIndex({
    runs: scopeFiltered,
    group: s.runsGroup,
    collapsed: s.collapsed,
    text: s.runsText,
    attentionOnly: s.runsAttention,
    preferredRepo: l.repoRoot,
    ...(s.runsGroup === "all" || s.runsGroup === "type" || s.runsGroup === "category"
      ? { packetRepo: l.repoRoot, issues: listIssues(l) }
      : {}),
  });
  const repoForRow = (row: RunRow | undefined): string => {
    if (!row) return l.repoRoot;
    if (row.kind === "repo") return row.repoRoot;
    if (row.kind === "run") return repoOf(row.run);
    for (let i = index.rows.indexOf(row); i >= 0; i--) {
      const candidate = index.rows[i]!;
      if (candidate.kind === "repo") return candidate.repoRoot;
    }
    return l.repoRoot;
  };
  if (data === "\x1b[A" || data === "k") { s.runsSel = Math.max(0, s.runsSel - 1); ctx.draw(); return true; }
  if (data === "\x1b[B" || data === "j") { s.runsSel = Math.min(Math.max(0, index.selectable.length - 1), s.runsSel + 1); ctx.draw(); return true; }
  if (data === "G") { s.runsSel = Math.max(0, index.selectable.length - 1); ctx.draw(); return true; }
  const toggleFold = (row: RunRow | undefined): boolean => {
    // A run is a leaf; space on it folds the parent issue/section/repo.
    const target = row?.kind === "run" && row.parent
      ? index.rows.find((candidate) => candidate.id === row.parent)
      : row;
    if (target?.kind !== "section" && target?.kind !== "repo" && target?.kind !== "issue") return false;
    if (!target.collapsible) return false;
    if (s.collapsed.has(target.id)) s.collapsed.delete(target.id);
    else s.collapsed.add(target.id);
    const targetIndex = index.rows.findIndex((candidate) => candidate.id === target.id);
    if (targetIndex >= 0) s.runsSel = targetIndex;
    return true;
  };
  if (data === "\r" || data === "\n") {
    const row = index.selectable[s.runsSel];
    if (row?.kind === "section" || row?.kind === "repo") { toggleFold(row); ctx.draw(); return true; }
    if (row?.kind === "run") { s.selectedRunId = row.run.id; s.runSection = "overview"; s.runScroll = 0; s.screen = "run"; }
    else if (row?.kind === "issue") {
      // The issue page is the hub: prompt, dependencies, runs, and actions.
      s.selectedPacketSlug = row.slug;
      s.packetScroll = 0;
      s.screen = "packet";
    }
    ctx.draw();
    return true;
  }
  if (data === "a") {
    const row = index.selectable[s.runsSel];
    if (row?.kind !== "run") { ctx.notify("select a run to answer"); ctx.draw(); return true; }
    ctx.answerRun(row.run);
    ctx.draw();
    return true;
  }
  if (data === " ") {
    toggleFold(index.selectable[s.runsSel]);
    ctx.draw();
    return true;
  }
  if (data === "n") {
    const row = index.selectable[s.runsSel];
    if (row?.kind === "issue") {
      const agent = row.itemKind === "ideas" ? "research" : "engineer";
      ctx.startNewRun(undefined, repoForRow(row), { agent, item: row.slug });
      ctx.draw();
      return true;
    }
    if (row?.kind === "section" && row.issueKind) {
      const agent = row.issueKind === "ideas" ? "research" : "engineer";
      ctx.startNewRun(undefined, repoForRow(row), {
        agent,
        prompt: row.issueKind === "ideas"
          ? "Pick an idea under issues/ideas/ and turn it into features and bugs."
          : "Pick a feature or bug under issues/features/ or issues/bugs/ and implement it.",
      });
      ctx.draw();
      return true;
    }
    const packet = row?.kind === "run" ? row.run.packetId : undefined;
    ctx.startNewRun(packet, repoForRow(row));
    ctx.draw();
    return true;
  }
  if (data === "N") { ctx.startNewRun(undefined, l.repoRoot); ctx.draw(); return true; }
  if (data === "D") {
    const row = index.selectable[s.runsSel];
    if (row?.kind !== "run") { ctx.notify("select a run to delete"); ctx.draw(); return true; }
    s.deleteRunTarget = row.run;
    s.deleteReturn = "list";
    s.screen = "delete";
    ctx.draw();
    return true;
  }
  if (data === "!") { s.runsAttention = !s.runsAttention; s.runsSel = 0; ctx.draw(); return true; }
  if (data === "g") {
    s.runsGroup = RUN_GROUPS[(RUN_GROUPS.indexOf(s.runsGroup) + 1) % RUN_GROUPS.length]!;
    s.runsSel = 0;
    s.runsScroll = 0;
    ctx.draw();
    return true;
  }
  if (data === "f") {
    s.runsRepoScope = s.runsRepoScope === "all" ? "cwd" : "all";
    s.runsSel = 0;
    s.runsScroll = 0;
    ctx.notify(s.runsRepoScope === "cwd" ? "showing cwd runs only" : "showing runs from all repos");
    ctx.draw();
    return true;
  }
  if (data === "/") { s.searchMode = true; s.searchText = ctx.searchSeed(); ctx.draw(); return true; }
  if (data === "r") { ctx.draw(); return true; }
  ctx.draw();
  return true;
}
