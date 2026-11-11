/**
 * machine_code — suggested context from the deterministic map.
 *
 * Hints are context, not a second prompt. Score only what the map already
 * knows: path segments, symbol names, section headings, and doc text. Paths
 * and symbols carry the signal; prose is only a tie-breaker. A request word
 * that exists only in unrelated docs is filler, not a hint, and must not be
 * allowed to outrank a real code match.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { readCachedMap, type MapSymbol, type RepoMap } from "./deterministic.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "why",
  "where", "when", "are", "was", "were", "you", "your", "its", "into", "about",
  "does", "use", "used", "using", "can", "will", "should", "would", "could",
  "please", "one", "two", "all", "any", "not", "but", "has", "have", "had",
  "them", "they", "their", "then", "than", "also", "just", "make", "need",
  "there", "here", "like", "just", "only", "very", "much", "more", "most",
]);

/** Common suffixes stripped so "deletion" and "delete" compare equal. */
const SUFFIXES = ["ations", "ation", "ments", "ment", "ings", "ing", "ions", "ion", "ed"];

export interface SuggestedFile {
  path: string;
  reason: string;
  score: number;
  /** Request terms and symbol/section names that matched, for hint display. */
  matched: string[];
}

/** Lowercase words as they appear in a request. */
function tokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

/** A cheap stem; enough to match "deletion"/"delete" and "runs"/"run". */
function stem(token: string): string {
  let value = token.toLowerCase();
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("sses")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) value = value.slice(0, -1);
  for (const suffix of SUFFIXES) {
    if (value.length - suffix.length >= 3 && value.endsWith(suffix)) {
      return value.slice(0, -suffix.length);
    }
  }
  return value;
}

/** Prefix-aware equality: "delet" matches "delete", "confirm" matches "confirm". */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function parts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function firstLine(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Repo files named with line anchors in free text (`path/to/file.ts:123`).
 * Research-planned issues cite exact evidence locations; pinning them up
 * front deletes the first discovery pass. Only paths that exist on disk
 * count, so version numbers and prose never match.
 */
export function extractAnchoredFiles(root: string, text: string, limit = 8): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /([\w\-.]+(?:\/[\w\-.]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|swift|scala|md|mdx|toml|json|yaml|yml|sh|css|html))(?:\s*:\s*\d+(?:\s*-\s*\d+)?)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && found.length < limit) {
    const rel = match[1]!;
    if (seen.has(rel) || rel.includes("..")) continue;
    seen.add(rel);
    try {
      if (statSync(join(root, rel)).isFile()) found.push(rel);
    } catch {
      // Not a repo file; ignore.
    }
  }
  return found;
}

/**
 * Bare filenames with line anchors (`name.ext:123`, no directory), resolved
 * through the repo map. Planned issues cite short names; the pathed pass
 * above misses them. Unique basenames pin directly; a few candidates pin
 * together (the model picks cheaper than it re-discovers); many stay
 * skipped for the ranker.
 */
export function extractBareAnchors(map: RepoMap, text: string, limit = 8): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(^|[\s(`'"])((?:[\w\-.]+)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|swift|scala|md|mdx|toml|json|yaml|yml|sh|css|html))\s*:\s*\d+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && found.length < limit) {
    const name = match[2]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const candidates = map.files.filter((file) => {
      const base = file.path.split("/").pop() ?? "";
      return base === name;
    });
    if (candidates.length >= 1 && candidates.length <= 3) {
      for (const candidate of candidates) {
        if (found.length < limit && !found.includes(candidate.path)) found.push(candidate.path);
      }
    }
  }
  return found;
}

/**
 * One call for every run kind: ranker hits plus cited evidence, deduped.
 * Planned issues cite exact locations (`path:line` or bare `name:line`);
 * pinning them deletes the first discovery pass for well-specified tasks.
 * `exclude` drops already-attached files (the issue itself); `limit`
 * bounds the ranker, cited files always ride along.
 */
export function suggestFilesForRequest(args: {
  map: RepoMap;
  request: string;
  repoRoot: string;
  limit?: number;
  exclude?: readonly string[];
}): string[] {
  const ranker = suggestTaskFilesFromMap(args.map, args.request, args.limit ?? 3).map((entry) => entry.path);
  const cited = [
    ...extractAnchoredFiles(args.repoRoot, args.request),
    ...extractBareAnchors(args.map, args.request),
  ];
  const excluded = new Set(args.exclude ?? []);
  const out: string[] = [];
  for (const path of [...ranker, ...cited]) {
    if (!excluded.has(path) && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Rank map files for the request using paths, symbols, sections, and docs. */
export function suggestTaskFilesFromMap(
  map: RepoMap,
  request: string,
  limit = 3,
): SuggestedFile[] {
  const wanted = tokens(request).map((token) => ({ raw: token, stem: stem(token) }));
  if (wanted.length === 0) return [];
  const words = normalized(request).split(" ").filter(Boolean);
  const phrases = new Set<string>();
  for (let i = 0; i + 1 < words.length; i += 1) phrases.add(`${words[i]} ${words[i + 1]}`);
  const code = map.files.filter((file) =>
    /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cc|cpp|cs)$/i.test(file.path),
  );

  const pathParts = new Map<string, string[]>();
  const symbolParts = new Map<string, string[]>();
  const sectionParts = new Map<string, string[]>();
  for (const file of code) {
    pathParts.set(file.path, parts(file.path).map(stem));
    symbolParts.set(file.path, file.symbols.flatMap((symbol) => parts(symbol.name).map(stem)));
    sectionParts.set(file.path, (file.sections ?? []).flatMap((section) => parts(section).map(stem)));
  }

  // Document frequency over path/symbol/section evidence. A word that only
  // appears in prose is not a task hint; drop it before it can dominate.
  const df = new Map<string, number>();
  for (const token of wanted) {
    df.set(
      token.stem,
      code.filter((file) => {
        const evidence = [
          ...(pathParts.get(file.path) ?? []),
          ...(symbolParts.get(file.path) ?? []),
          ...(sectionParts.get(file.path) ?? []),
        ];
        return evidence.some((part) => related(part, token.stem));
      }).length,
    );
  }
  const wantedCode = wanted.filter((token) => (df.get(token.stem) ?? 0) > 0);
  if (wantedCode.length === 0) return [];
  const total = Math.max(1, code.length);
  const idf = (token: string): number => Math.log((total + 1) / ((df.get(token) ?? 0) + 1));
  const topLevel = new Set(
    code.flatMap((file) => {
      const path = file.path.split("/");
      return path.length > 1 ? [stem(path[1]!.replace(/\.[^.]+$/, ""))] : [];
    }),
  );

  const ranked = code.map((file) => {
    const path = file.path.toLowerCase();
    const doc = (file.doc ?? "").toLowerCase();
    const sections = (file.sections ?? []).join(" ").toLowerCase();
    const names = file.symbols.map((symbol) => symbol.name).join(" ").toLowerCase();
    const symbolDocs = file.symbols.map((symbol) => symbol.doc ?? "").join(" ").toLowerCase();
    const filePathParts = pathParts.get(file.path) ?? [];
    const fileSymbolParts = symbolParts.get(file.path) ?? [];
    const fileSectionParts = sectionParts.get(file.path) ?? [];
    const docParts = parts(doc).map(stem);
    const symbolDocParts = parts(symbolDocs).map(stem);
    const anchored = wantedCode.some((token) => {
      const pathHit = filePathParts.some((part) => related(part, token.stem)) || path.includes(token.raw);
      const symbolHit = fileSymbolParts.some((part) => related(part, token.stem)) || names.includes(token.raw);
      const sectionHit = fileSectionParts.some((part) => related(part, token.stem)) || sections.includes(token.raw);
      return pathHit || symbolHit || sectionHit;
    });
    let score = 0;
    let pathScore = 0;
    let reason = "";
    let codeHit = false;
    const matched: string[] = [];
    const match = (label: string): void => {
      if (matched.length < 6 && !matched.includes(label)) matched.push(label);
    };
    for (const token of wantedCode) {
      const weight = idf(token.stem) ** 2;
      const pathHit = filePathParts.some((part) => related(part, token.stem)) || path.includes(token.raw);
      const symbolHit = fileSymbolParts.some((part) => related(part, token.stem)) || names.includes(token.raw);
      const sectionHit = fileSectionParts.some((part) => related(part, token.stem)) || sections.includes(token.raw);
      if (pathHit) {
        score += 5 * weight;
        pathScore += 5 * weight;
        codeHit = true;
        reason ||= file.path;
        // Path parts are self-evident from the path; matched terms name the
        // distinctive evidence: symbols, sections, phrases.
      }
      if (symbolHit) {
        score += 2 * weight;
        codeHit = true;
        const symbol = file.symbols.find((entry) => parts(entry.name).some((part) => related(stem(part), token.stem)));
        if (symbol) {
          if (!reason) reason = `${symbol.name} symbol`;
          match(symbol.name);
        } else {
          match(token.raw);
        }
      }
      if (sectionHit) {
        score += 1.5 * weight;
        codeHit = true;
        const heading = (file.sections ?? []).find((section) => related(stem(section), token.stem) || section.toLowerCase().includes(token.raw));
        if (heading) {
          reason ||= `section: ${heading}`;
          match(heading);
        } else {
          match(token.raw);
        }
      }
      // Prose is only a tie-breaker, and only for files already anchored by
      // code evidence. This is what keeps "twice"/"pops" out of the ranking.
      // Stem the prose too, so "delete" in a doc matches "deletion" in a task.
      if (anchored && (
        docParts.some((part) => related(part, token.stem)) ||
        symbolDocParts.some((part) => related(part, token.stem))
      )) {
        score += 0.8 * weight;
        if (!reason) reason = firstLine(file.doc ?? "");
      }
    }
    // A top-level area named in the request ("tui", "cli") is a useful prior.
    for (const token of wantedCode) {
      if (topLevel.has(token.stem) && filePathParts.includes(token.stem)) score += 1.5;
    }
    // A phrase that appears in code is stronger than any single word.
    const codeText = normalized([sections, names, symbolDocs].join(" "));
    const docText = normalized(doc);
    for (const phrase of phrases) {
      if (codeText.includes(phrase)) {
        score += 4;
        codeHit = true;
        if (!reason) reason = `doc: ${phrase}`;
        match(`"${phrase}"`);
      } else if (codeHit && docText.includes(phrase)) {
        score += 1;
      }
    }
    return {
      path: file.path,
      reason: reason || (file.doc ? firstLine(file.doc) : file.path),
      score,
      pathScore,
      codeHit,
      matched,
    };
  });

  // The strongest path match names the area the task lives in (for example
  // src/tui for a TUI request). Prefer its siblings over a same-word symbol in
  // an unrelated module, but only when the match is deep enough to name a
  // module rather than the whole src tree.
  const topPath = [...ranked]
    .filter((entry) => entry.pathScore > 0)
    .sort((a, b) => b.pathScore - a.pathScore || a.path.localeCompare(b.path))[0];
  const pathSegments = topPath?.path.split("/") ?? [];
  const modulePrefix = pathSegments.length >= 3 ? pathSegments.slice(0, 2).join("/") : undefined;
  if (topPath && modulePrefix) {
    const bonus = topPath.pathScore * 0.35;
    for (const entry of ranked) {
      if (entry.codeHit && entry.path.startsWith(`${modulePrefix}/`)) entry.score += bonus;
    }
  }

  return ranked
    .filter((entry) => entry.codeHit && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit))
    .map(({ codeHit: _codeHit, pathScore: _pathScore, ...entry }) => entry);
}

/** Whole files at or under this size inline whole; larger hints send outlines. */
export const SMALL_HINT_BYTES = 4 * 1024;

export interface HintSymbol {
  name: string;
  kind: string;
  start: number;
  end: number;
}

/** One suggested file: structure and matched evidence, not full text. */
export interface FileHint {
  path: string;
  /** Matched symbols first, then file order. Capped. */
  symbols: HintSymbol[];
  /** Request terms (or `cited`) that surfaced the file. */
  matched: string[];
  reason: string;
  bytes: number;
  small: boolean;
  /** Direct imports (repo-relative paths). */
  imports: string[];
  /** Files that import this one. */
  importedBy: string[];
}

function hintSymbols(file: { symbols: MapSymbol[] }, matched: ReadonlySet<string>, cap: number): HintSymbol[] {
  const ordered = [...file.symbols].sort(
    (a, b) => (matched.has(a.name) ? 0 : 1) - (matched.has(b.name) ? 0 : 1),
  );
  return ordered.slice(0, cap).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    start: symbol.line,
    end: Math.max(symbol.line, symbol.end),
  }));
}

/**
 * Ranked files plus cited anchors as hint objects. Small files inline whole
 * (see `small`); the rest travel as symbol outlines with their matched
 * evidence, so the model reads one block instead of paging a dump.
 */
export function suggestHints(args: {
  map: RepoMap;
  request: string;
  repoRoot?: string;
  limit?: number;
  exclude?: readonly string[];
}): FileHint[] {
  const { map, request } = args;
  const limit = args.limit ?? 3;
  const excluded = new Set(args.exclude ?? []);
  const byPath = new Map(map.files.map((file) => [file.path, file]));
  // Reverse imports once: who depends on each file.
  const importedBy = new Map<string, string[]>();
  for (const file of map.files) {
    for (const imported of file.imports ?? []) {
      const list = importedBy.get(imported) ?? [];
      if (!list.includes(file.path)) list.push(file.path);
      importedBy.set(imported, list);
    }
  }
  const out: FileHint[] = [];
  const push = (path: string, reason: string, matched: string[], cited: boolean): void => {
    if (excluded.has(path) || out.some((hint) => hint.path === path)) return;
    const file = byPath.get(path);
    const symbols = file ? hintSymbols(file, new Set(matched), cited ? 8 : 5) : [];
    out.push({
      path,
      symbols,
      matched: [...matched],
      reason,
      bytes: file?.bytes ?? 0,
      small: (file?.bytes ?? Number.POSITIVE_INFINITY) < SMALL_HINT_BYTES,
      imports: [...(file?.imports ?? [])],
      importedBy: [...(importedBy.get(path) ?? [])],
    });
  };
  for (const entry of suggestTaskFilesFromMap(map, request, limit)) {
    push(entry.path, entry.reason, entry.matched, false);
  }
  if (args.repoRoot) {
    for (const anchored of extractAnchoredFiles(args.repoRoot, request)) {
      push(anchored, "cited in the request", ["cited"], true);
    }
  }
  for (const anchored of extractBareAnchors(map, request)) {
    push(anchored, "cited in the request", ["cited"], true);
  }
  return out;
}

/** Render outline-only hints as a compact context block. Whole files travel
 * through the normal file path; only outlines render here. */
export function renderHints(hints: readonly FileHint[]): string {
  const outlined = hints.filter((hint) => !hint.small);
  if (outlined.length === 0) return "";
  const blocks: string[] = [
    "Suggested files (outlines, not full text — read { \"path\", \"symbol\": \"<name>\" } for a block; files under 4KB arrive whole):",
  ];
  for (const hint of outlined) {
    const matched = hint.matched.length > 0 ? ` · matched: ${hint.matched.slice(0, 4).join(", ")}` : "";
    const relations = [
      ...(hint.imports.length > 0 ? [`imports: ${hint.imports.slice(0, 6).join(", ")}${hint.imports.length > 6 ? ", …" : ""}`] : []),
      ...(hint.importedBy.length > 0 ? [`imported by: ${hint.importedBy.slice(0, 6).join(", ")}${hint.importedBy.length > 6 ? ", …" : ""}`] : []),
    ].join(" · ");
    blocks.push(`${hint.path}${matched}${relations ? `\n  ${relations}` : ""}`);
    for (const symbol of hint.symbols) {
      blocks.push(`  ${symbol.kind} ${symbol.name} (${symbol.start}-${symbol.end})`);
    }
  }
  return blocks.join("\n");
}

/** Convenience wrapper for callers that have the layout root. */
export function suggestTaskFiles(root: string, request: string, limit = 3): SuggestedFile[] {
  const map = readCachedMap(root);
  return map ? suggestTaskFilesFromMap(map, request, limit) : [];
}
