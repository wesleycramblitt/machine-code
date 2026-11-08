/**
 * machine_code — plan file discovery.
 *
 * Plans are ordinary Markdown files in `plans/` or `.machine_code/plans/`.
 * A configured plan file, when present, is included first.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";

const PLAN_DIRS = [".machine_code/plans", "plans"];

function withinRepo(root: string, path: string): string | null {
  if (path.startsWith("/")) return null;
  const base = resolve(root);
  const abs = resolve(base, path);
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : 1));
  } catch {
    return [];
  }
}

/** Repo-relative plan paths in display/injection order. */
export function discoverPlanFiles(layout: Layout, configured?: string): string[] {  const root = resolve(layout.repoRoot);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    const abs = withinRepo(root, rel);
    if (!abs || !existsSync(abs)) return;
    try {
      if (!statSync(abs).isFile()) return;
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(rel);
  };

  if (configured) add(configured);
  for (const dir of PLAN_DIRS) {
    for (const name of markdownFiles(join(root, dir))) add(join(dir, name));
  }
  return out;
}
