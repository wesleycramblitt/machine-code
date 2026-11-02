/**
 * machine_code — ensure the semantic map for a run.
 *
 * Best-effort and bounded: one model call per refresh, only when the map is
 * stale or a dirty path exists. Failure leaves the deterministic map usable.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPolicy, MachineConfig } from "../config.js";
import type { CatalogueRow } from "../catalogue/types.js";
import { estimateCallCost } from "../catalogue/scoring.js";
import type { AvailabilityState } from "../availability.js";
import type { MutableModels } from "../models.js";
import { pick, providerMultiplier } from "../select.js";
import { appendSpendRecord } from "../spend.js";
import type { RepoMap } from "./deterministic.js";
import {
  buildSemanticTask,
  isSemanticFresh,
  loadSemantic,
  mergeSemantic,
  readSemanticDirty,
  renderSemanticIndex,
  runSemanticModel,
  type SemanticMap,
} from "./semantic.js";

function lockPath(root: string): string {
  return join(root, ".machine_code", "local", "cache", "map", "semantic.lock");
}

function acquireLock(root: string): boolean {
  const file = lockPath(root);
  if (existsSync(file)) {
    try {
      if (Date.now() - statSync(file).mtimeMs < 5 * 60_000) return false;
    } catch {
      // fall through and replace a stale lock
    }
  }
  mkdirSync(join(root, ".machine_code", "local", "cache", "map"), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  return true;
}

function releaseLock(root: string): void {
  try { rmSync(lockPath(root), { force: true }); } catch { /* best effort */ }
}

interface EventSink {
  event(type: string, data?: Record<string, unknown>): void;
}

export interface EnsureSemanticInput {
  root: string;
  map: RepoMap;
  models: MutableModels;
  catalogue: readonly CatalogueRow[];
  configuredProviders: ReadonlySet<string>;
  fundedProviders?: ReadonlySet<string>;
  policy: AgentPolicy;
  machine: MachineConfig;
  availability?: AvailabilityState;
  home: string;
  runId: string;
  recorder: EventSink;
  signal?: AbortSignal;
  /** Explicit CLI refresh: ignore freshness and the manual policy. */
  force?: boolean;
}

export async function ensureSemanticMap(input: EnsureSemanticInput): Promise<SemanticMap | null> {
  if (!input.machine.map.enabled || !input.machine.map.semantic) return null;
  const existing = loadSemantic(input.root);
  const dirty = readSemanticDirty(input.root);
  const refresh = input.machine.map.refresh;
  if (!input.force && isSemanticFresh(existing, input.map, dirty) && refresh !== "always") {
    input.recorder.event("map_semantic", { ok: true, cached: true, modules: Object.keys(existing?.modules ?? {}).length });
    return existing;
  }
  if (!input.force && refresh === "manual") {
    input.recorder.event("map_semantic", {
      ok: true,
      cached: true,
      skipped: "manual refresh",
      dirty: dirty.length,
    });
    return existing;
  }

  if (!acquireLock(input.root)) {
    input.recorder.event("map_semantic", { ok: true, cached: true, skipped: "semantic refresh already running", dirty: dirty.length });
    return existing;
  }
  try {
  const task = buildSemanticTask({ root: input.root, map: input.map, existing, dirtyPaths: dirty });
  if (task.prompt.length === 0) return existing;
  const picked = pick({
    agent: "architect",
    policy: input.policy,
    machine: input.machine,
    catalogue: input.catalogue,
    configuredProviders: input.configuredProviders,
    fundedProviders: input.fundedProviders,
    availability: input.availability,
    contextChars: task.prompt.length,
    requireModel: input.machine.map.semanticModel,
  });
  if ("error" in picked) {
    input.recorder.event("map_semantic", { ok: false, error: picked.error, dirty: dirty.length });
    return existing;
  }
  const row = picked.selected;
  const model = input.models.getModel(row.providerID, row.id);
  if (!model) {
    input.recorder.event("map_semantic", { ok: false, error: `runtime model missing: ${row.key}`, dirty: dirty.length });
    return existing;
  }

  const started = Date.now();
  try {
    const result = await runSemanticModel(input.models, model, task.prompt, input.signal);
    const merged = mergeSemantic({
      root: input.root,
      map: input.map,
      existing,
      modules: task.modules,
      model: row.key,
      response: result.text,
      dirtyPaths: dirty,
    });
    if (!merged) {
      input.recorder.event("map_semantic", {
        ok: false,
        error: "semantic response was empty or invalid",
        model: row.key,
        durationMs: Date.now() - started,
      });
      return existing;
    }
    const usage = result.usage;
    const actual = usage?.cost?.total;
    const actualCost = typeof actual === "number" && Number.isFinite(actual) ? actual : null;
    const estimated = estimateCallCost(
      row.pricing,
      usage?.input ?? 0,
      Math.max(usage?.output ?? 0, input.policy.expectedOutputTokens),
    ) * providerMultiplier(input.machine, row.providerID);
    const bytes = Buffer.byteLength(JSON.stringify(merged), "utf8");
    input.recorder.event("map_semantic", {
      ok: true,
      model: row.key,
      modules: Object.keys(merged.modules).length,
      refreshed: task.modules.length,
      bytes,
      usage: usage
        ? {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
          }
        : undefined,
      cost: actualCost,
      estimated,
      durationMs: Date.now() - started,
    });
    if (usage) {
      try {
        appendSpendRecord(input.home, {
          id: randomUUID(),
          t: new Date().toISOString(),
          repoRoot: input.root,
          runId: input.runId,
          agent: "map",
          provider: row.providerID,
          model: row.id,
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
          },
          cost: { actual: actualCost, estimated },
          stopReason: result.stopReason ?? "stop",
        });
      } catch {
        // ledger failure must not break the run
      }
    }
    return merged;
  } catch (error) {
    input.recorder.event("map_semantic", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      model: row.key,
      durationMs: Date.now() - started,
    });
    return existing;
  }
  } catch (error) {
    input.recorder.event("map_semantic", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return existing;
  } finally {
    releaseLock(input.root);
  }
}

export { renderSemanticIndex };
