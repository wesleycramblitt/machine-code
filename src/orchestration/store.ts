/**
 * machine_code — orchestrator state store.
 *
 * Repo-level orchestration persists its settings and bookkeeping per repo at
 * `.machine_code/local/orchestrator.json` (`layout(repoRoot).localDir`, which
 * is gitignored — see src/paths.ts). One JSON document:
 *
  *   - `settings` — worker count, model tier (`"paid" | "free" | "local"`: the run
  *     system's values; the TUI labels "paid" as "cloud"), the fallback tier
  *     (`"none"` disables it), and the two min-fit floors on the 4–8.5 / 0.25 ladder.
 *   - `active` — whether the orchestrator is running for this repo.
 *   - `startedRunIds` — ledger of run ids the orchestrator started, so
 *     counters and slot math only count orchestrator-owned runs.
 *
 * Every updater reads the current document from disk, merges its patch into
 * it, and writes the merged result back atomically (writeJsonAtomic) — a
 * settings change, flag flip, or ledger append never clobbers fields it does
 * not touch. Reads never throw: a missing, unreadable, or corrupt file
 * degrades to defaults, field by field where possible.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { FallbackTier } from "../config.js";
import { writeJsonAtomic } from "../state/run-schema.js";

/** Concurrency levels the orchestrator can run. */
export type OrchestratorProcesses = 1 | 2 | 4 | 8;

/** Model tier the run system accepts (`run --tier`, composer). The TUI labels "paid" as "cloud". */
export type OrchestratorTier = "paid" | "free" | "local";

export interface OrchestratorSettings {
  /** Worker processes the orchestrator keeps busy. */
  processes: OrchestratorProcesses;
  /** Tier of models the orchestrator's agents run on. */
  tier: OrchestratorTier;
  /** Fallback tier when tier-one selection finds no eligible model. `"none"` disables it. */
  tier2: FallbackTier;
  /** Minimum model fit an engineer agent must clear to pick up work. */
  engineerMinFit: number;
  /** Minimum model fit an architect agent must clear. */
  architectMinFit: number;
}

export interface OrchestratorState {
  settings: OrchestratorSettings;
  /** Whether the orchestrator is running for this repo. */
  active: boolean;
  /** Run ids the orchestrator started for this repo (append-only ledger). */
  startedRunIds: string[];
}

/** Worker counts the TUI cycles through. */
export const ORCHESTRATOR_PROCESSES: readonly OrchestratorProcesses[] = [1, 2, 4, 8];

/** Min-fit ladder: 4–8.5 in 0.25 steps — the same ladder the new-run page cycles (`NEW_RUN_MIN_FITS`, src/tui.ts:116). */
export const ORCHESTRATOR_MIN_FITS: readonly number[] = Array.from(
  { length: Math.round((8.5 - 4) / 0.25) + 1 },
  (_, i) => 4 + i * 0.25,
);

const DEFAULT_SETTINGS: OrchestratorSettings = {
  processes: 1,
  tier: "paid",
  tier2: "none",
  engineerMinFit: 6,
  architectMinFit: 6,
};

/** Fresh defaults for a repo without (valid) stored state. */
export function defaultOrchestratorState(): OrchestratorState {
  return { settings: { ...DEFAULT_SETTINGS }, active: false, startedRunIds: [] };
}

/** Path of the persisted state document for a repo. */
export function orchestratorStateFile(repo: Layout): string {
  return join(repo.localDir, "orchestrator.json");
}

function isProcesses(value: unknown): value is OrchestratorProcesses {
  return value === 1 || value === 2 || value === 4 || value === 8;
}

function isTier(value: unknown): value is OrchestratorTier {
  return value === "paid" || value === "free" || value === "local";
}

function isTier2(value: unknown): value is FallbackTier {
  return value === "none" || value === "paid" || value === "free" || value === "local";
}

function isMinFit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read the persisted state for a repo. A missing, unreadable, or corrupt
 * file degrades to defaults; a partially valid document keeps the fields
 * that parse and defaults the rest. Never throws.
 */
export function readOrchestratorState(repo: Layout): OrchestratorState {
  try {
    const raw: unknown = JSON.parse(readFileSync(orchestratorStateFile(repo), "utf8"));
    if (typeof raw !== "object" || raw === null) return defaultOrchestratorState();
    const doc = raw as Record<string, unknown>;
    const defaults = defaultOrchestratorState();
    const settings =
      typeof doc.settings === "object" && doc.settings !== null ? (doc.settings as Record<string, unknown>) : {};
    return {
      settings: {
        processes: isProcesses(settings.processes) ? settings.processes : defaults.settings.processes,
        tier: isTier(settings.tier) ? settings.tier : defaults.settings.tier,
        tier2: isTier2(settings.tier2) ? settings.tier2 : defaults.settings.tier2,
        engineerMinFit: isMinFit(settings.engineerMinFit) ? settings.engineerMinFit : defaults.settings.engineerMinFit,
        architectMinFit: isMinFit(settings.architectMinFit)
          ? settings.architectMinFit
          : isMinFit(settings.researchMinFit)
            ? settings.researchMinFit
            : defaults.settings.architectMinFit,
      },
      active: typeof doc.active === "boolean" ? doc.active : defaults.active,
      startedRunIds: Array.isArray(doc.startedRunIds)
        ? doc.startedRunIds.filter((id): id is string => typeof id === "string")
        : defaults.startedRunIds,
    };
  } catch {
    return defaultOrchestratorState();
  }
}

export interface OrchestratorPatch {
  /** Settings fields to change; omitted fields keep their stored value. */
  settings?: Partial<OrchestratorSettings>;
  /** New active flag. */
  active?: boolean;
  /** Run ids to append to the started-run ledger (duplicates ignored). */
  appendRunIds?: string[];
}

/**
 * Merge a patch into the persisted state: read the current document fresh
 * from disk, apply the patch, write the merged result back atomically.
 * Partial updates therefore never clobber fields they do not touch (the
 * merge is whole-document, so concurrent writers are last-writer-wins).
 * Returns the merged state as written.
 */
export function updateOrchestratorState(repo: Layout, patch: OrchestratorPatch): OrchestratorState {
  const current = readOrchestratorState(repo);
  const next: OrchestratorState = {
    settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
    active: patch.active ?? current.active,
    startedRunIds: patch.appendRunIds
      ? [...new Set([...current.startedRunIds, ...patch.appendRunIds])]
      : current.startedRunIds,
  };
  writeJsonAtomic(orchestratorStateFile(repo), next);
  return next;
}
