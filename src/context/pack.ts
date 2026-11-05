/**
 * machine_code — task context pack.
 *
 * The pack is the task-specific half of the prompt. It is built once from the
 * task, plan, repository map, commands, and artifacts, then rendered to the
 * selected model's budget. The always-on overview (task packet, knowledge,
 * repo map, semantic index) stays outside the pack.
 *
 * The pack replaces file paging with symbol-aware context: small files are
 * included whole, large files get an outline plus the bodies of the symbols
 * the task and plan name.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";
import type { MapFile, MapSymbol } from "../map/deterministic.js";
import { renderOutline } from "../map/deterministic.js";
import { documentSections, sectionTitle } from "../map/sections.js";
import { artifactSummary, listArtifacts } from "../artifacts/registry.js";
import { extractTaskPaths, inferPreloadFiles } from "./preload.js";
import { TOOL_GUIDE } from "../tools/policy.js";

export type PackKind =
  | "file"
  | "test"
  | "symbol"
  | "outline"
  | "dependency"
  | "gate"
  | "command"
  | "artifact"
  | "guide"
  | "section";

export interface PackItem {
  kind: PackKind;
  ref: string;
  body: string;
  /** Smaller substitute when the full body does not fit (outline or tail). */
  fallback?: string;
  hash: string;
  chars: number;
  tokens: number;
  /** Lower renders first. */
  order: number;
  reason: string;
}

export interface ContextPack {
  items: PackItem[];
  chars: number;
  tokens: number;
  files: string[];
}

export interface BuildPackInput {
  root: string;
  layout?: Layout;
  request: string;
  /** Task or packet block, when available. */
  taskText?: string;
  /** Active plan/decision text. */
  planText?: string;
  /** Repository map files for the tool root. */
  mapFiles: readonly MapFile[];
  commands?: ReadonlyMap<string, { description: string; readonly: boolean }>;
  /** Model budget for the rendered pack, in characters. */
  budgetChars: number;
  /** Maximum files to consider before budget fitting. */
  maxFiles?: number;
}

export interface RenderPackOptions {
  maxChars: number;
  /** Cap one item so a huge file cannot crowd out the rest. */
  perItemChars?: number;
}

export interface RenderedPack {
  text: string;
  chars: number;
  tokens: number;
  included: number;
  omitted: Array<{ ref: string; reason: string }>;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "when", "then",
  "must", "should", "would", "could", "have", "has", "had", "are", "was", "were",
  "will", "shall", "may", "can", "not", "only", "also", "each", "after", "before",
  "test", "tests", "file", "files", "code", "task", "run", "runs", "add", "use",
  "using", "make", "change", "changes", "update", "new", "line", "lines", "path",
]);

/** Tokens too common to identify a target symbol on their own. */
const GENERIC_SYMBOL_WORDS = new Set([
  "model", "models", "context", "config", "data", "agent", "agents", "current",
  "client", "value", "index", "file", "files", "line", "http", "json", "read",
  "write", "search", "command", "string", "number", "object", "error", "result",
  "name", "path", "type", "types", "test", "tests", "main", "function", "const",
  "class", "interface", "bool", "boolean", "null", "true", "false", "size",
  "bytes", "chars", "hash", "rows", "row", "list", "map", "set", "get", "add",
  "run", "runs", "tool", "tools", "smoke", "call", "calls", "live", "bounded",
  "native", "required", "failure", "success", "time", "timeout", "hourly",
  "cap", "flag", "flags", "field", "fields", "view", "show", "update",
  "change", "changes", "edit", "current", "default", "source", "target",
]);

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function tokenCount(chars: number): number {
  return Math.ceil(chars / 4);
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Keywords from the task and plan that can name a symbol. */
export function symbolKeywords(...texts: Array<string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      out.add(word);
    }
  }
  return out;
}

function symbolScore(symbol: MapSymbol, keywords: ReadonlySet<string>): number {
  const name = symbol.name.toLowerCase();
  if (name.length < 4) return 0;
  let score = 0;
  for (const word of keywords) {
    if (word.length < 4) continue;
    if (name === word) return 100;
    if (GENERIC_SYMBOL_WORDS.has(word) || word.length < 5) continue;
    if (name.includes(word)) score = Math.max(score, 10 + word.length);
    else if (word.includes(name)) score = Math.max(score, 5 + name.length);
  }
  return score;
}

function numbered(lines: readonly string[], start: number, end: number): string {
  const from = Math.max(1, start);
  const to = Math.min(lines.length, Math.max(from, end));
  const out: string[] = [];
  for (let line = from; line <= to; line += 1) {
    out.push(`${line}: ${lines[line - 1] ?? ""}`);
  }
  return out.join("\n");
}

function sectionFor(text: string, section: string, path?: string): { start: number; end: number; title: string } | null {
  const headings = documentSections(text, path);
  const needle = section.toLowerCase();
  const index = headings.findIndex((heading) => {
    const title = sectionTitle(heading.text).toLowerCase();
    return title === needle || title.includes(needle) || heading.text.toLowerCase().includes(needle);
  });
  if (index < 0) return null;
  const heading = headings[index]!;
  const next = headings[index + 1];
  return {
    start: heading.line,
    end: next ? Math.max(heading.line, next.line - 1) : text.split("\n").length,
    title: sectionTitle(heading.text) || heading.text,
  };
}

function packItem(
  kind: PackKind,
  ref: string,
  body: string,
  order: number,
  reason: string,
): PackItem {
  const chars = body.length;
  return { kind, ref, body, hash: hash(body).slice(0, 16), chars, tokens: tokenCount(chars), order, reason };
}

/**
 * Build the task-specific pack. This does not clip to the final budget; the
 * renderer fits it to the selected model. File reads are capped so a giant
 * file becomes an outline plus symbol bodies.
 */
export function buildTaskPack(input: BuildPackInput): ContextPack {
  const requestText = `${input.request}\n${input.taskText ?? ""}`;
  const planText = input.planText ?? "";
  const keywords = symbolKeywords(input.request, input.taskText, planText);
  const maxFiles = Math.max(1, input.maxFiles ?? 16);
  const byPath = new Map(input.mapFiles.map((file) => [file.path, file] as const));

  const explicit = extractTaskPaths(input.root, requestText);
  const planPaths = extractTaskPaths(input.root, planText);
  const preload = inferPreloadFiles(input.root, requestText, maxFiles);
  const seeds = unique([...explicit, ...planPaths, ...preload]).slice(0, maxFiles);
  const explicitFiles = new Set([...explicit, ...planPaths]);

  const order: string[] = [];
  const push = (path: string): void => {
    if (!order.includes(path)) order.push(path);
  };
  for (const path of seeds) push(path);

  // One-hop dependency expansion: imports are the code the target needs.
  for (const path of seeds) {
    const file = byPath.get(path);
    for (const dependency of file?.imports ?? []) {
      if (byPath.has(dependency)) push(dependency);
    }
  }

  // Reverse dependencies: the call sites and wiring the change must not break.
  if (order.length < maxFiles) {
    const wanted = new Set(order);
    for (const file of input.mapFiles) {
      if (order.length >= maxFiles) break;
      if (wanted.has(file.path)) continue;
      if ((file.imports ?? []).some((dependency) => wanted.has(dependency))) push(file.path);
    }
  }

  const budgetForFullFile = Math.max(12_000, Math.min(120_000, Math.floor(input.budgetChars / 3)));
  const items: PackItem[] = [];
  const seenHash = new Set<string>();
  const add = (item: PackItem): void => {
    if (seenHash.has(item.hash)) return;
    seenHash.add(item.hash);
    items.push(item);
  };

  for (const path of order.slice(0, maxFiles)) {
    const file = byPath.get(path);
    const absolute = join(input.root, path);
    if (!existsSync(absolute)) continue;
    const text = readText(absolute);
    if (text === null) continue;
    const isTest = /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[^.]+$/.test(path);
    const isExplicit = explicitFiles.has(path);
    const baseOrder = isTest ? 11 : isExplicit ? 10 : 20;
    const reason = isTest
      ? "task test file"
      : explicit.includes(path)
        ? "task file"
        : planPaths.includes(path)
          ? "plan file"
          : "one-hop dependency";

    // Task files and tests get the most room. Dependencies are included whole
    // only when they are small; otherwise their outline is enough to navigate.
    const fullCap = isTest ? 200_000 : isExplicit ? budgetForFullFile : 8_000;
    const lines = text.split("\n");
    if (text.length <= fullCap) {
      const item = packItem(isTest ? "test" : isExplicit ? "file" : "dependency", path, text, baseOrder, reason);
      if (isTest) {
        const start = Math.max(1, lines.length - 59);
        item.fallback = numbered(lines, start, lines.length);
      } else if (file?.symbols?.length) {
        item.fallback = renderOutline(file);
      }
      add(item);
      continue;
    }

    const outline = file ? renderOutline(file) : `${path} (${lines.length} lines)`;
    add(packItem("outline", path, outline, isExplicit ? 30 : 28, `${reason} outline; full file is ${lines.length} lines`));

    // Sections help non-code files. For code files, symbols are the right unit.
    if (isExplicit && !(file?.symbols?.length)) {
      for (const section of keywords) {
        if (section.length < 5) continue;
        const found = sectionFor(text, section, path);
        if (!found) continue;
        add(
          packItem(
            "section",
            `${path}#${found.title}`,
            numbered(lines, found.start, found.end),
            35,
            `${reason} section "${found.title}"`,
          ),
        );
        break;
      }
    }

    // Include the bodies of symbols the task or plan names. Dependencies stay
    // at outline level; the model can read a named symbol when it needs it.
    if (isExplicit) {
      const matched = (file?.symbols ?? [])
        .map((symbol) => ({ symbol, score: symbolScore(symbol, keywords) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.symbol.line - b.symbol.line)
        .slice(0, 6)
        .map((entry) => entry.symbol);
      for (const symbol of matched) {
        add(
          packItem(
            "symbol",
            `${path}#${symbol.name}`,
            numbered(lines, symbol.line, symbol.end),
            40,
            `${reason} symbol ${symbol.name}`,
          ),
        );
      }
    }

    // Tests are append-heavy. Keep the tail when the test file is large.
    if (isTest) {
      const start = Math.max(1, lines.length - 59);
      add(packItem("section", `${path}#tail`, numbered(lines, start, lines.length), 45, "test tail for appending"));
    }
  }

  // Commands and artifacts are part of the task context, not discovery work.
  if (input.commands) {
    const rows = [...input.commands.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, spec]) => `- ${name}${spec.readonly ? " (read-only)" : ""}: ${spec.description}`);
    if (rows.length > 0) add(packItem("command", "commands", rows.join("\n"), 50, "available typed commands"));
  }
  if (input.layout) {
    try {
      const artifacts = listArtifacts(input.layout);
      if (artifacts.length > 0) {
        const rows = artifacts.map((artifact) => `- ${artifactSummary(artifact).replace(/\n/g, " · ")}`);
        add(packItem("artifact", "artifacts", rows.join("\n"), 51, "reusable tools and scripts"));
      }
    } catch {
      // An unavailable artifact store must not block the pack.
    }
  }

  add(packItem("guide", "tool-policy", TOOL_GUIDE, 52, "choose the most direct tool first"));

  // Packet acceptance commands.
  const gates = unique([...`${input.taskText ?? ""}\n${input.request}`.matchAll(/"command"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!));
  if (gates.length > 0) {
    const rows = gates.map((gate) => {
      const spec = input.commands?.get(gate);
      return `- ${gate}${spec ? `: ${spec.description}` : ""}`;
    });
    add(packItem("gate", "acceptance", rows.join("\n"), 53, "acceptance gate commands"));
  }

  const chars = items.reduce((sum, item) => sum + item.chars, 0);
  return {
    items,
    chars,
    tokens: tokenCount(chars),
    files: order.slice(0, maxFiles),
  };
}

/** Fit the pack to a model budget, keeping task files and symbols first. */
export function renderContextPack(pack: ContextPack, options: RenderPackOptions): RenderedPack {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const perItemChars = options.perItemChars ?? Math.max(4_000, Math.floor(maxChars * 0.35));
  const blocks: string[] = [];
  const omitted: Array<{ ref: string; reason: string }> = [];
  let used = 0;
  let included = 0;

  const ordered = [...pack.items].sort((a, b) => a.order - b.order);
  for (const item of ordered) {
    const header = `### ${item.kind}: ${item.ref} — ${item.reason}`;
    const remaining = maxChars - used - header.length - 2;
    if (remaining <= 0) {
      omitted.push({ ref: item.ref, reason: "context budget exhausted" });
      continue;
    }
    const cap = Math.min(item.body.length, perItemChars, remaining);
    if (cap <= 0) {
      omitted.push({ ref: item.ref, reason: "item does not fit" });
      continue;
    }
    const useFallback = item.body.length > cap && Boolean(item.fallback);
    const source = useFallback ? item.fallback! : item.body;
    const body = source.length <= cap
      ? source
      : `${source.slice(0, cap).replace(/\s+$/, "")}\n…[truncated]`;
    const suffix = useFallback ? " (outline/tail; full body omitted)" : "";
    const block = `${header}${suffix}\n${body}`;
    blocks.push(block);
    used += block.length + 2;
    included += 1;
  }

  if (blocks.length === 0) return { text: "", chars: 0, tokens: 0, included: 0, omitted };
  const note = omitted.length > 0
    ? `_Context omitted for budget: ${omitted.slice(0, 8).map((item) => `${item.ref} (${item.reason})`).join("; ")}${omitted.length > 8 ? `; +${omitted.length - 8} more` : ""}._`
    : "";
  const head = ["<task-pack>", note].filter(Boolean).join("\n");
  let text = [head, ...blocks, "</task-pack>"].join("\n");
  if (text.length > maxChars) {
    text = maxChars <= 16
      ? text.slice(0, maxChars)
      : `${text.slice(0, maxChars - 16).replace(/\s+$/, "")}\n…[truncated]`;
  }
  return { text, chars: text.length, tokens: tokenCount(text.length), included, omitted };
}
