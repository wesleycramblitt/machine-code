/**
 * machine_code — deterministic module index over the repo map.
 *
 * There is no cached annotation layer. Every summary, key file, keyword, and
 * dependency edge is derived from the live repo map: paths, symbols, imports,
 * section headings, and the doc header at the top of each file. If the code
 * changes, the index changes; nothing can be "fresh" and wrong.
 */
import { readCachedMap, isCodeLang, moduleOf, type MapFile, type RepoMap } from "./deterministic.js";
import { truncateToBytes } from "../tools/safety.js";

export interface ModuleEntry {
  summary: string;
  keyFiles?: string[];
  /** Concrete search terms: filenames, symbols, concepts. */
  keywords?: string[];
  /** Deterministic module edges from imports, outermost module names. */
  deps?: string[];
  /** True for a large-file entry; module entries omit it. */
  file?: boolean;
}

export interface ModuleIndex {
  modules: Record<string, ModuleEntry>;
}

export interface ModuleMatch {
  module: string;
  entry: ModuleEntry;
  score: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "why", "where", "when",
  "are", "was", "were", "you", "your", "its", "into", "about", "does", "use", "used", "using",
  "can", "will", "should", "would", "could", "please", "one", "two", "all", "any", "not",
  "but", "has", "have", "had", "them", "they", "their", "then", "than", "also", "just",
]);

/** Lowercase search tokens; splits filenames on dots so `state.md` matches `state`. */
export function moduleTokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

/** Rank modules by keyword overlap with a query. */
export function searchModules(index: ModuleIndex, query: string, limit = 10): ModuleMatch[] {
  const tokens = moduleTokens(query);
  if (tokens.length === 0) return [];
  const matches: ModuleMatch[] = [];
  for (const [module, entry] of Object.entries(index.modules)) {
    const moduleText = module.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const files = (entry.keyFiles ?? []).join(" ").toLowerCase();
    const keywords = (entry.keywords ?? []).join(" ").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (moduleText.includes(token)) score += 5;
      if (summary.includes(token)) score += 3;
      if (files.includes(token)) score += 6;
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

function usefulDoc(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const clean = doc.replace(/\s+/g, " ").trim();
  if (clean.length < 12) return undefined;
  if (/^(?:copyright|license|spdx-license|mit license|apache license|gpl)\b/i.test(clean)) return undefined;
  return clean;
}

/** One readable sentence for a module overview, not a whole file header. */
function firstSentence(doc: string, max = 140): string {
  const clean = doc.replace(/^machine_code\s*[—-]\s*/i, "").trim();
  const match = /^(.{8,}?[.!?])(?:\s|$)/.exec(clean);
  const sentence = match?.[1] ?? clean;
  return sentence.length <= max ? sentence : `${sentence.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Build the module index from the live repo map.
 *
 * Only code files participate. A top-level `src/tui.ts` groups with
 * `src/tui/*` under `src/tui`, so the entry file and its submodules share one
 * summary instead of being split into `src` and `src/tui`.
 */
export function buildModuleIndex(map: RepoMap): ModuleIndex {
  const sectionsByFile = new Map<string, string[]>();
  const codeFiles = map.files.filter((file) => isCodeLang(file.lang));
  for (const file of codeFiles) {
    if (file.sections?.length) sectionsByFile.set(file.path, file.sections);
  }

  const byModule = new Map<string, MapFile[]>();
  for (const file of codeFiles) {
    const module = moduleOf(file.path);
    const list = byModule.get(module) ?? [];
    list.push(file);
    byModule.set(module, list);
  }
  const modules: Record<string, ModuleEntry> = {};
  for (const [module, files] of byModule) {
    const sorted = [...files].sort(
      (a, b) => b.symbols.length - a.symbols.length || b.bytes - a.bytes || a.path.localeCompare(b.path),
    );
    const byBytes = [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 2);
    const keyFiles = [...new Set([...sorted.slice(0, 3), ...byBytes].map((file) => file.path))].slice(0, 5);
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
    const deps = [...new Set(
      files.flatMap((file) => (file.imports ?? []).map((imported) => moduleOf(imported))),
    )].filter((target) => target !== module).sort().slice(0, 16);
    const basenames = keyFiles.map((path) => path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path);
    const fileDocs = files.map((file) => usefulDoc(file.doc)).filter((doc): doc is string => Boolean(doc));
    const symbolDocs = sorted
      .flatMap((file) => file.symbols.map((symbol) => usefulDoc(symbol.doc)))
      .filter((doc): doc is string => Boolean(doc));
    const docText = [...fileDocs, ...symbolDocs].join(" ");
    const docKeywords = moduleTokens(docText).slice(0, 16);
    const keywords = [...new Set([
      module,
      ...module.split("/"),
      ...basenames,
      ...docKeywords,
      ...sections.flatMap((heading) => moduleTokens(heading)),
      ...symbols,
    ].filter(Boolean))].slice(0, 24);
    const symbolSummary = [
      basenames.join(", "),
      symbols.length > 0 ? symbols.slice(0, 8).join(", ") : "",
      sections.length > 0 ? `sections: ${sections.slice(0, 6).join(", ")}` : "",
    ].filter(Boolean).join(" — ");
    // Lead with the byte-largest files: the module's entry point usually has
    // the most code and the most useful doc header.
    const keyDocs = [...new Set([...byBytes, ...sorted])]
      .map((file) => usefulDoc(file.doc))
      .filter((doc): doc is string => Boolean(doc));
    const docSummary = keyDocs.length > 0
      ? keyDocs.slice(0, 3).map((doc) => firstSentence(doc)).join(" · ")
      : symbolDocs[0];
    const summary = docSummary ? clip(docSummary, 240) : clip(symbolSummary || module, 240);
    modules[module] = {
      summary,
      keyFiles,
      keywords,
      ...(deps.length > 0 ? { deps } : {}),
    };
  }

  // File-level entries let `search semantic` return a monolithic file
  // directly, without inventing a fake directory for it.
  for (const file of codeFiles) {
    if (file.lines < 400 && file.bytes < 20 * 1024) continue;
    if (modules[file.path]) continue;
    if (modules[moduleOf(file.path)]?.keyFiles?.includes(file.path)) continue;
    const symbols = file.symbols
      .map((symbol) => symbol.name)
      .filter((name) => name.length >= 4)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 12);
    const sections = sectionsByFile.get(file.path) ?? [];
    const basename = file.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? file.path;
    const doc = usefulDoc(file.doc);
    const symbolDocs = file.symbols.map((symbol) => usefulDoc(symbol.doc)).filter((value): value is string => Boolean(value));
    const docKeywords = moduleTokens([doc ?? "", ...symbolDocs].join(" ")).slice(0, 16);
    const keywords = [...new Set([
      basename,
      ...docKeywords,
      ...sections.flatMap((heading) => moduleTokens(heading)),
      ...symbols,
    ].filter(Boolean))].slice(0, 40);
    const symbolSummary = [
      basename,
      symbols.length > 0 ? symbols.slice(0, 6).join(", ") : "",
      sections.length > 0 ? `sections: ${sections.slice(0, 5).join(", ")}` : "",
    ].filter(Boolean).join(" — ");
    modules[file.path] = {
      summary: clip(doc ? firstSentence(doc) : symbolSummary, 240),
      keyFiles: [file.path],
      keywords,
      file: true,
    };
  }

  return { modules };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function moduleNames(map: RepoMap): string[] {
  return [...new Set(map.files.filter((file) => isCodeLang(file.lang)).map((file) => moduleOf(file.path)))].sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });
}

/** Load the deterministic module index from the cached repo map. */
export function loadModuleIndex(root: string): ModuleIndex | null {
  const map = readCachedMap(root);
  return map ? buildModuleIndex(map) : null;
}

export function renderModuleIndex(index: ModuleIndex | null, maxBytes = 3_072, query = ""): string {
  if (!index) return "";
  const ranked = new Map(
    (query.trim() ? searchModules(index, query, 16) : []).map((match) => [match.module, match.score]),
  );
  // The startup map stays module-level. File entries are search results, not
  // index lines; including them would crowd the budget.
  const modules = Object.entries(index.modules)
    .filter(([, entry]) => !entry.file)
    .sort(([a], [b]) => {
      const scoreA = ranked.get(a) ?? 0;
      const scoreB = ranked.get(b) ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.localeCompare(b);
    });
  const lines = ["<module-index>"];
  for (const [module, entry] of modules) {
    const files = entry.keyFiles?.length ? ` · files: ${entry.keyFiles.join(", ")}` : "";
    const deps = entry.deps?.length ? ` · deps: ${entry.deps.join(", ")}` : "";
    lines.push(`${module} — ${entry.summary}${files}${deps}`);
  }
  lines.push("</module-index>");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${truncateToBytes(text, Math.max(0, maxBytes - 20))}\n[truncated]`;
}

/**
 * Compact module dependency graph. Edges are deterministic imports; module
 * summaries and query ranking make the overview readable.
 */
export function renderModuleGraph(
  map: RepoMap,
  index: ModuleIndex | null,
  query = "",
  maxBytes = 6 * 1024,
): string {
  const deps = new Map<string, Set<string>>();
  for (const file of map.files) {
    if (!isCodeLang(file.lang)) continue;
    const module = moduleOf(file.path);
    const targets = deps.get(module) ?? new Set<string>();
    for (const imported of file.imports ?? []) {
      const target = moduleOf(imported);
      if (target !== module) targets.add(target);
    }
    deps.set(module, targets);
  }
  const ranked = new Set(
    query.trim() && index ? searchModules(index, query, 16).map((match) => match.module) : [],
  );
  const modules = [...deps.keys()]
    .filter((module) => (deps.get(module)?.size ?? 0) > 0 || ranked.has(module))
    .sort((a, b) => {
      const rankA = ranked.has(a) ? 0 : 1;
      const rankB = ranked.has(b) ? 0 : 1;
      return rankA - rankB || a.localeCompare(b);
    });
  const lines = ["<module-graph>"];
  for (const module of modules) {
    const allTargets = [...(deps.get(module) ?? new Set<string>())].sort();
    if (allTargets.length === 0) continue;
    const targets = allTargets.slice(0, 12);
    const more = allTargets.length > targets.length ? ` +${allTargets.length - targets.length}` : "";
    const summary = index?.modules[module]?.summary;
    const label = summary ? summary.split(" — ")[0]!.slice(0, 80) : "";
    lines.push(`${module}${label ? ` (${label})` : ""} → ${targets.join(", ")}${more}`);
  }
  lines.push("</module-graph>");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${truncateToBytes(text, Math.max(0, maxBytes - 24))}\n[graph truncated]`;
}
