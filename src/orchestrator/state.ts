/**
 * machine_code — orchestration ledger and lease.
 *
 * The issue graph is the project model. This module only keeps the small
 * operational state needed to avoid duplicate schedulers and to remember a
 * checkpoint or stop reason. It never stores task prose.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import { writeJsonAtomic } from "../state/run-schema.js";
import type { IssueRef } from "../issues/provider.js";
import type { OrchestrationScope } from "./scheduler.js";

export interface OrchestrationLease {
  owner: string;
  pid: number;
  until: number;
}

export interface OrchestrationState {
  id: string;
  scope: OrchestrationScope;
  scopeRef?: IssueRef;
  startedAt: string;
  lastTickAt?: string;
  checkpoint?: string;
  stopReason?: string;
  pid?: number;
  lease?: OrchestrationLease;
  /** Task numbers whose before-build packet a human approved. */
  approvedPackets?: number[];
  /** Task numbers whose completed result a human approved. */
  approvedResults?: number[];
}

export function orchestrationsDir(layout: Layout): string {
  return join(layout.localDir, "orchestrations");
}

export function orchestrationPath(layout: Layout, id: string): string {
  return join(orchestrationsDir(layout), `${id}.json`);
}

export function orchestrationLeasePath(layout: Layout, id: string): string {
  return join(orchestrationsDir(layout), `${id}.lock`);
}

export function orchestrationEventsPath(layout: Layout, id: string): string {
  return join(orchestrationsDir(layout), `${id}.events.jsonl`);
}

function newId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `orch-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createOrchestration(
  layout: Layout,
  scope: OrchestrationScope,
  scopeRef?: IssueRef,
): OrchestrationState {
  const state: OrchestrationState = {
    id: newId(),
    scope,
    ...(scopeRef ? { scopeRef } : {}),
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(orchestrationPath(layout, state.id), state);
  writeFileSync(orchestrationEventsPath(layout, state.id), "", "utf8");
  return state;
}

export function readOrchestration(layout: Layout, id: string): OrchestrationState | null {
  const file = orchestrationPath(layout, id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OrchestrationState;
  } catch {
    return null;
  }
}

export function listOrchestrations(layout: Layout): OrchestrationState[] {
  const dir = orchestrationsDir(layout);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readOrchestration(layout, name.slice(0, -5)))
    .filter((state): state is OrchestrationState => state !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function updateOrchestration(
  layout: Layout,
  id: string,
  patch: Partial<Omit<OrchestrationState, "id">>,
): OrchestrationState | null {
  const current = readOrchestration(layout, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  writeJsonAtomic(orchestrationPath(layout, id), next);
  return next;
}

/** Exclusive lease. A non-expired lease owned by another process wins. */
export function acquireLease(
  layout: Layout,
  id: string,
  owner: string,
  ttlMs = 60_000,
  now = Date.now(),
): boolean {
  const file = orchestrationLeasePath(layout, id);
  const lease: OrchestrationLease = { owner, pid: process.pid, until: now + ttlMs };
  try {
    writeFileSync(file, JSON.stringify(lease) + "\n", { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    const current = readLease(layout, id);
    if (current && current.until > now && current.owner !== owner) return false;
    try {
      rmSync(file, { force: true });
      writeFileSync(file, JSON.stringify(lease) + "\n", { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function readLease(layout: Layout, id: string): OrchestrationLease | null {
  const file = orchestrationLeasePath(layout, id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OrchestrationLease;
  } catch {
    return null;
  }
}

export function renewLease(layout: Layout, id: string, owner: string, ttlMs = 60_000, now = Date.now()): boolean {
  const current = readLease(layout, id);
  if (!current || current.owner !== owner) return false;
  writeFileSync(orchestrationLeasePath(layout, id), JSON.stringify({ ...current, until: now + ttlMs }) + "\n", "utf8");
  return true;
}

export function releaseLease(layout: Layout, id: string, owner?: string): void {
  const current = readLease(layout, id);
  if (owner && current?.owner !== owner) return;
  rmSync(orchestrationLeasePath(layout, id), { force: true });
}
