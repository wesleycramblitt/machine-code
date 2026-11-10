/**
 * machine_code — suggested context from the deterministic map.
 *
 * Hints are context, not a second prompt. Score only what the map already
 * knows: path, file doc header, symbol names/doc comments, and section
 * headings. No body scans, no identifier-variant guessing. Good code docs are
 * what make this rank well.
 */
import { readCachedMap, type RepoMap } from "./deterministic.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "why",
  "where", "when", "are", "was", "were", "you", "your", "its", "into", "about",
  "does", "use", "used", "using", "can", "will", "should", "would", "could",
  "please", "one", "two", "all", "any", "not", "but", "has", "have", "had",
  "them", "they", "their", "then", "than", "also", "just", "make", "need",
]);

export interface SuggestedFile {
  path: string;
  reason: string;
  score: number;
}

function tokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

function firstLine(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Rank map files for the request using docs, symbols, sections, and paths. */
export function suggestTaskFilesFromMap(
  map: RepoMap,
  request: string,
  limit = 3,
): SuggestedFile[] {
  const wanted = tokens(request);
  if (wanted.length === 0) return [];
  const words = normalized(request).split(" ").filter(Boolean);
  const phrases = new Set<string>();
  for (let i = 0; i + 1 < words.length; i += 1) phrases.add(`${words[i]} ${words[i + 1]}`);
  const code = map.files.filter((file) =>
    /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cc|cpp|cs)$/i.test(file.path),
  );
  const total = Math.max(1, code.length);
  const df = new Map<string, number>();
  for (const token of wanted) {
    df.set(
      token,
      code.filter((file) => {
        const text = [
          file.path,
          file.doc ?? "",
          ...file.symbols.map((symbol) => symbol.name),
          ...file.symbols.map((symbol) => symbol.doc ?? ""),
          ...(file.sections ?? []),
        ].join(" ").toLowerCase();
        return text.includes(token);
      }).length,
    );
  }
  const idf = (token: string): number => Math.log((total + 1) / ((df.get(token) ?? 0) + 1));
  const ranked = code.map((file) => {
    const path = file.path.toLowerCase();
    const doc = (file.doc ?? "").toLowerCase();
    const sections = (file.sections ?? []).join(" ").toLowerCase();
    const names = file.symbols.map((symbol) => symbol.name).join(" ").toLowerCase();
    const symbolDocs = file.symbols.map((symbol) => symbol.doc ?? "").join(" ").toLowerCase();
    let score = 0;
    let reason = "";
    for (const token of wanted) {
      const weight = idf(token) ** 2;
      if (path.includes(token)) {
        score += 1.2 * weight;
        reason ||= file.path;
      }
      if (doc.includes(token)) {
        score += 1.2 * weight;
        reason ||= firstLine(file.doc ?? "");
      }
      if (sections.includes(token)) {
        score += 1.2 * weight;
        const heading = (file.sections ?? []).find((section) => section.toLowerCase().includes(token));
        if (heading) reason ||= `section: ${heading}`;
      }
      if (names.includes(token)) score += 0.4 * weight;
      if (symbolDocs.includes(token)) {
        score += 1.6 * weight;
        if (!reason) {
          const symbol = file.symbols.find((entry) => (entry.doc ?? "").toLowerCase().includes(token));
          if (symbol) reason = `${symbol.name}: ${firstLine(symbol.doc ?? "", 90)}`;
        }
      }
    }
    // A documented phrase in code ("Min-fit ladder") beats generic file prose
    // ("model selection"). Normalize punctuation so Min-fit == min fit.
    const codeText = normalized([sections, names, symbolDocs].join(" "));
    const docText = normalized(doc);
    for (const phrase of phrases) {
      if (codeText.includes(phrase)) {
        score += 4;
        if (!reason) reason = `doc: ${phrase}`;
      } else if (docText.includes(phrase)) {
        score += 2;
      }
    }
    return { path: file.path, reason: reason || (file.doc ? firstLine(file.doc) : file.path), score };
  });
  return ranked
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit));
}

/** Convenience wrapper for callers that have the layout root. */
export function suggestTaskFiles(root: string, request: string, limit = 3): SuggestedFile[] {
  const map = readCachedMap(root);
  return map ? suggestTaskFilesFromMap(map, request, limit) : [];
}
