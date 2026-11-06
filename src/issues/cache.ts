/**
 * machine_code — issue cache for the TUI.
 *
 * The TUI must never block on gh. A background refresh writes this file; the
 * draw path only reads it. Stale data is kept on failure (with the age shown).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { Issue, IssueRef } from "../issues/provider.js";
import { writeJsonAtomic } from "../state/run-schema.js";

export interface IssueCacheFile {
  schemaVersion: 1;
  repo: string;
  fetchedAt: string;
  issues: Issue[];
}

export function issueCachePath(layout: Layout): string {
  return join(layout.localDir, "cache", "issues.json");
}

export function issueKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

function tombstonesPath(layout: Layout): string {
  return join(layout.localDir, "cache", "deleted-issues.json");
}

export function readTombstones(layout: Layout): Set<string> {
  const file = tombstonesPath(layout);
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { deleted?: unknown };
    return new Set(Array.isArray(raw.deleted) ? raw.deleted.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function addTombstones(layout: Layout, refs: Iterable<IssueRef>): void {
  const deleted = readTombstones(layout);
  for (const ref of refs) deleted.add(issueKey(ref));
  writeJsonAtomic(tombstonesPath(layout), { deleted: [...deleted].sort() });
}

export function removeTombstones(layout: Layout, refs: Iterable<IssueRef>): void {
  const deleted = readTombstones(layout);
  for (const ref of refs) deleted.delete(issueKey(ref));
  writeJsonAtomic(tombstonesPath(layout), { deleted: [...deleted].sort() });
}

/**
 * Self-healing tombstones: drop entries the provider still lists. A tombstone
 * means "a delete was requested"; if the provider still returns the issue and
 * the caller confirms no delete is in flight, the delete never landed and the
 * issue must become visible again instead of staying hidden forever.
 * Returns the cleared keys.
 */
export function reconcileTombstones(
  layout: Layout,
  listed: readonly IssueRef[],
  isInFlight: (key: string) => boolean,
): string[] {
  const tombstoned = readTombstones(layout);
  if (tombstoned.size === 0) return [];
  const cleared: string[] = [];
  for (const ref of listed) {
    const key = issueKey(ref);
    if (tombstoned.has(key) && !isInFlight(key)) {
      tombstoned.delete(key);
      cleared.push(key);
    }
  }
  if (cleared.length > 0) writeJsonAtomic(tombstonesPath(layout), { deleted: [...tombstoned].sort() });
  return cleared;
}

export function readIssueCache(layout: Layout): IssueCacheFile | null {
  const file = issueCachePath(layout);
  if (!existsSync(file)) return null;
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as IssueCacheFile;
    if (!cache || !Array.isArray(cache.issues)) return null;
    const deleted = readTombstones(layout);
    return deleted.size > 0
      ? { ...cache, issues: cache.issues.filter((issue) => !deleted.has(issueKey(issue.ref))) }
      : cache;
  } catch {
    return null;
  }
}

export function writeIssueCache(layout: Layout, repo: string, issues: Issue[]): IssueCacheFile {
  const deleted = readTombstones(layout);
  const cache: IssueCacheFile = {
    schemaVersion: 1,
    repo,
    fetchedAt: new Date().toISOString(),
    issues: deleted.size > 0 ? issues.filter((issue) => !deleted.has(issueKey(issue.ref))) : issues,
  };
  writeJsonAtomic(issueCachePath(layout), cache);
  return cache;
}

export function cacheFresh(cache: IssueCacheFile | null, ttlMs: number, now = Date.now()): boolean {
  if (!cache) return false;
  const fetched = new Date(cache.fetchedAt).getTime();
  return Number.isFinite(fetched) && now - fetched <= ttlMs;
}
