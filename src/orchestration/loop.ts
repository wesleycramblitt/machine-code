/**
 * machine_code — orchestrator loop.
 *
 * The live half of the orchestration page: while a repo's store flag is
 * `active`, a ~5s tick keeps `settings.processes` workers busy on the repo's
 * runnable issues (the queue and slot math live in
 * src/orchestration/scheduler.ts). The tick re-reads the store and disk every
 * pass, so setting edits (processes, tier, min-fit floors) reach the next
 * started run without a restart, and new or unblocked issues join the queue
 * on their own.
 *
 * Dispatch bookkeeping has two steps, because `launch()` spawns a detached
 * child that creates its own run record a moment later:
 *
 *   1. spawn → remember the issue slug in an in-memory pending map, so the
 *      same slug is never dispatched twice while the record is missing;
 *   2. on a later tick, match the run record back by `--item` slug (and a
 *      `startedAt` near the dispatch time) and append its id to the store's
 *      `startedRunIds` ledger — the field slot math and the orchestration
 *      counters read. A record that never appears ages out and frees the
 *      slug for a re-dispatch.
 *
 * Stop is passive: clearing the store flag ends the ticks, and running
 * children are ordinary tracked `run` processes that finish on their own.
 */
import { layout } from "../paths.js";
import { listIssues } from "../plan/issues.js";
import type { Issue } from "../plan/issues.js";
import { agentForIssue, runItemId } from "../plan/lifecycle.js";
import { overlapFootprints } from "../plan/overlap.js";
import { listAllRuns } from "../state/runs.js";
import { freeSlots, runnableIssues } from "./scheduler.js";
import { readOrchestratorState, updateOrchestratorState, type OrchestratorSettings } from "./store.js";

/** Tick cadence: a fast beat beside the TUI's 1s repaint interval. */
export const ORCHESTRATOR_TICK_MS = 5_000;

/**
 * How long a spawned child may lack a run record before its dispatch is
 * given up (crashed start) and the slug becomes dispatchable again. Well
 * above the 45s worktree-creation window (RUN_START_TIMEOUT_MS).
 */
const PENDING_TIMEOUT_MS = 90_000;

/** Clock-skew allowance when matching a fresh run record to its dispatch. */
const PENDING_SKEW_MS = 10_000;

export interface OrchestratorServices {
  /** Machine home — scopes `listAllRuns` (reconciled, all projects). */
  home: string;
  /** Detached-child launcher (the TUI's `launch()`); false on spawn failure. */
  launch: (args: string[], repoRoot: string) => boolean;
  /** Optional UI hook, called when a tick started runs or adopted ledger ids. */
  changed?: () => void;
}

export interface OrchestratorLoop {
  /**
   * Schedule a repo: set the persisted `active` flag and start ticking. The
   * Start press, or a persisted-active repo at TUI open.
   */
  watch(repoRoot: string): void;
  /** Stop scheduling and clear the persisted flag (the Stop press); running children keep running. */
  drop(repoRoot: string): void;
  /** Stop the background timer. */
  dispose(): void;
}

/** Min-fit floor for the agent role an issue dispatches. */
function minFitForRole(settings: OrchestratorSettings, issue: Issue): number {
  return issue.kind === "ideas" || issue.kind === "references" ? settings.architectMinFit : settings.engineerMinFit;
}

function startedMs(run: { startedAt: string }): number {
  const time = Date.parse(run.startedAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Create the loop for one TUI process. Everything beyond the persisted store
 * is in-memory only: the watched-repo set and the pending-dispatch map, both
 * meaningless once the process ends (the store's `active` flag decides what
 * the next session resumes).
 */
export function createOrchestratorLoop(services: OrchestratorServices): OrchestratorLoop {
  const watched = new Set<string>();
  /** repoRoot → dispatched slug → wall-clock dispatch time, until the record exists. */
  const pending = new Map<string, Map<string, number>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  const tickRepo = (repoRoot: string): void => {
    try {
      const repo = layout(repoRoot);
      const state = readOrchestratorState(repo);
      // The store flag is the single source of truth: Stop clears it, and a
      // repo whose flag is gone prunes itself so the timer can idle out.
      if (!state.active) {
        watched.delete(repoRoot);
        return;
      }
      const now = Date.now();
      const runs = listAllRuns(services.home).filter((run) => run.repoRoot === repoRoot);
      const ledger = new Set(state.startedRunIds);
      let pendingSlugs = pending.get(repoRoot);
      if (!pendingSlugs) {
        pendingSlugs = new Map();
        pending.set(repoRoot, pendingSlugs);
      }

      // Adopt spawned children: a run record attached to a pending slug that
      // appeared near the dispatch time joins the ledger and releases the
      // in-flight guard.
      const adopted: string[] = [];
      for (const [slug, dispatchedAt] of [...pendingSlugs]) {
        if (now - dispatchedAt > PENDING_TIMEOUT_MS) {
          pendingSlugs.delete(slug);
          continue;
        }
        const record = runs.find(
          (run) => !ledger.has(run.id) && runItemId(run) === slug && startedMs(run) >= dispatchedAt - PENDING_SKEW_MS,
        );
        if (record) {
          adopted.push(record.id);
          pendingSlugs.delete(slug);
        }
      }
      if (adopted.length > 0) updateOrchestratorState(repo, { appendRunIds: adopted });
      for (const id of adopted) ledger.add(id);

      // In-flight dispatches count as started (footprint rule, queue dedup)
      // and hold a slot until their run record lands.
      const startedSlugs = new Set<string>(pendingSlugs.keys());
      for (const run of runs) {
        if (!ledger.has(run.id)) continue;
        const slug = runItemId(run);
        if (slug) startedSlugs.add(slug);
      }
      const startedRunIds = [...ledger];
      // Awaiting runs keep their issue (the human answers through the normal
      // flow) but release the worker slot; the orchestrator starts other work
      // while the question is open.
      const slotRuns = runs.filter((run) => run.status !== "awaiting_input");
      const slots = Math.max(0, freeSlots(state.settings, slotRuns, startedRunIds) - pendingSlugs.size);
      const queue = runnableIssues(listIssues(repo), runs, [...startedSlugs]).filter(
        (issue) => !pendingSlugs.has(issue.slug),
      );

      // Same-tick footprint guard: runnableIssues excludes issues that overlap
      // work already running from an earlier tick, but a freshly spawned issue
      // has no run record yet, so its footprint is invisible to the rest of the
      // batch. Accumulate each dispatch's files here and skip issues that
      // overlap one launched earlier in this pass, so a batch never over-starts
      // on the same files — the runner would block the second run, wasting a
      // slot and dropping that issue from the queue until it clears.
      const launchedFiles = new Set<string>();
      let started = 0;
      for (const issue of queue) {
        if (started >= slots) break;
        if (overlapFootprints(issue.files, [...launchedFiles]).length > 0) continue;
        const args = [
          "run",
          "--agent", agentForIssue(issue),
          "--tier", state.settings.tier,
          ...(state.settings.tier2 !== "none" ? ["--tier2", state.settings.tier2] : []),
          "--min-fit", String(minFitForRole(state.settings, issue)),
          "--item", issue.slug,
        ];
        // Spawn failure: leave the slot to the next tick instead of burning
        // the remaining ones on the same error.
        if (!services.launch(args, repoRoot)) break;
        pendingSlugs.set(issue.slug, now);
        for (const file of issue.files) launchedFiles.add(file);
        started += 1;
      }
      if (pendingSlugs.size === 0) pending.delete(repoRoot);
      if (started > 0 || adopted.length > 0) services.changed?.();
    } catch {
      // A bad tick (unreadable state, transient fs error) must not kill the
      // interval; the next pass re-reads everything.
    }
  };

  const tickAll = (): void => {
    for (const repoRoot of [...watched]) tickRepo(repoRoot);
  };

  return {
    watch(repoRoot: string): void {
      if (watched.has(repoRoot)) return;
      // The loop owns the flag: Start sets it, Stop clears it. Both ticks and
      // the runs-page badge read it back from the store, and it survives
      // restarts so a persisted-active repo resumes scheduling on open.
      updateOrchestratorState(layout(repoRoot), { active: true });
      watched.add(repoRoot);
      if (!timer) timer = setInterval(tickAll, ORCHESTRATOR_TICK_MS);
      tickRepo(repoRoot);
    },
    drop(repoRoot: string): void {
      updateOrchestratorState(layout(repoRoot), { active: false });
      watched.delete(repoRoot);
      if (watched.size === 0) stopTimer();
    },
    dispose(): void {
      watched.clear();
      stopTimer();
    },
  };
}
