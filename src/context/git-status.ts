/**
 * machine_code — git status snapshot for change detection.
 *
 * `edit` and `write` are the precise path; this is the safety net. It catches
 * deletes, renames, formatters, code generators, and any other command-side
 * mutation. It stores only status codes and file fingerprints, never content.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProcessSupervisor } from "../processes/supervisor.js";

export interface GitStatusEntry {
  code: string;
  mtimeMs: number;
  size: number;
}

function fingerprint(root: string, path: string): { mtimeMs: number; size: number } {
  try {
    const stat = statSync(join(root, path));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: -1 };
  }
}

/** Null means "not a git checkout" or "status failed"; callers fall back. */
export function readGitStatus(
  root: string,
  processes?: ProcessSupervisor,
): Map<string, GitStatusEntry> | null {
  if (!existsSync(join(root, ".git"))) return null;
  let output: string;
  try {
    if (processes) {
      const result = processes.runSync(
        "git",
        ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { cwd: root, timeoutMs: 5_000, origin: "tool", name: "git:status" },
      );
      if (result.status !== 0) return null;
      output = result.stdout;
    } else {
      output = execFileSync(
        "git",
        ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      );
    }
  } catch {
    return null;
  }
  const entries = new Map<string, GitStatusEntry>();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    entries.set(path, { code, ...fingerprint(root, path) });
    if (code.includes("R") || code.includes("C")) {
      const original = tokens[++i];
      if (original) entries.set(original, { code, ...fingerprint(root, original) });
    }
  }
  return entries;
}

/**
 * Recent commit subjects for startup context. Bug reports usually follow
 * recent changes, and a one-line log points the first search at the right
 * files without a history dig. Null outside git or on any failure; callers
 * skip silently. Bounded to roughly one kilobyte.
 */
export function readRecentHistory(root: string, maxCommits = 12, maxChars = 1024): string | null {
  if (!existsSync(join(root, ".git"))) return null;
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["-C", root, "log", `--max-count=${Math.max(1, maxCommits)}`, "--format=%h %ad %s", "--date=short"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
    );
  } catch {
    return null;
  }
  const text = output.trim();
  if (!text) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).replace(/\s+$/, "")}\n…[truncated]`;
}
