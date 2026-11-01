/**
 * machine_code — issue cache for the TUI.
 *
 * The TUI must never block on gh. A background refresh writes this file; the
 * draw path only reads it. Stale data is kept on failure (with the age shown).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { Issue } from "../issues/provider.js";
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

export function readIssueCache(layout: Layout): IssueCacheFile | null {
  const file = issueCachePath(layout);
  if (!existsSync(file)) return null;
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as IssueCacheFile;
    if (!cache || !Array.isArray(cache.issues)) return null;
    return cache;
  } catch {
    return null;
  }
}

export function writeIssueCache(layout: Layout, repo: string, issues: Issue[]): IssueCacheFile {
  const cache: IssueCacheFile = {
    schemaVersion: 1,
    repo,
    fetchedAt: new Date().toISOString(),
    issues,
  };
  writeJsonAtomic(issueCachePath(layout), cache);
  return cache;
}

export function cacheFresh(cache: IssueCacheFile | null, ttlMs: number, now = Date.now()): boolean {
  if (!cache) return false;
  const fetched = new Date(cache.fetchedAt).getTime();
  return Number.isFinite(fetched) && now - fetched <= ttlMs;
}
