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
import { basename, dirname, join } from "node:path";
import { runProc } from "../proc.js";
import {
  SEARCH_EXCLUDES,
  excludeGlobs,
  isSecretPath,
  truncateToBytes,
} from "../tools/safety.js";

export const MAP_SCHEMA = 1 as const;
export const MAP_VERSION = 1 as const;
export const MAP_CAP_BYTES = 32 * 1024;
/** Files larger than this are listed but not scanned for symbols. */
const SYMBOL_SCAN_BYTES = 1024 * 1024;

export interface MapSymbol {
  name: string;
  kind: string;
  line: number;
  /** Last line of the symbol's block, trimmed of trailing blank lines. */
  end: number;
}

export interface MapFile {
  path: string;
  lang: string;
  bytes: number;
  lines: number;
  symbols: MapSymbol[];
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

export function mapCachePath(root: string): string {
  return join(root, ".machine_code", "local", "cache", "map.json");
}

function excludedPath(path: string): boolean {
  if (isSecretPath(path)) return true;
  return SEARCH_EXCLUDES.some(
    (entry) => path === entry || path.startsWith(`${entry}/`) || path.includes(`/${entry}/`),
  );
}

async function gitInfo(root: string): Promise<GitInfo | null> {
  const head = await runProc("git", ["-C", root, "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
  if (head.outcome !== "exit" || head.code !== 0) return null;
  const status = await runProc("git", ["-C", root, "status", "--porcelain"], { cwd: root, timeoutMs: 15_000 });
  if (status.outcome !== "exit" || status.code !== 0) return null;
  const dirty: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3).replace(/^.* -> /, "");
    if (path && !excludedPath(relative(path))) dirty.push(relative(path));
  }
  return { head: head.stdout.trim(), statusRaw: status.stdout, dirty };
}

async function listFiles(root: string): Promise<string[]> {
  const git = await gitInfo(root);
  const out = new Set<string>();
  if (git) {
    const tracked = await runProc("git", ["-C", root, "ls-files", "-z"], { cwd: root, timeoutMs: 20_000 });
    const untracked = await runProc("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      timeoutMs: 20_000,
    });
    for (const result of [tracked, untracked]) {
      if (result.outcome !== "exit" || result.code !== 0) continue;
      for (const path of result.stdout.split("\0")) {
        if (path) out.add(relative(path));
      }
    }
  } else {
    const result = await runProc("rg", ["--files", ...excludeGlobs()], { cwd: root, timeoutMs: 30_000 });
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
    default:
      return "other";
  }
}

function addSymbol(out: MapSymbol[], name: string | undefined, kind: string, line: number): void {
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
  if (out.some((symbol) => symbol.name === name && symbol.line === line)) return;
  out.push({ name, kind, line, end: line });
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
    }
  }
  out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  for (let i = 0; i < out.length; i++) {
    const nextLine = out[i + 1]?.line ?? lines.length + 1;
    let end = nextLine - 1;
    while (end > out[i]!.line && (lines[end - 1] ?? "").trim() === "") end -= 1;
    out[i]!.end = end;
  }
  return out;
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
}

export interface BuiltMap {
  map: RepoMap;
  cachePath: string;
  cached: boolean;
}

export async function buildRepoMap(root: string, options: BuildMapOptions = {}): Promise<BuiltMap> {
  const git = await gitInfo(root);
  const paths = await listFiles(root);
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

  const files: MapFile[] = stats.map((stat) => {
    const text = readCapped(join(root, stat.path));
    const symbols = text && !isBinary(text) ? extractSymbols(stat.path, text) : [];
    return {
      path: stat.path,
      lang: language(stat.path),
      bytes: stat.bytes,
      lines: text ? text.split("\n").length : 0,
      symbols,
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

/** Stable, small repo index for the first prompt. Full slices stay on demand. */
export function renderMapIndex(map: RepoMap, maxBytes = 1024): string {
  const dirs = new Map<string, number>();
  for (const file of map.files) {
    const slash = file.path.indexOf("/");
    const dir = slash < 0 ? "." : file.path.slice(0, slash);
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const lines = [
    `Repo map: ${map.files.length} files · head ${map.head || "(no git)"} · ${symbolCount(map)} symbols.`,
    ...[...dirs.entries()]
      .sort((a, b) => (a[0] === "." ? -1 : b[0] === "." ? 1 : a[0].localeCompare(b[0])))
      .map(([dir, count]) => `${dir === "." ? "./" : `${dir}/`} ${count}`),
    "Use core:map --path <dir> for a slice. Use search outline <file> or read { symbol } for a range.",
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
  return {
    path: relative(path),
    lang: language(path),
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text.split("\n").length,
    symbols: extractSymbols(path, text),
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

