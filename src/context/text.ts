/**
 * machine_code — small helpers for reading tool messages and prompts.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export function toolCalls(message: Record<string, unknown>): Map<string, { name: string; args: Record<string, unknown> }> {
  const out = new Map<string, { name: string; args: Record<string, unknown> }>();
  if (!Array.isArray(message.content)) return out;
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall" || typeof b.id !== "string") continue;
    out.set(b.id, {
      name: typeof b.name === "string" ? b.name : "tool",
      args: (b.arguments ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function inline(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** First few useful lines of a read/search result, for the state block. */
export function excerpt(text: string, max = 180): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+:\s?/, "").trim())
    .filter(Boolean);
  if (lines.length > 0 && (/^\[?[^:\]]+:\d+-\d+/.test(lines[0]!) || /^\[.*\]$/.test(lines[0]!))) lines.shift();
  return inline(lines.slice(0, 3).join(" "), max);
}

/** Body of an inspect read for the state block: the note must retain what
 * was read, not just a receipt — the transcript only keeps two steps, so
 * anything older survives only here and in the symbol map (names only).
 * Skips envelope and slice headers, keeps numbered body lines so the model
 * can re-anchor. Generous: the block budget evicts oldest-first. */
export function readExcerpt(text: string, max = 2000): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^<inspect query=/.test(line) && !/^<\/inspect>$/.test(line))
    .filter((line) => !/^### .+?: \d+-\d+ of \d+ lines/.test(line.trim()))
    .filter((line) => !/^path: .*\[match: path\]$/.test(line.trim()));
  const joined = lines.join("\n").trim();
  return joined.length <= max ? joined : `${joined.slice(0, Math.max(0, max - 1))}…`;
}

export function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** The line range an edit wrote, when the replacement is unique in the file. */
export function editRange(repoRoot: string | undefined, path: string, newText: string): [number, number] | undefined {
  if (!repoRoot || newText.length === 0) return undefined;
  try {
    const abs = isAbsolute(path) ? path : join(repoRoot, path);
    const after = readFileSync(abs, "utf8");
    const first = after.indexOf(newText);
    if (first < 0) return undefined;
    if (after.indexOf(newText, first + 1) >= 0) return undefined;
    const start = after.slice(0, first).split("\n").length;
    const end = start + Math.max(0, newText.split("\n").length - 1);
    return [start, end];
  } catch {
    return undefined;
  }
}
