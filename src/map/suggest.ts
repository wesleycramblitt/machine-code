/**
 * machine_code — suggested context from the deterministic map.
 *
 * Hints are context, not a second prompt. Score only what the map already
 * knows: path segments, symbol names, section headings, and doc text. Paths
 * and symbols carry the signal; prose is only a tie-breaker. A request word
 * that exists only in unrelated docs is filler, not a hint, and must not be
 * allowed to outrank a real code match.
 */
import { readFileSync, statSync } from "node:fs";
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
  /** Raw request tokens with code or prose hits on this file. */
  keywords: string[];
  /** Symbol name → raw tokens that surfaced it. */
  symbolVia: Record<string, string[]>;
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

/** Raw substring fallback for compound names ("newrun" holds "run"). Gated on
 * length: 3-letter request words ("new", "run", "sub") match inside unrelated
 * names ("pruning" holds "run") and those ghosts outscored real evidence. */
function includesRaw(haystack: string, raw: string): boolean {
  return raw.length >= 4 && haystack.includes(raw);
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
  // One stem, one vote: "commands" and "command" in the same request must not
  // pay the same evidence twice (observed: scripts.ts path hit paid double,
  // outscoring the true location).
  const seenStems = new Set<string>();
  const wanted = tokens(request)
    .map((token) => ({ raw: token, stem: stem(token) }))
    .filter((token) => {
      if (seenStems.has(token.stem)) return false;
      seenStems.add(token.stem);
      return true;
    });
  if (wanted.length === 0) return [];
  const words = normalized(request).split(" ").filter(Boolean);
  const vocab = new Set(words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)));
  const phrases = new Set<string>();
  // Phrases are compositions of request terms, not prose accidents: without
  // the vocab gate, "from the" and "on the" matched file docs, added junk
  // points, and filled the matched-evidence slots with noise.
  for (let i = 0; i + 1 < words.length; i += 1) {
    const pair = `${words[i]} ${words[i + 1]}`;
    if (vocab.has(words[i]!) && vocab.has(words[i + 1]!)) phrases.add(pair);
  }
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
      const pathHit = filePathParts.some((part) => related(part, token.stem)) || includesRaw(path, token.raw);
      const symbolHit = fileSymbolParts.some((part) => related(part, token.stem)) || includesRaw(names, token.raw);
      const sectionHit = fileSectionParts.some((part) => related(part, token.stem)) || includesRaw(sections, token.raw);
      return pathHit || symbolHit || sectionHit;
    });
    let score = 0;
    let pathScore = 0;
    let reason = "";
    let codeHit = false;
    const matched: string[] = [];
    const codeTokens: string[] = [];
    const proseTokens: string[] = [];
    const viaMap = new Map<string, string[]>();
    const match = (label: string): void => {
      if (matched.length < 6 && !matched.includes(label)) matched.push(label);
    };
    const noteCode = (raw: string): void => {
      if (!codeTokens.includes(raw)) codeTokens.push(raw);
    };
    for (const token of wantedCode) {
      const weight = idf(token.stem) ** 2;
      const pathHit = filePathParts.some((part) => related(part, token.stem)) || includesRaw(path, token.raw);
      const symbolHit = fileSymbolParts.some((part) => related(part, token.stem)) || includesRaw(names, token.raw);
      const sectionHit = fileSectionParts.some((part) => related(part, token.stem)) || includesRaw(sections, token.raw);
      if (pathHit) {
        score += 5 * weight;
        pathScore += 5 * weight;
        codeHit = true;
        noteCode(token.raw);
        // No reason here: the path is self-evident, and naming it would
        // shadow the distinctive evidence (a bare path as its own reason
        // says nothing). Symbols, sections, and phrases name the match;
        // the return falls back to the doc, then the path.
      }
      if (symbolHit) {
        score += 2 * weight;
        codeHit = true;
        noteCode(token.raw);
        const symbol = file.symbols.find((entry) => parts(entry.name).some((part) => related(stem(part), token.stem)));
        if (symbol) {
          if (!reason) reason = `${symbol.name} symbol`;
          match(symbol.name);
          const via = viaMap.get(symbol.name) ?? [];
          if (!via.includes(token.raw)) via.push(token.raw);
          viaMap.set(symbol.name, via);
        } else {
          match(token.raw);
        }
      }
      if (sectionHit) {
        score += 1.5 * weight;
        codeHit = true;
        noteCode(token.raw);
        const heading = (file.sections ?? []).find((section) => related(stem(section), token.stem) || includesRaw(section.toLowerCase(), token.raw));
        if (heading) {
          reason ||= `section: ${heading}`;
          match(heading);
        } else {
          match(token.raw);
        }
      }
      // The file's own summary names what it is about (composer.ts's doc
      // enumerates its tabs); that is section-grade evidence, not a
      // tie-breaker. Still gated on code anchoring — this is what keeps
      // "twice"/"pops" out of the ranking — and stemmed, so "delete" in a
      // doc matches "deletion" in a task.
      if (anchored && (
        docParts.some((part) => related(part, token.stem)) ||
        symbolDocParts.some((part) => related(part, token.stem))
      )) {
        score += 1.5 * weight;
        if (!reason) reason = firstLine(file.doc ?? "");
        if (!proseTokens.includes(token.raw)) proseTokens.push(token.raw);
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
      keywords: [...codeTokens, ...proseTokens.filter((raw) => !codeTokens.includes(raw))].slice(0, 8),
      symbolVia: Object.fromEntries(viaMap),
    };
  });

  // The top hit names the module the task lives in. Prefer its directory
  // siblings over same-word matches elsewhere: a request matching one file
  // in a module usually concerns the module (the render, its keys, and its
  // types ship together). Keyed on total score, not path score — path-score
  // aim locked onto a data script whose filename happened to hold two
  // request words, boosting the wrong directory.
  const topHit = [...ranked]
    .filter((entry) => entry.codeHit && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
  const moduleDir = topHit?.path.includes("/") ? topHit.path.split("/").slice(0, -1).join("/") : undefined;
  if (topHit && moduleDir && moduleDir.split("/").length >= 2) {
    const bonus = topHit.score * 0.35;
    for (const entry of ranked) {
      if (entry !== topHit && entry.codeHit && entry.path.startsWith(`${moduleDir}/`)) entry.score += bonus;
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
  /** Raw request tokens that surfaced this symbol. */
  via: string[];
}

/** One suggested file: task evidence in one place — keywords, lines, bodies. */
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
  /** Raw request tokens with code or prose hits on this file: the body-grep set. */
  keywords: string[];
  /** Keyword → body lines, populated by enrichHints (run paths only). */
  keywordLines?: Array<{ keyword: string; lines: number[]; hits: number }>;
  /** Numbered bodies of matched symbols, populated by enrichHints. */
  bodies?: Array<{ symbol: string; start: number; text: string }>;
}

function hintSymbols(
  file: { symbols: MapSymbol[] },
  matched: ReadonlySet<string>,
  cap: number,
  via: Readonly<Record<string, string[]>> = {},
): HintSymbol[] {
  const ordered = [...file.symbols].sort(
    (a, b) => (matched.has(a.name) ? 0 : 1) - (matched.has(b.name) ? 0 : 1),
  );
  return ordered.slice(0, cap).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    start: symbol.line,
    end: Math.max(symbol.line, symbol.end),
    via: [...(via[symbol.name] ?? [])],
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
  const push = (entry: SuggestedFile, reason: string, matched: string[], cited: boolean): void => {
    const path = entry.path;
    if (excluded.has(path) || out.some((hint) => hint.path === path)) return;
    const file = byPath.get(path);
    const symbols = file ? hintSymbols(file, new Set(matched), cited ? 8 : 5, entry.symbolVia) : [];
    out.push({
      path,
      symbols,
      matched: [...matched],
      reason,
      bytes: file?.bytes ?? 0,
      small: (file?.bytes ?? Number.POSITIVE_INFINITY) < SMALL_HINT_BYTES,
      imports: [...(file?.imports ?? [])],
      importedBy: [...(importedBy.get(path) ?? [])],
      keywords: [...entry.keywords],
    });
  };
  for (const entry of suggestTaskFilesFromMap(map, request, limit)) {
    push(entry, entry.reason, entry.matched, false);
  }
  if (args.repoRoot) {
    for (const anchored of extractAnchoredFiles(args.repoRoot, request)) {
      push({ path: anchored, reason: "", score: 0, matched: [], keywords: [], symbolVia: {} }, "cited in the request", ["cited"], true);
    }
  }
  for (const anchored of extractBareAnchors(map, request)) {
    push({ path: anchored, reason: "", score: 0, matched: [], keywords: [], symbolVia: {} }, "cited in the request", ["cited"], true);
  }
  return out;
}

/** Body-evidence caps: keyword lines stay a pointer, symbol bodies stay small. */
const KEYWORD_LINES_SHOWN = 3;
/** Keywords hitting more lines than this do not localize: omit the lines. */
const KEYWORD_LINES_MAX_HITS = 20;
const HINT_BODY_MAX_LINES = 200;
const HINT_BODIES_MAX_BYTES = 12 * 1024;

/**
 * Fill in body evidence for run prompts: keyword → body line numbers, plus
 * numbered bodies of the matched symbols (edit-ready anchors). Small files
 * are skipped — they already travel whole through the file path. TUI rows
 * skip this (per-frame disk reads); run prompts must not.
 */
export function enrichHints(hints: readonly FileHint[], root: string): FileHint[] {
  return hints.map((hint) => {
    if (hint.small || hint.keywords.length === 0) return hint;
    let raw: string;
    try {
      raw = readFileSync(join(root, hint.path), "utf8");
    } catch {
      return hint;
    }
    const lines = raw.split("\n");
    const keywordLines: Array<{ keyword: string; lines: number[]; hits: number }> = [];
    for (const keyword of hint.keywords) {
      const hits: number[] = [];
      if (keyword.length >= 4) {
        const needle = keyword.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(needle)) hits.push(i + 1);
        }
      } else {
        // Short tokens ("run") substring-match everywhere ("pruning");
        // word boundaries keep them honest.
        let pattern: RegExp;
        try {
          pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        } catch {
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i]!)) hits.push(i + 1);
        }
      }
      if (hits.length > 0 && hits.length <= KEYWORD_LINES_MAX_HITS) {
        keywordLines.push({ keyword, lines: hits.slice(0, KEYWORD_LINES_SHOWN), hits: hits.length });
      }
    }
    const bodies: Array<{ symbol: string; start: number; text: string }> = [];
    let used = 0;
    for (const symbol of hint.symbols) {
      const height = symbol.end - symbol.start + 1;
      if (height <= 0 || height > HINT_BODY_MAX_LINES) continue;
      const text = lines
        .slice(symbol.start - 1, symbol.end)
        .map((line, index) => `${symbol.start + index}: ${line}`)
        .join("\n");
      const cost = Buffer.byteLength(text, "utf8");
      if (used + cost > HINT_BODIES_MAX_BYTES) continue;
      used += cost;
      bodies.push({ symbol: symbol.name, start: symbol.start, text });
    }
    return { ...hint, keywordLines, bodies };
  });
}

/**
 * Render hints as the task-evidence block: per file, why it matched, which
 * keywords hit which symbols and body lines, numbered bodies of the matched
 * symbols (edit-ready — a read can be skipped), relations, and the remaining
 * outline. One place, everything the first prompt needs.
 */
export function renderHints(hints: readonly FileHint[]): string {
  const outlined = hints.filter((hint) => !hint.small);
  if (outlined.length === 0) return "";
  const blocks: string[] = [
    "Suggested files (evidence in one place — numbered bodies are edit-ready, read only what is missing; files under 4KB arrive whole):",
  ];
  for (const hint of outlined) {
    blocks.push(`### ${hint.path} — ${hint.reason}`);
    const evidence: string[] = [];
    const evidenced = new Set<string>();
    for (const symbol of hint.symbols) {
      if (symbol.via.length === 0) continue;
      evidenced.add(symbol.name);
      evidence.push(`"${symbol.via.join('", "')}" → ${symbol.kind} ${symbol.name} (${symbol.start}-${symbol.end})`);
    }
    for (const entry of hint.keywordLines ?? []) {
      if (evidence.some((line) => line.startsWith(`"${entry.keyword}"`))) continue;
      const extra = entry.hits > entry.lines.length ? ` (+${entry.hits - entry.lines.length} more)` : "";
      evidence.push(`"${entry.keyword}" → lines ${entry.lines.join(", ")}${extra}`);
    }
    if (evidence.length > 0) blocks.push(`  ${evidence.join("; ")}`);
    for (const body of hint.bodies ?? []) {
      blocks.push(body.text);
    }
    const relations = [
      ...(hint.imports.length > 0 ? [`imports: ${hint.imports.slice(0, 6).join(", ")}${hint.imports.length > 6 ? ", …" : ""}`] : []),
      ...(hint.importedBy.length > 0 ? [`imported by: ${hint.importedBy.slice(0, 6).join(", ")}${hint.importedBy.length > 6 ? ", …" : ""}`] : []),
    ].join(" · ");
    if (relations) blocks.push(`  ${relations}`);
    const bodied = new Set((hint.bodies ?? []).map((body) => body.symbol));
    const rest = hint.symbols.filter((symbol) => !bodied.has(symbol.name) && !evidenced.has(symbol.name));
    if (rest.length > 0) {
      blocks.push(`  also: ${rest.map((symbol) => `${symbol.kind} ${symbol.name} (${symbol.start}-${symbol.end})`).join(", ")}`);
    }
  }
  return blocks.join("\n");
}

/** Convenience wrapper for callers that have the layout root. */
export function suggestTaskFiles(root: string, request: string, limit = 3): SuggestedFile[] {
  const map = readCachedMap(root);
  return map ? suggestTaskFilesFromMap(map, request, limit) : [];
}
