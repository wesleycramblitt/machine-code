/**
 * machine_code — bounded change digest for semantic map refreshes.
 *
 * The semantic model does not receive the changing model's transcript. It gets
 * a small, durable record per landed edit: path, turn, actor/model, and the
 * edit intent. This is enough to update module semantics without replaying
 * context.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SemanticChange {
  t: string;
  runId: string;
  turn: number;
  agent: string;
  model?: string;
  path: string;
  tool: string;
  /** One-line edit intent: old -> new, or write summary. */
  detail: string;
}

const MAX_ENTRIES = 120;
const MAX_BYTES = 32 * 1024;
const MAX_DETAIL = 400;

function cacheDir(root: string): string {
  return join(root, ".machine_code", "local", "cache", "map");
}

export function semanticChangesPath(root: string): string {
  return join(cacheDir(root), "changes.jsonl");
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function trim(file: string): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length <= MAX_ENTRIES && Buffer.byteLength(lines.join("\n"), "utf8") <= MAX_BYTES) return;
  let kept = lines.slice(-MAX_ENTRIES);
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > MAX_BYTES) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 4)));
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${kept.join("\n")}\n`, "utf8");
  renameSync(tmp, file);
}

/** Append one landed change. Never throws into the run path. */
export function recordSemanticChange(
  root: string,
  change: Omit<SemanticChange, "t" | "detail"> & { t?: string; detail: string },
): void {
  if (!change.path) return;
  try {
    const file = semanticChangesPath(root);
    mkdirSync(dirname(file), { recursive: true });
    const entry: SemanticChange = {
      t: change.t ?? new Date().toISOString(),
      runId: clip(change.runId, 80),
      turn: Math.max(0, Math.floor(change.turn)),
      agent: clip(change.agent || "unknown", 40),
      ...(change.model ? { model: clip(change.model, 100) } : {}),
      path: clip(change.path, 300),
      tool: clip(change.tool || "edit", 20),
      detail: clip(change.detail, MAX_DETAIL),
    };
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    trim(file);
  } catch {
    // Best effort: a failed digest must not break a run.
  }
}

/** Most recent changes, optionally restricted to paths. */
export function readSemanticChanges(
  root: string,
  paths?: readonly string[],
  limit = 20,
): SemanticChange[] {
  const file = semanticChangesPath(root);
  if (!existsSync(file)) return [];
  const wanted = paths && paths.length > 0 ? new Set(paths) : null;
  const out: SemanticChange[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SemanticChange;
      if (typeof entry.path !== "string" || typeof entry.detail !== "string") continue;
      if (wanted && !wanted.has(entry.path)) continue;
      out.push(entry);
    } catch {
      // Ignore malformed historical lines.
    }
  }
  return out.slice(-Math.max(1, Math.floor(limit)));
}
