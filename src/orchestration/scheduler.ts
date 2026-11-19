/**
 * machine_code — orchestrator scheduler: pure scheduling helpers.
 *
 * Pure functions over data the caller already loaded (issues, run summaries)
 * — no fs access, no run spawning — so the orchestrator loop and tests can
 * compose them freely:
 *
 *   - `orchestratorCounters` — health counters over the orchestrator's
 *     started runs (the caller filters all runs by the persisted
 *     `startedRunIds` ledger first).
 *   - `runnableIssues` — the ordered queue of issues the orchestrator may
 *     dispatch next, honoring kind/status, `depends:`, live runs, and the
 *     no-concurrent-overlapping-files rule.
 *   - `freeSlots` — free worker capacity against the persisted settings.
 *
 * The hard-fail distinction needs no new state: acceptance-gate failures do
 * not end a run (the run keeps working; the issue collects gate-failure
 * notes via `appendIssueGateFailure`), so of the terminal states only
 * `failed` and `blocked` count as hard failures that free a slot.
 */
import type { RunSummary } from "../state/run-schema.js";
import { isActiveStatus } from "../state/run-schema.js";
import type { Issue, IssueKind } from "../plan/issues.js";
import { ENGINEER_WORK_STATUSES } from "../plan/issues.js";
import { runItemId } from "../plan/lifecycle.js";
import { overlapFootprints } from "../plan/overlap.js";
import type { OrchestratorSettings } from "./store.js";

export interface OrchestratorCounters {
  /** Active runs that are not waiting on input (created/running/paused/interrupted). */
  running: number;
  /** Active runs parked in `awaiting_input`. */
  awaiting: number;
  /** Runs that ended in a hard failure (`failed` or `blocked`). */
  failed: number;
}

/** Hard failures: terminal states that are neither a success nor a cancel. */
const RUN_FAILURE_STATES: readonly string[] = ["failed", "blocked"];

/**
 * Count the orchestrator-started runs the caller passes in. `running` holds
 * every active status except `awaiting_input`; `awaiting` holds exactly
 * that; `failed` holds terminal failures only — `completed` and
 * `cancelled` are neither running nor failed.
 */
export function orchestratorCounters(runs: readonly RunSummary[]): OrchestratorCounters {
  const counters: OrchestratorCounters = { running: 0, awaiting: 0, failed: 0 };
  for (const run of runs) {
    if (isActiveStatus(run.status)) {
      if (run.status === "awaiting_input") counters.awaiting += 1;
      else counters.running += 1;
    } else if (RUN_FAILURE_STATES.includes(run.status)) {
      counters.failed += 1;
    }
  }
  return counters;
}

/** Orchestrator dispatch order: bugs, then features, then ideas. */
const KIND_ORDER: Record<IssueKind, number> = { bugs: 0, features: 1, ideas: 2 };

/** Priority weights, the same ladder as the build waves (high, medium, low). */
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * The ordered queue of issues the orchestrator may dispatch next.
 *
 * An issue qualifies when: a feature/bug starts from an
 * `ENGINEER_WORK_STATUSES` status, or an idea is `researched`; every
 * `depends:` slug is satisfied (`done`, or a researched idea — unknown
 * slugs never block, matching `unmetDepends`); no active run is already
 * attached to it; and its `files:` footprint does not overlap a currently
 * running orchestrator issue (the runner refuses concurrent overlapping
 * work).
 *
 * `startedSlugs` names the orchestrator's dispatched issues; only those that
 * still have an active run in `runs` count as running for the footprint
 * rule, so a finished run never blocks re-dispatching.
 */
export function runnableIssues(
  issues: readonly Issue[],
  runs: readonly RunSummary[],
  startedSlugs: readonly string[],
): Issue[] {
  const known = new Set(issues.map((issue) => issue.slug));
  const satisfied = new Set(
    issues
      .filter((issue) => issue.status === "done" || (issue.kind === "ideas" && issue.status === "researched"))
      .map((issue) => issue.slug),
  );
  const activeItems = new Set(
    runs
      // `interrupted` frees its slot (freeSlots) so it must free its issue
      // and footprint here too: no live worker backs it, and keeping it in
      // the set blocks re-dispatch forever after a restart.
      .filter((run) => isActiveStatus(run.status) && run.status !== "interrupted")
      .map((run) => runItemId(run))
      .filter((item): item is string => item !== undefined),
  );
  const runningFootprints = issues
    .filter((issue) => startedSlugs.includes(issue.slug) && activeItems.has(issue.slug))
    .flatMap((issue) => issue.files);
  return issues
    .filter((issue) => {
      if (issue.kind === "ideas") {
        if (issue.status !== "researched") return false;
      } else if (!(ENGINEER_WORK_STATUSES as readonly string[]).includes(issue.status)) {
        return false;
      }
      // `depends:` satisfied exactly like `unmetDepends` (src/tasks/issue.ts:63):
      // the dependency landed (`done`) or is a researched idea; renamed or
      // deleted dependencies must not block work forever.
      if (issue.depends.some((dep) => dep !== issue.slug && known.has(dep) && !satisfied.has(dep))) return false;
      // Already being worked, or its files overlap a running orchestrator issue.
      if (activeItems.has(issue.slug)) return false;
      // A researched idea has no retry ladder: once the orchestrator has
      // started research on it (slug in the dispatch ledger), do not relaunch
      // a duplicate — unless that research never produced a result (it
      // hard-failed or was cancelled), which leaves the idea genuinely
      // unresearched and fit to try again. Features and bugs are untouched:
      // their failed-work statuses legitimately re-dispatch after a run ends.
      if (
        issue.kind === "ideas" &&
        startedSlugs.includes(issue.slug) &&
        !runs.some(
          (run) =>
            runItemId(run) === issue.slug &&
            (RUN_FAILURE_STATES.includes(run.status) || run.status === "cancelled"),
        )
      ) {
        return false;
      }
      return overlapFootprints(issue.files, runningFootprints).length === 0;
    })
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    );
}

/**
 * Free worker capacity: the configured process count minus the orchestrator's
 * active runs (`startedRunIds` ∩ `runs`, active per `isActiveStatus`),
 * clamped at 0. A run holds its slot until it leaves the active states —
 * hard failures (`failed`/`blocked`) and completions free it; acceptance-
 * gate failures inside a live run do not.
 *
 * `interrupted` runs are excluded: after a process restart no live worker
 * backs them, so they must not block new dispatches.
 */
export function freeSlots(
  settings: Pick<OrchestratorSettings, "processes">,
  runs: readonly RunSummary[],
  startedRunIds: readonly string[],
): number {
  const ledger = new Set(startedRunIds);
  const active = runs.filter(
    (run) => ledger.has(run.id) && isActiveStatus(run.status) && run.status !== "interrupted",
  ).length;
  return Math.max(0, settings.processes - active);
}
