/**
 * machine_code — semantic map: bounded module annotations over the
 * deterministic map. One model call per refresh; the deterministic facts stay
 * authoritative.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Context, Usage } from "@earendil-works/pi-ai";
import type { MutableModels, ChatModel } from "../models.js";
import { truncateToBytes } from "../tools/safety.js";
import { readSemanticChanges } from "./changes.js";
import { renderRepoMap, type MapFile, type RepoMap } from "./deterministic.js";

export const SEMANTIC_SCHEMA = 1 as const;
const SEMANTIC_CAP_BYTES = 16 * 1024;
const SEMANTIC_INPUT_BYTES = 12 * 1024;

export interface SemanticEntry {
  summary: string;
  keyFiles?: string[];
  editHints?: string[];
  /** Concrete search terms: filenames, symbols, concepts. */
  keywords?: string[];
  /** True for a large-file entry; module entries omit it. */
  file?: boolean;
}

export interface SemanticMatch {
  module: string;
  entry: SemanticEntry;
  score: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "why", "where", "when",
  "are", "was", "were", "you", "your", "its", "into", "about", "does", "use", "used", "using",
  "can", "will", "should", "would", "could", "please", "one", "two", "all", "any", "not",
  "but", "has", "have", "had", "them", "they", "their", "then", "than", "also", "just",
]);

/** Lowercase search tokens; splits filenames on dots so `state.md` matches `state`. */
export function semanticTokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

/** Rank modules by keyword overlap with a query. */
export function searchSemantic(semantic: SemanticMap, query: string, limit = 10): SemanticMatch[] {
  const tokens = semanticTokens(query);
  if (tokens.length === 0) return [];
  const matches: SemanticMatch[] = [];
  for (const [module, entry] of Object.entries(semantic.modules)) {
    const moduleText = module.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const files = (entry.keyFiles ?? []).join(" ").toLowerCase();
    const hints = (entry.editHints ?? []).join(" ").toLowerCase();
    const keywords = (entry.keywords ?? []).join(" ").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (moduleText.includes(token)) score += 5;
      if (summary.includes(token)) score += 3;
      if (files.includes(token)) score += 6;
      if (hints.includes(token)) score += 2;
      if (keywords.includes(token)) score += 8;
    }
    // A concrete file is more actionable than the module that contains it.
    if (score > 0 && entry.file) score += 8;
    if (score > 0) matches.push({ module, entry, score });
  }
  return matches
    .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module))
    .slice(0, Math.max(1, limit));
}

export interface SemanticMap {
  schema: typeof SEMANTIC_SCHEMA;
  baseCommit: string;
  mapHash: string;
  generatedAt: string;
  model: string;
  modules: Record<string, SemanticEntry>;
}

export interface SemanticTask {
  prompt: string;
  modules: string[];
  /** Latest change time included in the prompt; later changes stay dirty. */
  changeCutoff: string;
}

export interface SemanticModelResult {
  text: string;
  usage?: Usage;
  stopReason?: string;
  error?: string;
}

/** Build a deterministic, always-fresh module index from the repo map. */
export function buildModuleIndex(map: RepoMap): SemanticMap {
  // Large files carry their comment banners in the repo map. This gives the
  // semantic index section names that a top-level symbol map cannot see.
  const sectionsByFile = new Map<string, string[]>();
  for (const file of map.files) {
    if (file.sections?.length) sectionsByFile.set(file.path, file.sections);
  }

  const byModule = new Map<string, MapFile[]>();
  for (const file of map.files) {
    const module = moduleOf(file.path);
    const list = byModule.get(module) ?? [];
    list.push(file);
    byModule.set(module, list);
  }
  const modules: Record<string, SemanticEntry> = {};
  for (const [module, files] of byModule) {
    const sorted = [...files].sort(
      (a, b) => b.symbols.length - a.symbols.length || b.bytes - a.bytes || a.path.localeCompare(b.path),
    );
    const byBytes = [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 2);
    const keyFiles = [...new Set([...sorted.slice(0, 3), ...byBytes].map((file) => file.path))].slice(0, 4);
    const symbols = [...new Set(
      sorted
        .flatMap((file) => file.symbols.map((symbol) => symbol.name))
        .filter((name) => name.length >= 4),
    )]
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 12);
    const sections = [...new Set(
      files.flatMap((file) => sectionsByFile.get(file.path) ?? []),
    )].slice(0, 12);
    const basenames = keyFiles.map((path) => path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path);
    const keywords = [...new Set([
      module,
      ...module.split("/"),
      ...basenames,
      ...sections.flatMap((heading) => semanticTokens(heading)),
      ...symbols,
    ].filter(Boolean))].slice(0, 24);
    const summary = [
      basenames.join(", "),
      symbols.length > 0 ? symbols.slice(0, 8).join(", ") : "",
      sections.length > 0 ? `sections: ${sections.slice(0, 6).join(", ")}` : "",
    ].filter(Boolean).join(" — ");
    modules[module] = {
      summary: clip(summary || module, 240),
      keyFiles,
      keywords,
    };
  }

  // File-level entries let `search semantic` return a monolithic file
  // directly, without inventing a fake directory for it.
  for (const file of map.files) {
    if (file.lines < 400 && file.bytes < 20 * 1024) continue;
    if (modules[file.path]) continue;
    const symbols = file.symbols
      .map((symbol) => symbol.name)
      .filter((name) => name.length >= 4)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 12);
    const sections = sectionsByFile.get(file.path) ?? [];
    const basename = file.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? file.path;
    const keywords = [...new Set([
      basename,
      ...sections.flatMap((heading) => semanticTokens(heading)),
      ...symbols,
    ].filter(Boolean))].slice(0, 40);
    const summary = [
      basename,
      symbols.length > 0 ? symbols.slice(0, 6).join(", ") : "",
      sections.length > 0 ? `sections: ${sections.slice(0, 5).join(", ")}` : "",
    ].filter(Boolean).join(" — ");
    modules[file.path] = {
      summary: clip(summary, 240),
      keyFiles: [file.path],
      keywords,
      file: true,
    };
  }

  return {
    schema: SEMANTIC_SCHEMA,
    baseCommit: map.head,
    mapHash: mapHashOf(map),
    generatedAt: new Date().toISOString(),
    model: "deterministic",
    modules,
  };
}

/** Overlay fresh LLM annotations on the deterministic index. */
export function mergeModuleIndex(base: SemanticMap, overlay: SemanticMap | null): SemanticMap {
  if (!overlay) return base;
  const modules: Record<string, SemanticEntry> = { ...base.modules };
  for (const [module, entry] of Object.entries(overlay.modules)) {
    const current = modules[module];
    if (!current) continue;
    modules[module] = {
      summary: entry.summary?.trim() || current.summary,
      ...(entry.keyFiles?.length ? { keyFiles: entry.keyFiles } : current.keyFiles ? { keyFiles: current.keyFiles } : {}),
      ...(entry.editHints?.length ? { editHints: entry.editHints } : current.editHints ? { editHints: current.editHints } : {}),
      keywords: [...new Set([...(current.keywords ?? []), ...(entry.keywords ?? [])])].slice(0, 16),
    };
  }
  return {
    ...base,
    model: overlay.model,
    generatedAt: overlay.generatedAt,
    modules,
  };
}

function cacheDir(root: string): string {
  return join(root, ".machine_code", "local", "cache", "map");
}

export function semanticPath(root: string): string {
  return join(cacheDir(root), "semantic.json");
}

export function semanticDirtyPath(root: string): string {
  return join(cacheDir(root), "semantic.dirty");
}

export function mapHashOf(map: RepoMap): string {
  return createHash("sha256").update(JSON.stringify(map)).digest("hex");
}

/** Top-level module: `src/<dir>` for source trees, otherwise the first segment. */
export function moduleOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "src" && parts.length > 2) return `src/${parts[1]}`;
  return parts.length > 1 ? parts[0]! : ".";
}

export function moduleNames(map: RepoMap): string[] {
  return [...new Set(map.files.map((file) => moduleOf(file.path)))].sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });
}

export function readSemanticDirty(root: string): string[] {
  const file = semanticDirtyPath(root);
  if (!existsSync(file)) return [];
  return [...new Set(readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean))];
}

export function markSemanticDirty(root: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const file = semanticDirtyPath(root);
  mkdirSync(cacheDir(root), { recursive: true });
  const existing = new Set(readSemanticDirty(root));
  for (const path of paths) if (path) existing.add(path);
  writeFileSync(file, `${[...existing].sort().join("\n")}\n`, "utf8");
}

export function clearSemanticDirty(root: string, paths?: readonly string[]): void {
  const file = semanticDirtyPath(root);
  if (!existsSync(file)) return;
  if (!paths) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
    return;
  }
  const keep = readSemanticDirty(root).filter((path) => !paths.includes(path));
  if (keep.length === 0) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  } else {
    writeFileSync(file, `${keep.join("\n")}\n`, "utf8");
  }
}

export function loadSemantic(root: string): SemanticMap | null {
  const file = semanticPath(root);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SemanticMap;
    if (raw?.schema !== SEMANTIC_SCHEMA || typeof raw.modules !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

export function isSemanticFresh(semantic: SemanticMap | null, map: RepoMap, dirty: readonly string[]): boolean {
  if (!semantic) return false;
  if (dirty.length > 0) return false;
  return semantic.baseCommit === map.head && semantic.mapHash === mapHashOf(map);
}

function writeSemantic(root: string, semantic: SemanticMap): void {
  const file = semanticPath(root);
  mkdirSync(cacheDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(semantic, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface SemanticTaskInput {
  root: string;
  map: RepoMap;
  existing: SemanticMap | null;
  dirtyPaths: readonly string[];
}

/** Build one bounded prompt. Dirty modules are refreshed; a cold map is full. */
export function buildSemanticTask(input: SemanticTaskInput): SemanticTask {
  const all = moduleNames(input.map);
  const dirtyModules = [...new Set(input.dirtyPaths.map(moduleOf))].filter((module) => all.includes(module));
  const targets =
    input.existing && dirtyModules.length > 0 && dirtyModules.length * 2 <= all.length
      ? dirtyModules
      : all;
  const slices: string[] = [];
  for (const module of targets) {
    slices.push(renderRepoMap(input.map, { path: module === "." ? undefined : module, maxBytes: 4096 }));
  }
  let mapText = slices.join("\n\n");
  const readme = join(input.root, "README.md");
  if (existsSync(readme)) {
    try { mapText += `\n\nREADME:\n${readFileSync(readme, "utf8").slice(0, 2048)}`; } catch { /* ignore */ }
  }
  const existing = input.existing
    ? JSON.stringify(
        Object.fromEntries(targets.filter((module) => input.existing?.modules[module]).map((module) => [module, input.existing!.modules[module]])),
        null,
        2,
      )
    : "{}";
  const changeCutoff = new Date().toISOString();
  const changes = readSemanticChanges(
    input.root,
    input.dirtyPaths.length > 0 ? input.dirtyPaths : undefined,
    20,
  ).filter((change) => change.t <= changeCutoff);
  const changeText = changes.length > 0
    ? changes
        .map(
          (change) =>
            `- t${change.turn} ${change.agent}${change.model ? ` (${change.model})` : ""} ` +
            `${change.path}: ${change.detail}`,
        )
        .join("\n")
    : "(none)";
  const prompt = [
    "Annotate this repository map. Return JSON only, with no prose.",
    "For each module, name its main exported types/functions and the problem it solves in 20-40 words.",
    "keyFiles: up to 3 exact paths from the map.",
    "editHints: up to 2 hints that name the file and symbol to change for a likely task.",
    "keywords: up to 8 concrete search terms (filenames, symbols, concepts).",
    "Use exact paths and symbol names. Do not speculate. Keep existing annotations unless the module is dirty.",
    "Use recent changes to understand what moved; do not restate the change itself.",
    `Modules: ${targets.join(", ")}`,
    `Dirty paths: ${input.dirtyPaths.join(", ") || "(none)"}`,
    `Recent changes:\n${truncateToBytes(changeText, 2048)}`,
    `Existing annotations: ${existing}`,
    "JSON shape: {\"modules\":{\"<module>\":{\"summary\":\"...\",\"keyFiles\":[\"...\"],\"editHints\":[\"...\"],\"keywords\":[\"...\"]}}}",
    "Map:",
    truncateToBytes(mapText, SEMANTIC_INPUT_BYTES),
  ].join("\n\n");
  return { prompt, modules: targets, changeCutoff };
}

function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validEntry(value: unknown, map: RepoMap, module: string): SemanticEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;
  const files = new Set(map.files.filter((file) => moduleOf(file.path) === module).map((file) => file.path));
  const keyFiles = Array.isArray(raw.keyFiles)
    ? raw.keyFiles.filter((item): item is string => typeof item === "string" && files.has(item)).slice(0, 3)
    : [];
  const editHints = Array.isArray(raw.editHints)
    ? raw.editHints.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 2)
    : [];
  const keywords = Array.isArray(raw.keywords)
    ? [...new Set(
        raw.keywords
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => clip(item.trim(), 40)),
      )].slice(0, 8)
    : [];
  return {
    summary: clip(raw.summary.trim(), 240),
    ...(keyFiles.length > 0 ? { keyFiles } : {}),
    ...(editHints.length > 0 ? { editHints: editHints.map((hint) => clip(hint, 160)) } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

export interface MergeInput {
  root: string;
  map: RepoMap;
  existing: SemanticMap | null;
  modules: readonly string[];
  model: string;
  response: string;
  dirtyPaths: readonly string[];
  /** Changes after this time are not considered covered by this response. */
  changeCutoff?: string;
}

/** Validate, merge, cap, and persist one semantic response. */
export function mergeSemantic(input: MergeInput): SemanticMap | null {
  const parsed = parseJson(input.response) as { modules?: Record<string, unknown> } | null;
  if (!parsed?.modules) return null;
  const modules: Record<string, SemanticEntry> = { ...(input.existing?.modules ?? {}) };
  // Refresh deterministic file entries (section headings change with edits)
  // and add any module entry that is missing.
  const fresh = buildModuleIndex(input.map);
  for (const [key, entry] of Object.entries(fresh.modules)) {
    if (entry.file || !modules[key]) modules[key] = entry;
  }
  const allowed = new Set(moduleNames(input.map));
  const files = new Set(input.map.files.map((file) => file.path));
  for (const [module, entry] of Object.entries(modules)) {
    if (entry.file ? !files.has(module) : !allowed.has(module)) delete modules[module];
  }
  const acceptedModules = new Set<string>();
  for (const module of input.modules) {
    const entry = validEntry(parsed.modules[module], input.map, module);
    if (entry) {
      modules[module] = entry;
      acceptedModules.add(module);
    }
  }
  if (acceptedModules.size === 0) return null;
  const semantic: SemanticMap = {
    schema: SEMANTIC_SCHEMA,
    baseCommit: input.map.head,
    mapHash: mapHashOf(input.map),
    generatedAt: new Date().toISOString(),
    model: input.model,
    modules,
  };
  // Cap the file. Drop hints, then files, then shorten summaries.
  let text = JSON.stringify(semantic, null, 2);
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) {
    for (const entry of Object.values(semantic.modules)) delete entry.editHints;
    text = JSON.stringify(semantic, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) {
    for (const entry of Object.values(semantic.modules)) delete entry.keyFiles;
    text = JSON.stringify(semantic, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) {
    for (const entry of Object.values(semantic.modules)) entry.summary = clip(entry.summary, 120);
    text = JSON.stringify(semantic, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > SEMANTIC_CAP_BYTES) return null;
  writeSemantic(input.root, semantic);
  const cutoff = input.changeCutoff ?? new Date().toISOString();
  const handled = input.dirtyPaths.filter((path) => {
    if (!acceptedModules.has(moduleOf(path))) return false;
    const latest = readSemanticChanges(input.root, [path], 1)[0]?.t ?? "";
    return latest <= cutoff;
  });
  clearSemanticDirty(input.root, handled);
  return semantic;
}

export function renderSemanticIndex(semantic: SemanticMap | null, maxBytes = 3_072, query = ""): string {
  if (!semantic) return "";
  const ranked = new Map(
    (query.trim() ? searchSemantic(semantic, query, 16) : []).map((match) => [match.module, match.score]),
  );
  // The startup map stays module-level. File entries are search results, not
  // index lines; including them would crowd the 3 KiB budget.
  const modules = Object.entries(semantic.modules)
    .filter(([, entry]) => !entry.file)
    .sort(([a], [b]) => {
      const scoreA = ranked.get(a) ?? 0;
      const scoreB = ranked.get(b) ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.localeCompare(b);
    });
  const lines = ["<semantic-map>"];
  for (const [module, entry] of modules) {
    const files = entry.keyFiles?.length ? ` · files: ${entry.keyFiles.join(", ")}` : "";
    const hints = entry.editHints?.length ? ` · hints: ${entry.editHints.join("; ")}` : "";
    lines.push(`${module} — ${entry.summary}${files}${hints}`);
  }
  lines.push("</semantic-map>");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${truncateToBytes(text, Math.max(0, maxBytes - 20))}\n[truncated]`;
}

/** One bounded completion. Caller owns model selection and accounting. */
export async function runSemanticModel(
  models: MutableModels,
  model: ChatModel,
  prompt: string,
  signal?: AbortSignal,
  maxTokens = 4_000,
  sessionId?: string,
): Promise<SemanticModelResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const source = models.streamSimple(
      model,
      {
        systemPrompt: "Return JSON only. Do not call tools. No prose.",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      } as Context,
      {
        maxTokens,
        reasoning: "minimal",
        sessionId,
        signal: controller.signal,
        identity: {
          userAgent: { custom: "machine_code/0.0.0" },
          attribution: { name: "machine_code", url: "https://github.com/extropian/machine-code" },
        },
      },
    );
    let text = "";
    try {
      for await (const event of source) {
        if (event.type === "text_delta") text += event.delta;
      }
      const result = await source.result();
      return {
        text,
        usage: result.usage,
        stopReason: result.stopReason,
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
      };
    } catch (error) {
      return {
        text,
        stopReason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
