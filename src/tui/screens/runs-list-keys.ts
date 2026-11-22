/**
 * machine_code — runs list keys.
 *
 * Move/fold/open, `n`/`N` new runs, `o` orchestration, `D` delete, `!`
 * attention filter, `g` group cycle, `f` repo scope, `/` search, `a` answer.
 * The index is rebuilt
 * per keypress like the draw path so navigation and rendering agree.
 */
import { layout } from "../../paths.js";
import { listAllRuns } from "../../state/runs.js";
import { buildRunIndex, repoOf, RUN_GROUPS, type RunRow } from "../runs.js";
import { listIssues, type Issue } from "../../plan/issues.js";
import { issueDeleteTarget } from "./delete-keys.js";
import { runItemId } from "../../plan/lifecycle.js";
import type { TuiState } from "../state.js";
import type { KeyServices } from "./keys.js";

export function handleRunsListKeys(s: TuiState, ctx: KeyServices, data: string): boolean {
  const l = layout(ctx.repoRoot);
  const allRuns = listAllRuns(l.home).filter((run) => !s.deletingRuns.has(run.id));
  const scopeFiltered = s.runsRepoScope === "cwd" ? allRuns.filter((run) => run.repoRoot === l.repoRoot) : allRuns;
  const workGroup = s.runsGroup === "all" || s.runsGroup === "category" || s.runsGroup === "deps";
  const issuesByRepo: Record<string, readonly Issue[]> = {};
  for (const root of new Set([l.repoRoot, ...scopeFiltered.map((run) => run.repoRoot)])) {
    issuesByRepo[root] = listIssues(layout(root));
  }
  const index = buildRunIndex({
    runs: scopeFiltered,
    group: s.runsGroup,
    collapsed: s.collapsed,
    text: s.runsText,
    attentionOnly: s.runsAttention,
    preferredRepo: l.repoRoot,
    ...(workGroup ? { issueRepo: l.repoRoot, issuesByRepo } : {}),
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
    // Rows carry their effective collapsed state (default plus overrides),
    // so the override is just the inverse of what is on screen.
    s.collapsed.set(target.id, !target.collapsed);
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
      s.selectedIssueSlug = row.slug;
      s.selectedIssueRepo = repoForRow(row) ?? null;
      s.issueScroll = 0;
      s.screen = "issue";
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
      const agent = row.itemKind === "ideas" ? "architect" : row.itemKind === "references" ? "reference" : "engineer";
      if (row.effective === "done") {
        // A done issue cannot be a run's main item; open the new run page
        // with it pre-selected as a reference issue instead.
        ctx.startNewRun(undefined, repoForRow(row), { agent, references: [row.slug] });
        ctx.draw();
        return true;
      }
      ctx.startNewRun(undefined, repoForRow(row), { agent, item: row.slug });
      ctx.draw();
      return true;
    }
    if (row?.kind === "section" && row.issueKind) {
      const agent = row.issueKind === "ideas" ? "architect" : row.issueKind === "references" ? "reference" : "engineer";
      ctx.startNewRun(undefined, repoForRow(row), {
        agent,
        prompt: row.issueKind === "ideas"
          ? "Pick an idea under .machine_code/issues/ideas/ and turn it into features and bugs."
          : row.issueKind === "references"
            ? "Pick a references issue under .machine_code/issues/references/ and build its store bundle."
            : "Pick a feature or bug under .machine_code/issues/features/ or .machine_code/issues/bugs/ and implement it.",
      });
      ctx.draw();
      return true;
    }
    const item = row?.kind === "run" ? (row.run.itemId ?? row.run.packetId) : undefined;
    ctx.startNewRun(item, repoForRow(row));
    ctx.draw();
    return true;
  }
  if (data === "N") { ctx.startNewRun(undefined, l.repoRoot); ctx.draw(); return true; }
  if (data === "o") {
    // Orchestration is a repo-level control: it opens only from a repo row.
    const row = index.selectable[s.runsSel];
    if (row?.kind !== "repo") { ctx.notify("select a repo to orchestrate"); ctx.draw(); return true; }
    s.orchestrateRepo = row.repoRoot;
    s.orchestrateSel = 0;
    s.orchestrateColon = false;
    s.screen = "orchestrate";
    ctx.draw();
    return true;
  }
  if (data === "I") {
    const row = index.selectable[s.runsSel];
    if (row?.kind === "issue") ctx.startNewIssue(repoForRow(row), row.slug);
    else ctx.startNewIssue(l.repoRoot);
    ctx.draw(); return true;
  }
  if (data === "D") {
    const row = index.selectable[s.runsSel];
    if (!row) return true;
    if (row.kind === "run") {
      s.deleteTarget = { kind: "run", run: row.run };
      s.deleteReturn = "list";
      s.screen = "delete";
      ctx.draw();
      return true;
    }
    // An issue delete goes through the same confirmation page as a run.
    if (row.kind === "issue") {
      const target = issueDeleteTarget(repoForRow(row), row.slug);
      if (!target) {
        ctx.notify(`no issue ${row.slug}`);
        ctx.draw();
        return true;
      }
      s.deleteTarget = target;
      s.deleteReturn = "list";
      s.screen = "delete";
      ctx.draw();
      return true;
    }
    ctx.notify("select a run or issue to delete");
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
