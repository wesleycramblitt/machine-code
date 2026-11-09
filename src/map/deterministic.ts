/**
 * machine_code — deterministic repository map.
 *
 * The map is a cache of facts: paths, line counts, language, and top-level
 * symbols. It is generated from git (or rg in a non-git tree), sorted, and
 * written under .machine_code/local/cache/. It contains no timestamps and no
 * model output, so equal inputs produce equal bytes.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { runProc, type ProcOptions, type ProcResult } from "../proc.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import {
  SEARCH_EXCLUDES,
  excludeGlobs,
  isSecretPath,
  truncateToBytes,
} from "../tools/safety.js";
import { sectionHeadings, sectionTitle } from "./sections.js";

export const MAP_SCHEMA = 1 as const;
export const MAP_VERSION = 4 as const;
export const MAP_CAP_BYTES = 32 * 1024;
/** Files larger than this are listed but not scanned for symbols. */
const SYMBOL_SCAN_BYTES = 1024 * 1024;

export interface MapSymbol {
  name: string;
  kind: string;
  line: number;
  /** Last line of the symbol's block, trimmed of trailing blank lines. */
  end: number;
  /** Documentation comment or docstring immediately above/inside the symbol. */
  doc?: string;
}

export interface MapFile {
  path: string;
  lang: string;
  bytes: number;
  lines: number;
  symbols: MapSymbol[];
  /** Repo-relative files this file imports, when resolvable. */
  imports?: string[];
  /** File-level documentation comment or module docstring, capped. */
  doc?: string;
  /** Comment banners in large files; used by the module index. */
  sections?: string[];
}

/** Comment section names for large files, or undefined for small files. */
function sectionsFor(text: string, lines: number, bytes: number): string[] | undefined {
  if (lines < 400 && bytes < 20 * 1024) return undefined;
  const sections = sectionHeadings(text)
    .map((heading) => sectionTitle(heading.text))
    .filter(Boolean)
    .slice(0, 24);
  return sections.length > 0 ? sections : undefined;
}

export interface RepoMap {
  schema: typeof MAP_SCHEMA;
  mapVersion: typeof MAP_VERSION;
  root: string;
  head: string;
  files: MapFile[];
}

interface CacheEnvelope {
  sourceKey: string;
  map: RepoMap;
}

interface GitInfo {
  head: string;
  statusRaw: string;
  dirty: string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function relative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function mapProc(
  binary: string,
  args: string[],
  options: ProcOptions,
  processes: ProcessSupervisor | undefined,
): Promise<ProcResult> {
  if (!processes) return runProc(binary, args, options);
  const run = await processes.run(binary, args, {
    ...options,
    origin: "tool",
    name: `map:${binary}`,
  });
  return run.result;
}

export function mapCachePath(root: string): string {
  return join(root, ".machine_code", "local", "cache", "map.json");
}

/** Read the cached map synchronously for TUI previews (never rebuilds). */
export function readCachedMap(root: string): RepoMap | null {
  return readMap(mapCachePath(root))?.map ?? null;
}

/**
 * Directories we know are not source code in a project tree. Work items and
 * harness/runtime state are not an orientation signal for the model. This is
 * deliberately not a list of "boring" folders: docs, data, and anything else
 * that can contain code stays in the map.
 */
const MAP_NON_CODE_DIRS = [".machine_code", ".opencode", "issues"] as const;

function excludedPath(path: string): boolean {
  if (isSecretPath(path)) return true;
  if (MAP_NON_CODE_DIRS.some((entry) => path === entry || path.startsWith(`${entry}/`) || path.includes(`/${entry}/`))) {
    return true;
  }
  return SEARCH_EXCLUDES.some(
    (entry) => path === entry || path.startsWith(`${entry}/`) || path.includes(`/${entry}/`),
  );
}

async function gitInfo(root: string, processes?: ProcessSupervisor): Promise<GitInfo | null> {
  const head = await mapProc("git", ["-C", root, "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 }, processes);
  if (head.outcome !== "exit" || head.code !== 0) return null;
  const status = await mapProc("git", ["-C", root, "status", "--porcelain"], { cwd: root, timeoutMs: 15_000 }, processes);
  if (status.outcome !== "exit" || status.code !== 0) return null;
  const dirty: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3).replace(/^.* -> /, "");
    if (path && !excludedPath(relative(path))) dirty.push(relative(path));
  }
  return { head: head.stdout.trim(), statusRaw: status.stdout, dirty };
}

async function listFiles(root: string, processes?: ProcessSupervisor): Promise<string[]> {
  const git = await gitInfo(root, processes);
  const out = new Set<string>();
  if (git) {
    const tracked = await mapProc("git", ["-C", root, "ls-files", "-z"], { cwd: root, timeoutMs: 20_000 }, processes);
    const untracked = await mapProc(
      "git",
      ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root, timeoutMs: 20_000 },
      processes,
    );
    for (const result of [tracked, untracked]) {
      if (result.outcome !== "exit" || result.code !== 0) continue;
      for (const path of result.stdout.split("\0")) {
        if (path) out.add(relative(path));
      }
    }
  } else {
    const result = await mapProc("rg", ["--files", ...excludeGlobs()], { cwd: root, timeoutMs: 30_000 }, processes);
    if (result.outcome === "exit" && result.code === 0) {
      for (const path of result.stdout.split("\n")) {
        if (path) out.add(relative(path));
      }
    }
  }
  return [...out].filter((path) => !excludedPath(path)).sort();
}

function language(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "ts";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".py":
      return "py";
    case ".rs":
      return "rs";
    case ".go":
      return "go";
    case ".sh":
    case ".bash":
      return "sh";
    case ".json":
      return "json";
    case ".toml":
      return "toml";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".md":
      return "md";
    case ".java":
      return "java";
    case ".cs":
      return "cs";
    case ".kt":
    case ".kts":
      return "kt";
    case ".swift":
      return "swift";
    case ".rb":
      return "rb";
    case ".php":
      return "php";
    case ".lua":
      return "lua";
    case ".c":
    case ".h":
      return "c";
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hh":
    case ".hpp":
      return "cpp";
    case ".dart":
      return "dart";
    case ".ex":
    case ".exs":
      return "ex";
    case ".scala":
      return "scala";
    default:
      return "other";
  }
}

function addSymbol(out: MapSymbol[], name: string | undefined, kind: string, line: number): void {
  if (!name || !/^[A-Za-z_$][\w$!?=]*$/.test(name)) return;
  if (out.some((symbol) => symbol.name === name && symbol.line === line)) return;
  out.push({ name, kind, line, end: line });
}

const DOC_CAP = 800;
const SYMBOL_DOC_CAP = 400;

function cleanDoc(text: string, cap: number): string {
  const cleaned = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\*+\s?/, "")
        .replace(/^\s*\/\/[/!]?\s?/, "")
        .replace(/^\s*#\s?/, "")
        .replace(/^\s*--\s?/, "")
        .trimEnd(),
    )
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^[-=*_]{3,}$/.test(trimmed)) return false;
      return !/^@(?:param|returns?|throws?|see|deprecated|example|type|template)\b/i.test(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length <= cap ? cleaned : `${cleaned.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

function cleanDocstring(text: string, cap: number): string {
  let body = text.trim();
  const quote = body.startsWith('"""') ? '"""' : body.startsWith("'''") ? "'''" : "";
  if (quote) {
    body = body.slice(3);
    const end = body.lastIndexOf(quote);
    if (end >= 0) body = body.slice(0, end);
  }
  return cleanDoc(body, cap);
}

function commentPrefixes(lang: string): string[] {
  if (lang === "py" || lang === "sh" || lang === "rb" || lang === "ex") return ["#"];
  if (lang === "lua") return ["--"];
  if (lang === "php") return ["//", "#"];
  return ["//"];
}

function docAbove(lines: readonly string[], lineIndex: number, lang: string, cap: number): string | undefined {
  let index = lineIndex - 1;
  while (index >= 0 && (lines[index] ?? "").trim() === "") index -= 1;
  if (index < 0) return undefined;
  const trimmed = (lines[index] ?? "").trim();
  if (trimmed.endsWith("*/")) {
    let start = index;
    while (start >= 0 && !(lines[start] ?? "").includes("/*")) start -= 1;
    if (start >= 0) return cleanDoc(lines.slice(start, index + 1).join("\n"), cap);
  }
  const prefixes = commentPrefixes(lang);
  if (!prefixes.some((prefix) => trimmed.startsWith(prefix))) return undefined;
  const collected: string[] = [];
  while (index >= 0) {
    const current = (lines[index] ?? "").trim();
    if (!prefixes.some((prefix) => current.startsWith(prefix))) break;
    collected.unshift(current);
    index -= 1;
  }
  return cleanDoc(collected.join("\n"), cap) || undefined;
}

function docstringAfter(lines: readonly string[], lineIndex: number, cap: number): string | undefined {
  for (let index = lineIndex; index < Math.min(lines.length, lineIndex + 5); index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    const quote = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : "";
    if (!quote) return undefined;
    const collected = [trimmed];
    if (trimmed.indexOf(quote, 3) < 0) {
      for (let next = index + 1; next < Math.min(lines.length, index + 80); next += 1) {
        collected.push(lines[next] ?? "");
        if ((lines[next] ?? "").includes(quote)) break;
      }
    }
    return cleanDocstring(collected.join("\n"), cap) || undefined;
  }
  return undefined;
}

function symbolDoc(lines: readonly string[], lineIndex: number, lang: string): string | undefined {
  if (lang === "py") {
    return docstringAfter(lines, lineIndex + 1, SYMBOL_DOC_CAP) ?? docAbove(lines, lineIndex, lang, SYMBOL_DOC_CAP);
  }
  return docAbove(lines, lineIndex, lang, SYMBOL_DOC_CAP);
}

function fileDoc(lines: readonly string[], lang: string): string | undefined {
  if (lang === "py") {
    for (let index = 0; index < Math.min(lines.length, 40); index += 1) {
      const trimmed = (lines[index] ?? "").trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        return docstringAfter(lines, index, DOC_CAP);
      }
      break;
    }
  }
  const prefixes = commentPrefixes(lang);
  let index = 0;
  while (index < lines.length && !(lines[index] ?? "").trim()) index += 1;
  if (index >= lines.length) return undefined;
  const first = (lines[index] ?? "").trim();
  if (first.startsWith("#!")) return undefined;
  if (first.startsWith("/*")) {
    let end = index;
    while (end < lines.length && !(lines[end] ?? "").includes("*/")) end += 1;
    if (end < lines.length) return cleanDoc(lines.slice(index, end + 1).join("\n"), DOC_CAP) || undefined;
  }
  if (!prefixes.some((prefix) => first.startsWith(prefix))) return undefined;
  const collected: string[] = [];
  while (index < lines.length) {
    const current = (lines[index] ?? "").trim();
    if (!prefixes.some((prefix) => current.startsWith(prefix))) break;
    collected.push(current);
    index += 1;
  }
  return cleanDoc(collected.join("\n"), DOC_CAP) || undefined;
}

/** Regex baseline. It is deliberately top-level only and machine-stable. */
export function extractSymbols(path: string, text: string): MapSymbol[] {
  const lang = language(path);
  const out: MapSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (lang === "ts" || lang === "js") {
      let match = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (match) {
        addSymbol(out, match[2], match[1]!, lineNo);
        continue;
      }
      match = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "const", lineNo);
        continue;
      }
      match = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (match) addSymbol(out, match[1], "class", lineNo);
    } else if (lang === "py") {
      let match = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "def", lineNo);
        continue;
      }
      match = /^class\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[1], "class", lineNo);
    } else if (lang === "rs") {
      const match = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|impl|mod|type|const|static)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[2], match[1]!, lineNo);
    } else if (lang === "go") {
      let match = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "func", lineNo);
        continue;
      }
      match = /^type\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[1], "type", lineNo);
    } else if (lang === "sh") {
      const match = /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)/.exec(line);
      if (match) addSymbol(out, match[1], "shell", lineNo);
    } else if (lang === "java" || lang === "cs") {
      let match = /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|synchronized|native|transient|volatile|partial|internal|readonly|virtual|override|async)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "type", lineNo);
        continue;
      }
      match = /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|internal|override|virtual|async|partial)\s+)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (match) addSymbol(out, match[1], "method", lineNo);
    } else if (lang === "kt") {
      const match = /^\s*(?:(?:public|private|internal|protected|open|final|abstract|sealed|data|inline|suspend|override|operator|infix|tailrec|external|actual|expect|const)\s+)*(fun|class|interface|object|typealias)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[2], match[1] === "fun" ? "fun" : "type", lineNo);
    } else if (lang === "swift") {
      const match = /^\s*(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|nonmutating|async|throws)\s+)*(func|class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[2], match[1] === "func" ? "func" : "type", lineNo);
    } else if (lang === "rb") {
      let match = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "def", lineNo);
        continue;
      }
      match = /^\s*(?:class|module)\s+([A-Z]\w*)/.exec(line);
      if (match) addSymbol(out, match[1], "class", lineNo);
    } else if (lang === "php") {
      const match = /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*(function|class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[2], match[1] === "function" ? "function" : "type", lineNo);
    } else if (lang === "lua") {
      const match = /^\s*(?:local\s+)?function\s+([A-Za-z_]\w*(?:[.:]\w+)?)/.exec(line);
      if (match) addSymbol(out, match[1]!.split(/[.:]/).pop(), "function", lineNo);
    } else if (lang === "c" || lang === "cpp") {
      let match = /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|enum|namespace|union)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "type", lineNo);
        continue;
      }
      match = /^\s*(?!if\b|for\b|while\b|switch\b|return\b|catch\b)(?:[\w:*&<>]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/.exec(line);
      if (match) addSymbol(out, match[1], "function", lineNo);
    } else if (lang === "dart") {
      let match = /^\s*(?:(?:abstract|base|final|interface|sealed|mixin)\s+)*(?:class|mixin|enum|extension|typedef)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "type", lineNo);
        continue;
      }
      match = /^\s*(?:Future|Stream|void|int|String|bool|double|dynamic|[\w<>?]+)\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (match) addSymbol(out, match[1], "function", lineNo);
    } else if (lang === "ex") {
      let match = /^\s*def(?:p)?\s+([A-Za-z_]\w*[!?]?)/.exec(line);
      if (match) {
        addSymbol(out, match[1], "def", lineNo);
        continue;
      }
      match = /^\s*defmodule\s+([A-Z][\w.]*)/.exec(line);
      if (match) addSymbol(out, match[1]!.split(".").pop(), "module", lineNo);
    } else if (lang === "scala") {
      const match = /^\s*(?:case\s+)?(def|class|object|trait)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) addSymbol(out, match[2], match[1] === "def" ? "def" : "type", lineNo);
    }
  }
  out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  for (let i = 0; i < out.length; i++) {
    const nextLine = out[i + 1]?.line ?? lines.length + 1;
    let end = nextLine - 1;
    while (end > out[i]!.line && (lines[end - 1] ?? "").trim() === "") end -= 1;
    out[i]!.end = end;
  }
  for (const symbol of out) {
    const doc = symbolDoc(lines, symbol.line - 1, lang);
    if (doc) symbol.doc = doc;
  }
  return out;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function resolveImport(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
  lang: string,
): string | null {
  const candidates: string[] = [];
  const add = (path: string): void => {
    const normalized = posix.normalize(path);
    if (normalized === ".." || normalized.startsWith("../")) return;
    if (known.has(normalized) && !candidates.includes(normalized)) candidates.push(normalized);
  };

  if (lang === "ts" || lang === "js") {
    if (!specifier.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    add(base);
    const withoutJs = base.replace(/\.(?:js|jsx|mjs|cjs)$/i, "");
    for (const ext of RESOLVE_EXTENSIONS) add(`${withoutJs}${ext}`);
    for (const ext of RESOLVE_EXTENSIONS) add(`${base}${ext}`);
    for (const ext of RESOLVE_EXTENSIONS) add(posix.join(base, `index${ext}`));
    return candidates[0] ?? null;
  }

  if (lang === "py") {
    if (specifier.startsWith(".")) {
      const dots = /^\.+/.exec(specifier)?.[0].length ?? 1;
      const module = specifier.slice(dots).replaceAll(".", "/");
      let dir = posix.dirname(fromPath);
      for (let index = 1; index < dots; index += 1) dir = posix.dirname(dir);
      const base = posix.normalize(posix.join(dir, module));
      add(`${base}.py`);
      add(posix.join(base, "__init__.py"));
    } else {
      const base = specifier.replaceAll(".", "/");
      add(`${base}.py`);
      add(posix.join(base, "__init__.py"));
      add(posix.join("src", `${base}.py`));
      add(posix.join("src", base, "__init__.py"));
    }
    return candidates[0] ?? null;
  }

  if (lang === "rs") {
    const current = posix.dirname(fromPath);
    if (specifier.startsWith("mod:")) {
      const name = specifier.slice(4);
      add(posix.join(current, `${name}.rs`));
      add(posix.join(current, name, "mod.rs"));
      return candidates[0] ?? null;
    }
    if (specifier.startsWith("self:")) {
      const name = specifier.slice(5).replaceAll("::", "/");
      add(posix.join(current, `${name}.rs`));
      add(posix.join(current, name, "mod.rs"));
      return candidates[0] ?? null;
    }
    if (specifier.startsWith("super:")) {
      const name = specifier.slice(6).replaceAll("::", "/");
      const base = posix.join(posix.dirname(current), name);
      add(`${base}.rs`);
      add(posix.join(base, "mod.rs"));
      return candidates[0] ?? null;
    }
    if (specifier.startsWith("crate:")) {
      const name = specifier.slice(6).replaceAll("::", "/");
      const base = posix.join("src", name);
      add(`${base}.rs`);
      add(posix.join(base, "mod.rs"));
      add(posix.join("src", `${name.split("/")[0]}.rs`));
      return candidates[0] ?? null;
    }
  }
  return null;
}

/** Resolve local imports to repo files for the module graph. */
export function extractImports(path: string, text: string, known: ReadonlySet<string>): string[] {
  const lang = language(path);
  const specifiers = new Set<string>();
  if (lang === "ts" || lang === "js") {
    for (const match of text.matchAll(/\b(?:from\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
      if (match[1]) specifiers.add(match[1]);
    }
    for (const match of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
      if (match[1]) specifiers.add(match[1]);
    }
  } else if (lang === "py") {
    for (const match of text.matchAll(/^\s*from\s+(\.[\w.]*)\s+import\b/gm)) {
      if (match[1]) specifiers.add(match[1]);
    }
    for (const match of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/gm)) {
      if (match[1]) specifiers.add(match[1]);
    }
  } else if (lang === "rs") {
    for (const match of text.matchAll(/^\s*use\s+(crate|self|super)::([\w:]+)/gm)) {
      if (match[1] && match[2]) specifiers.add(`${match[1]}:${match[2]}`);
    }
    for (const match of text.matchAll(/^\s*mod\s+(\w+)\s*;/gm)) {
      if (match[1]) specifiers.add(`mod:${match[1]}`);
    }
  } else {
    return [];
  }
  const out = new Set<string>();
  for (const specifier of specifiers) {
    const resolved = resolveImport(path, specifier, known, lang);
    if (resolved) out.add(resolved);
  }
  return [...out].sort();
}

function isBinary(text: string): boolean {
  return text.includes("\0");
}

function readCapped(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > SYMBOL_SCAN_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeMap(file: string, envelope: CacheEnvelope): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(envelope) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function readMap(file: string): CacheEnvelope | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as CacheEnvelope;
    if (raw?.map?.schema !== MAP_SCHEMA || raw.map.mapVersion !== MAP_VERSION) return null;
    if (!Array.isArray(raw.map.files)) return null;
    return raw;
  } catch {
    return null;
  }
}

export interface BuildMapOptions {
  refresh?: boolean;
  /** When present, map helper processes are recorded by the run supervisor. */
  processes?: ProcessSupervisor;
}

export interface BuiltMap {
  map: RepoMap;
  cachePath: string;
  cached: boolean;
}

export async function buildRepoMap(root: string, options: BuildMapOptions = {}): Promise<BuiltMap> {
  const git = await gitInfo(root, options.processes);
  const paths = await listFiles(root, options.processes);
  const stats: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  for (const path of paths) {
    try {
      const stat = statSync(join(root, path));
      if (stat.isFile()) stats.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // deleted between listing and stat
    }
  }
  const sourceKey = sha256(
    `${git?.head ?? ""}\0${git?.statusRaw ?? ""}\0` +
      stats.map((stat) => `${stat.path}:${stat.bytes}:${stat.mtimeMs}`).join("\n"),
  );
  const cachePath = mapCachePath(root);
  if (!options.refresh) {
    const cached = readMap(cachePath);
    if (cached && cached.sourceKey === sourceKey) return { map: cached.map, cachePath, cached: true };
  }

  const known = new Set(stats.map((stat) => stat.path));
  const files: MapFile[] = stats.map((stat) => {
    const text = readCapped(join(root, stat.path));
    const binary = text !== null && isBinary(text);
    const symbols = text && !binary ? extractSymbols(stat.path, text) : [];
    const imports = text && !binary ? extractImports(stat.path, text, known) : [];
    const lineList = text ? text.split("\n") : [];
    const lines = lineList.length;
    const doc = text && !binary ? fileDoc(lineList, language(stat.path)) : undefined;
    const sections = text && !binary ? sectionsFor(text, lines, stat.bytes) : undefined;
    return {
      path: stat.path,
      lang: language(stat.path),
      bytes: stat.bytes,
      lines,
      symbols,
      ...(imports.length > 0 ? { imports } : {}),
      ...(doc ? { doc } : {}),
      ...(sections ? { sections } : {}),
    };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const map: RepoMap = {
    schema: MAP_SCHEMA,
    mapVersion: MAP_VERSION,
    root,
    head: git?.head ?? "",
    files,
  };
  writeMap(cachePath, { sourceKey, map });
  return { map, cachePath, cached: false };
}

function pathMatches(filePath: string, prefix: string | undefined): boolean {
  if (!prefix || prefix === "." || prefix === "./") return true;
  const p = relative(prefix).replace(/\/$/, "");
  return filePath === p || filePath.startsWith(`${p}/`);
}

export interface RenderMapOptions {
  path?: string;
  symbols?: boolean;
  maxBytes?: number;
  maxSymbols?: number;
}

/** Render a deterministic, grouped map. The path filter matches a prefix. */
export function renderRepoMap(map: RepoMap, options: RenderMapOptions = {}): string {
  const files = map.files.filter((file) => pathMatches(file.path, options.path));
  const groups = new Map<string, MapFile[]>();
  for (const file of files) {
    const dir = dirname(file.path) === "." ? "." : dirname(file.path);
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
  const lines: string[] = [];
  const maxSymbols = options.maxSymbols ?? 8;
  for (const dir of dirs) {
    const list = groups.get(dir)!.sort((a, b) => a.path.localeCompare(b.path));
    lines.push(`${dir === "." ? "./" : `${dir}/`} (${list.length} file${list.length === 1 ? "" : "s"})`);
    for (const file of list) {
      const symbols = options.symbols === false
        ? []
        : file.symbols.slice(0, maxSymbols).map((symbol) => `${symbol.name} ${symbol.line}`);
      const suffix = symbols.length > 0 ? ` — ${symbols.join(", ")}` : "";
      lines.push(`  ${basename(file.path)} (${file.lines})${suffix}`);
    }
  }
  const text = lines.join("\n");
  const cap = options.maxBytes ?? MAP_CAP_BYTES;
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  return `${truncateToBytes(text, Math.max(0, cap - 40))}\n[map truncated at ${cap} bytes; narrow with path]`;
}

export function renderOutline(file: MapFile): string {
  return file.symbols.map((symbol) => `${symbol.line} ${symbol.kind} ${symbol.name}`).join("\n");
}

/** True when the map language is source code. */
const NON_CODE_LANGS = new Set(["md", "markdown", "json", "yaml", "yml", "toml", "text", "other", ""]);

export function isCodeLang(lang: string): boolean {
  return !NON_CODE_LANGS.has(lang);
}

/** Top-level module: `src/<dir>` or `src/<file>` for source trees. */
export function moduleOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "src" && parts.length > 1) {
    const second = parts[1]!.replace(/\.[^.]+$/, "");
    return `src/${second}`;
  }
  return parts.length > 1 ? parts[0]! : ".";
}

/** Stable, small repo index for the first prompt. Full slices stay on demand.
 * Modules, not raw first-level directories: `src/tui.ts` and `src/tui/*`
 * count together. A folder is never hidden because of its name, only because
 * its files are not code. */
export function renderMapIndex(map: RepoMap, maxBytes = 1024): string {
  const dirs = new Map<string, number>();
  for (const file of map.files) {
    if (!isCodeLang(file.lang)) continue;
    const dir = moduleOf(file.path);
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const codeFiles = [...dirs.values()].reduce((sum, count) => sum + count, 0);
  const lines = [
    `Repo map: ${codeFiles} code files · head ${map.head || "(no git)"} · ${symbolCount(map)} symbols.`,
    ...[...dirs.entries()]
      .sort((a, b) => (a[0] === "." ? -1 : b[0] === "." ? 1 : a[0].localeCompare(b[0])))
      .map(([dir, count]) => `${dir === "." ? "./" : `${dir}/`} ${count}`),
    "Use map { action: \"overview\", path: \"<dir>\" } for a slice; map { action: \"outline\", path: \"<file>\" } for one file. Use read { symbol } for a block.",
  ];
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${truncateToBytes(text, Math.max(0, maxBytes - 24))}\n[map index truncated]`;
}

export interface SymbolRange {
  name: string;
  kind: string;
  start: number;
  end: number;
}

/** Resolve a top-level symbol to a line range (to the next symbol or EOF). */
export function symbolRange(file: MapFile, name: string): SymbolRange | null {
  const index = file.symbols.findIndex((symbol) => symbol.name === name);
  if (index < 0) return null;
  const symbol = file.symbols[index]!;
  return {
    name: symbol.name,
    kind: symbol.kind,
    start: symbol.line,
    end: Math.max(symbol.line, symbol.end),
  };
}

/** Resolve the symbol that contains a line. */
export function rangeAround(file: MapFile, line: number): SymbolRange | null {
  if (file.symbols.length === 0) return null;
  let found: MapSymbol | null = null;
  for (const symbol of file.symbols) {
    if (symbol.line <= line) found = symbol;
    else break;
  }
  if (!found) found = file.symbols[0]!;
  return symbolRange(file, found.name);
}

export async function outlineFile(root: string, path: string): Promise<MapFile | null> {
  const map = await buildRepoMap(root);
  const file = map.map.files.find((entry) => entry.path === relative(path));
  if (file) return file;
  // The file may be untracked or excluded from the map; parse it directly.
  const text = readCapped(join(root, path));
  if (text === null || isBinary(text)) return null;
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n").length;
  const sections = sectionsFor(text, lines, bytes);
  return {
    path: relative(path),
    lang: language(path),
    bytes,
    lines,
    symbols: extractSymbols(path, text),
    ...(sections ? { sections } : {}),
  };
}

export function mapBytes(map: RepoMap): number {
  return Buffer.byteLength(JSON.stringify(map), "utf8");
}

export function symbolCount(map: RepoMap): number {
  return map.files.reduce((total, file) => total + file.symbols.length, 0);
}

/** Search symbols by substring; used when LSP is unavailable. */
export function findSymbols(map: RepoMap, query: string, limit = 200): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  for (const file of map.files) {
    for (const symbol of file.symbols) {
      if (!symbol.name.toLowerCase().includes(q)) continue;
      out.push(`${file.path}:${symbol.line} ${symbol.kind} ${symbol.name}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

