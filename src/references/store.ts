/**
 * machine_code — central reference store access.
 *
 * The store lives at `~/.machine_code/references/` and uses the same indexed
 * bundle layout as OpenCode:
 *
 *   references/
 *     index.md              generated catalog
 *     topics.yaml           generated topic -> citation map
 *     <product>/<version>/
 *       manifest.yaml
 *       index.md            hand-authored topic map
 *       api-index.md        generated symbol -> citation map
 *       content/*.md        small cited files
 *       raw/                archival originals; never read by agents
 *     <product>/             flat bundle with no version dir (e.g. mc-26-3-ui-ux)
 *       manifest.yaml
 *       index.md
 *       api-index.md
 *       content/*.md
 *
 * Agents resolve a topic or symbol through the indexes, then read exactly one
 * `content/file.md#anchor`. The store is outside the worktree, so reference
 * commands are the only path that can read or write it. There is exactly
 * one store: no repo-level view, no per-project copies.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Layout } from "../paths.js";
import { packageDataDir } from "../data.js";

export interface ReferencePath {
  abs: string;
  rel: string;
  anchor?: string;
}

export type ReferenceReadResult =
  | { ok: true; path: string; anchor?: string; text: string; bytes: number; truncated: boolean }
  | { ok: false; error: string };

const READ_CAP = 12 * 1024;
const FIND_CAP = 40;

export function referenceStore(layout: Layout): string {
  return join(layout.home, "references");
}

function stripKnownRoots(value: string): string {
  return value
    .replace(/^machine:/, "")
    .replace(/^~\//, "")
    .replace(/^\.machine_code\/references\//, "")
    .replace(/^\.config\/opencode\/references\//, "")
    .replace(/^references\//, "");
}

/** Resolve a citation, bundle key, or store-relative path. */
export function resolveReferencePath(
  layout: Layout,
  value: string,
): ReferencePath | null {
  let raw = value.trim();
  if (!raw || /^[a-z]+:\/\//i.test(raw)) return null;
  const hash = raw.indexOf("#");
  const anchor = hash >= 0 ? raw.slice(hash + 1).trim() || undefined : undefined;
  if (hash >= 0) raw = raw.slice(0, hash);
  let rel = stripKnownRoots(raw.trim());
  if (!rel) return null;
  if (rel.split("/").includes("..")) return null;

  // A bare bundle key resolves to its hand-authored topic map.
  // Two-part keys are <product>/<version>; one-part keys are flat bundles
  // with no version dir (e.g. mc-26-3-ui-ux) or a product with a single
  // version (e.g. minecraft-java -> minecraft-java/26.3).
  const parts = rel.split("/").filter(Boolean);
  const isBareKey =
    (parts.length === 2 || parts.length === 1) &&
    !rel.endsWith(".md") &&
    !rel.endsWith(".yaml");
  if (isBareKey) {
    rel = `${rel}/index.md`;
  }

  const storeRoot = referenceStore(layout);
  // Product-only fallback: <product>/index.md does not exist when the
  // product has version dirs. If there is exactly one version and it holds
  // an index.md, resolve to it instead of failing.
  if (parts.length === 1 && isBareKey) {
    const single = (() => {
      try {
        const entries = readdirSync(join(storeRoot, parts[0]!), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        const withIndex = entries.filter((v) => existsSync(join(storeRoot, parts[0]!, v, "index.md")));
        return withIndex.length === 1 ? withIndex[0] : undefined;
      } catch {
        return undefined;
      }
    })();
    if (single) rel = `${parts[0]}/${single}/index.md`;
  }
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(storeRoot, rel);
  const inStore = abs === storeRoot || abs.startsWith(storeRoot + sep);
  if (inStore && existsSync(abs)) {
    return { abs, rel: relative(storeRoot, abs), ...(anchor ? { anchor } : {}) };
  }
  // A full content citation (<product>/<version>/content/<file> or
  // <product>/unversioned/content/<file>) may not exist verbatim when the
  // product has a single version dir. Resolve it against the store layout:
  // product dir, then the single version dir, then the content path. The
  // `unversioned` segment is the canonical name for that single version.
  if (parts.length >= 3 && !rel.includes("/raw/")) {
    const product = parts[0]!;
    const versionOrUnversioned = parts[1]!;
    const rest = parts.slice(2).join("/");
    const candidates: string[] = [];
    if (versionOrUnversioned === "unversioned") {
      // <product>/unversioned/content/<file> — find the single version dir.
      try {
        const entries = readdirSync(join(storeRoot, product), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        if (entries.length === 1) {
          candidates.push(`${product}/${entries[0]}/${rest}`);
        }
      } catch {
        // product dir missing; fall through
      }
    } else {
      // <product>/<version>/content/<file> — try the version as written, then
      // fall back to the single version dir if the written one is absent.
      candidates.push(rel);
      try {
        const entries = readdirSync(join(storeRoot, product), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        if (entries.length === 1 && entries[0] !== versionOrUnversioned) {
          candidates.push(`${product}/${entries[0]}/${rest}`);
        }
      } catch {
        // product dir missing; fall through
      }
    }
    for (const candidate of candidates) {
      const candidateAbs = resolve(storeRoot, candidate);
      if (existsSync(candidateAbs)) {
        return { abs: candidateAbs, rel: relative(storeRoot, candidateAbs), ...(anchor ? { anchor } : {}) };
      }
    }
  }
  // Bundle-relative citations (`content/...` as printed in older api-index
  // rows and hand-authored topic maps) are not store paths. Resolve an
  // unambiguous suffix match; ambiguity falls through to the not-found
  // error below, which names the candidates.
  if (rel.includes("/")) {
    const matches = matchReferenceSuffix(storeRoot, rel);
    if (matches.length === 1) {
      return { abs: resolve(storeRoot, matches[0]!), rel: matches[0]!, ...(anchor ? { anchor } : {}) };
    }
  }
  // Return the machine store path even if it doesn't exist — the caller
  // (readReference) does its own existence check and produces a better
  // error message for missing files.
  return inStore ? { abs, rel: relative(storeRoot, abs), ...(anchor ? { anchor } : {}) } : null;
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function anchorOf(heading: string): { title: string; anchor: string } {
  const match = /\{#([A-Za-z0-9._-]+)\}\s*$/.exec(heading);
  if (match) {
    return {
      title: heading.slice(0, match.index).trim(),
      anchor: match[1]!,
    };
  }
  return { title: heading.trim(), anchor: slugify(heading) };
}

function extractSection(text: string, anchor: string): { text: string; anchors: string[] } | null {
  const lines = text.split("\n");
  const headings: Array<{ index: number; level: number; anchor: string; title: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[index]!);
    if (!match) continue;
    const parsed = anchorOf(match[2]!);
    headings.push({ index, level: match[1]!.length, ...parsed });
  }
  const start = headings.find((heading) => heading.anchor === anchor);
  if (!start) return { text: "", anchors: headings.map((heading) => heading.anchor) };
  let end = lines.length;
  for (const heading of headings) {
    if (heading.index <= start.index) continue;
    if (heading.level <= start.level) {
      end = heading.index;
      break;
    }
  }
  return { text: lines.slice(start.index, end).join("\n").trim(), anchors: [] };
}

function capped(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap).replace(/\s+$/, "") + "\n…[truncated]", truncated: true };
}

export interface ReferenceSearchOptions {
  /** `product` or `product/version`. Required for the content/code tiers. */
  bundle?: string;
  /** Search `content/**` bodies in addition to the index layer. */
  content?: boolean;
  /**
   * Search non-index bundle files (source repos, data) — everything except
   * `raw/` and `.git/`. This is the explicit opt-in for full-repo lookup; the
   * archival `raw/` dirs stay out of every tier.
   */
  code?: boolean;
  /** Treat the query as a raw regex (grep semantics) instead of fixed text. */
  regex?: boolean;
  /** Max matches returned. */
  limit?: number;
}

const SEARCH_CAP_CHARS = 12 * 1024;

/** rg over one bundle's content and/or code files. Index hits stay in findReferences. */
export function searchReferenceFiles(
  storeRoot: string,
  query: string,
  opts: ReferenceSearchOptions = {},
): string {
  const q = query.trim();
  if (!q) return "reference:find requires query";
  if (!opts.bundle?.trim()) {
    return "reference:find needs bundle: for content/code search, e.g. bundle 'minecraft-java/26.3'";
  }
  const resolved = resolveReferenceBundle(storeRoot, opts.bundle);
  if ("error" in resolved) return resolved.error;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit ?? 20))));
  const args = [
    "-n",
    "--no-heading",
    "--color",
    "never",
    "-i",
    "-C",
    "2",
    "--max-count",
    String(Math.min(limit * 3, 60)),
    // Bare names match at any depth (gitignore semantics); slashed patterns
    // anchor at the store root, so bundle-nested dirs need the **/ form.
    "-g",
    "!.git",
    "-g",
    "!raw",
  ];
  if (opts.content && !opts.code) args.push("-g", "**/content/**");
  if (opts.code && !opts.content) {
    args.push("-g", "!**/content/**", "-g", "!index.md", "-g", "!api-index.md", "-g", "!manifest.yaml", "-g", "!topics.yaml");
  }
  if (opts.regex) args.push("-e", q);
  else args.push("-F", "-e", q);
  args.push("--", resolved.rel);
  const run = spawnSync("rg", args, {
    cwd: storeRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error) return `reference:find code search failed: ${(run.error as Error).message}`;
  // rg exit 1 with no output = no matches. Anything else nonzero is a real error.
  if (run.status !== 0 && run.status !== 1) {
    const detail = run.stderr?.trim() || `exit ${run.status ?? "?"}`;
    return `reference:find code search failed: ${detail}`;
  }
  const text = (run.stdout ?? "").trimEnd();
  if (!text) {
    const tiers = [opts.content ? "content" : "", opts.code ? "code" : ""].filter(Boolean).join("+");
    return `no ${tiers} matches for "${q}" in ${resolved.rel}`;
  }
  const lines = text.split("\n");
  const capped = lines.slice(0, limit * 5);
  const tail = capped.length < lines.length ? `\n…[${lines.length - capped.length} more lines; narrow with bundle:, content:, or a tighter query]` : "";
  const head = `search ${resolved.rel} (${[opts.content ? "content" : "", opts.code ? "code" : ""].filter(Boolean).join("+") || "index"}):\n`;
  const body = capped.join("\n");
  const out = `${head}${body}${tail}`;
  return out.length > SEARCH_CAP_CHARS ? `${out.slice(0, SEARCH_CAP_CHARS)}\n…[truncated]` : out;
}

export interface ReferenceReadOptions {
  /** 1-based first line of the selected body (whole file or anchored section). */
  offset?: number;
  /** Max lines from offset. The byte cap still applies on top. */
  lines?: number;
  /** Return the heading outline (title + anchor per heading) instead of body text. */
  outline?: boolean;
}

const LIST_DIR_CAP = 300;
const LIST_DIR_DEPTH = 4;

/** Capped recursive listing for bundle directories (source-repo discovery). */
function listReferenceDir(abs: string, rel: string): string {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (out.length >= LIST_DIR_CAP || depth > LIST_DIR_DEPTH) {
      truncated = truncated || out.length >= LIST_DIR_CAP;
      return;
    }
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== ".git" && e.name !== "raw")
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? (a.name < b.name ? -1 : 1) : a.isDir ? -1 : 1));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= LIST_DIR_CAP) {
        truncated = true;
        return;
      }
      out.push(`${prefix}${entry.name}${entry.isDir ? "/" : ""}`);
      if (entry.isDir) walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
    }
  };
  walk(abs, rel ? `${rel}/` : "", 0);
  const tail = truncated ? `\n…[listing capped at ${LIST_DIR_CAP} entries; read a subdirectory to narrow]` : "";
  return `dir ${rel || "."} (${out.length} entries):\n${out.join("\n")}${tail}`;
}

/** Heading outline with the anchors `reference:read` accepts. */
function outlineSections(text: string): string {
  const rows: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[index]!);
    if (!match) continue;
    const parsed = anchorOf(match[2]!);
    rows.push(`${"  ".repeat(match[1]!.length - 1)}${parsed.title} -> #${parsed.anchor} (line ${index + 1})`);
  }
  return rows.length > 0 ? rows.join("\n") : "(no headings)";
}

/** Read one cited store file, optionally narrowed to a heading anchor. */
export function readReference(
  layout: Layout,
  value: string,
  cap = READ_CAP,
  opts: ReferenceReadOptions = {},
): ReferenceReadResult {
  const target = resolveReferencePath(layout, value);
  if (!target) return { ok: false, error: `reference is outside the store: ${value}` };
  if (target.rel.split("/").includes("raw")) {
    return { ok: false, error: "raw/ is archival; read the indexed content file instead" };
  }
  if (target.rel.split("/").includes(".git")) {
    return { ok: false, error: "refusing .git/ metadata; read the checked-out source file instead" };
  }
  let isDir = false;
  try {
    isDir = statSync(target.abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    if (target.anchor) return { ok: false, error: `cannot anchor into a directory: ${target.rel}` };
    const text = listReferenceDir(target.abs, target.rel);
    return { ok: true, path: target.rel, text, bytes: Buffer.byteLength(text, "utf8"), truncated: text.includes("…[listing capped") };
  }
  if (!existsSync(target.abs)) {
    const candidates = matchReferenceSuffix(referenceStore(layout), target.rel);
    const hint =
      candidates.length > 0 ? ` Did you mean ${candidates.slice(0, 3).join(", ")}?` : "";
    return { ok: false, error: `reference not found: ${target.rel}.${hint}` };
  }
  let text: string;
  try {
    text = readFileSync(target.abs, "utf8");
  } catch {
    return { ok: false, error: `reference is unreadable: ${target.rel}` };
  }
  let body = text;
  if (target.anchor) {
    const section = extractSection(text, target.anchor);
    if (!section) return { ok: false, error: `reference not found: ${target.rel}` };
    if (!section.text) {
      const known = section.anchors.slice(0, 20).join(", ") || "(none)";
      return { ok: false, error: `anchor "${target.anchor}" not found in ${target.rel}. Anchors: ${known}` };
    }
    body = section.text;
  }
  if (opts.outline === true) {
    const outline = outlineSections(body);
    return { ok: true, path: target.rel, ...(target.anchor ? { anchor: target.anchor } : {}), text: outline, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
  }
  const offset = Math.max(1, Math.floor(Number(opts.offset ?? 1)));
  const maxLines = opts.lines === undefined ? undefined : Math.max(1, Math.floor(Number(opts.lines)));
  if ((offset > 1 || maxLines !== undefined) && Number.isFinite(offset) && (maxLines === undefined || Number.isFinite(maxLines))) {
    const all = body.split("\n");
    const slice = maxLines === undefined ? all.slice(offset - 1) : all.slice(offset - 1, offset - 1 + maxLines);
    const tag = `<lines ${offset}-${offset + slice.length - 1} of ${all.length}>\n`;
    body = slice.length > 0 ? `${tag}${slice.join("\n")}` : `${tag}(empty range)`;
  }
  const clipped = capped(body, cap);
  return {
    ok: true,
    path: target.rel,
    ...(target.anchor ? { anchor: target.anchor } : {}),
    text: clipped.text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: clipped.truncated,
  };
}

/**
 * Bundle-relative fallback: api-index rows and hand-authored topic maps cite
 * files as `content/...` relative to their bundle, which is not a store path.
 * Match such a value as a suffix against real bundle files (flat bundles and
 * version dirs alike, `raw/` excluded). Callers auto-resolve only an
 * unambiguous single match; ambiguity is reported, never guessed.
 */
export function matchReferenceSuffix(storeRoot: string, rel: string): string[] {
  if (!rel.includes("/") || rel.split("/").includes("..")) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let products: string[] = [];
  try {
    products = readdirSync(storeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const consider = (candidate: string): void => {
    if (candidate.split("/").includes("raw")) return;
    try {
      if (!statSync(resolve(storeRoot, candidate)).isFile()) return;
    } catch {
      return;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  };
  for (const product of products) {
    consider(`${product}/${rel}`);
    let versions: string[] = [];
    try {
      versions = readdirSync(join(storeRoot, product), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const version of versions) consider(`${product}/${version}/${rel}`);
  }
  return out.sort();
}

/**
 * Resolve a `product` or `product/version` bundle name to its store dir.
 * A bare product with exactly one version dir resolves to that version, and a
 * flat bundle (index.md at the product root, no version dir) resolves to the
 * product dir — the same rules bare citation keys follow.
 */
export function resolveReferenceBundle(
  storeRoot: string,
  bundle: string,
): { dir: string; rel: string } | { error: string } {
  const raw = bundle.trim().replace(/^~\//, "").replace(/^references\//, "");
  if (!raw || raw.split("/").includes("..")) return { error: `unknown bundle: ${bundle}` };
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return { error: `unknown bundle: ${bundle}` };
  const product = parts[0]!;
  let entries: string[] = [];
  try {
    entries = readdirSync(join(storeRoot, product), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { error: `unknown bundle: ${bundle}` };
  }
  if (parts.length === 2) {
    const version = parts[1]!;
    if (!entries.includes(version)) return { error: `unknown bundle: ${bundle}` };
    return { dir: resolve(storeRoot, product, version), rel: `${product}/${version}` };
  }
  if (existsSync(join(storeRoot, product, "index.md"))) {
    return { dir: resolve(storeRoot, product), rel: product };
  }
  const withIndex = entries.filter((version) => existsSync(join(storeRoot, product, version, "index.md")));
  if (withIndex.length === 1) {
    return { dir: resolve(storeRoot, product, withIndex[0]!), rel: `${product}/${withIndex[0]!}` };
  }
  if (withIndex.length > 1) {
    return { error: `ambiguous bundle: ${bundle} — did you mean ${withIndex.slice(0, 5).map((v) => `${product}/${v}`).join(", ")}?` };
  }
  return { error: `unknown bundle: ${bundle}` };
}

export interface ReferenceFindOptions {
  /** Scope the index scan (and content/code tiers) to one `product` or `product/version` bundle. */
  bundle?: string;
  /** Search `content/**` bodies in addition to the index layer. Needs bundle:. */
  content?: boolean;
  /** Search non-index bundle files (source repos, data). Needs bundle:. Never touches `raw/`. */
  code?: boolean;
  /** Treat the query as a raw regex for the content/code tiers (index tier stays substring). */
  regex?: boolean;
  /** Skip the index layer; content/code tiers only. */
  index?: boolean;
}

/** Search the cheap index layer, never bundle content or raw files. */
export function findReferences(
  layout: Layout,
  query: string,
  limit = 20,
  opts: ReferenceFindOptions = {},
): string {
  const q = query.trim().toLowerCase();
  if (!q) return "reference:find requires query";
  const store = referenceStore(layout);
  let bundleRel: string | undefined;
  if (opts.bundle?.trim()) {
    const resolved = resolveReferenceBundle(store, opts.bundle);
    if ("error" in resolved) return resolved.error;
    bundleRel = resolved.rel;
  }
  const out: string[] = [];

  if (opts.index !== false) {
    out.push(findIndexMatches(layout, query, limit, bundleRel));
  }
  if (opts.content === true || opts.code === true) {
    out.push(
      searchReferenceFiles(store, query, {
        bundle: bundleRel ?? opts.bundle,
        content: opts.content,
        code: opts.code,
        regex: opts.regex,
        limit,
      }),
    );
  }
  return out.filter(Boolean).join("\n");
}

/** Substring scan over the index layer (api-index, index, topics, catalog). */
function findIndexMatches(
  layout: Layout,
  query: string,
  limit: number,
  bundleRel: string | undefined,
): string {
  const q = query.trim().toLowerCase();
  const files: string[] = [];
  const store = referenceStore(layout);

  // Exact symbol/API matches are the most useful result, so scan api-index
  // files before the broader topic map and catalog.
  if (existsSync(store)) {
    let products: string[] = [];
    try {
      products = readdirSync(store, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      products = [];
    }
    for (const product of products) {
      // Flat bundle with no version dir (e.g. mc-26-3-ui-ux).
      const flatApi = join(store, product, "api-index.md");
      if (existsSync(flatApi)) files.push(flatApi);
      const flatIndex = join(store, product, "index.md");
      if (existsSync(flatIndex)) files.push(flatIndex);
      let versions: string[] = [];
      try {
        versions = readdirSync(join(store, product), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        versions = [];
      }
      for (const version of versions) {
        const api = join(store, product, version, "api-index.md");
        if (existsSync(api)) files.push(api);
        const bundleIndex = join(store, product, version, "index.md");
        if (existsSync(bundleIndex)) files.push(bundleIndex);
      }
    }
  }
  if (existsSync(store)) {
    for (const name of ["topics.yaml", "index.md"]) {
      const file = join(store, name);
      if (existsSync(file)) files.push(file);
    }
  }

  const hits: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (hits.length >= Math.min(FIND_CAP, limit)) break;
    const rel = relative(store, file);
    if (bundleRel !== undefined && !(rel === bundleRel || rel.startsWith(`${bundleRel}/`))) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let topic = "";
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (file.endsWith("topics.yaml") && /^\S.*:$/.test(line)) topic = line.slice(0, -1);
      const hay = `${topic} ${line}`.toLowerCase();
      if (!hay.includes(q)) continue;
      const hit = `${rel}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`;
      if (seen.has(hit)) continue;
      seen.add(hit);
      hits.push(hit);
      if (hits.length >= Math.min(FIND_CAP, limit)) break;
    }
  }
  if (hits.length === 0) return `no reference index matches for "${query}"`;
  return `reference store: ${store}\n${hits.join("\n")}`;
}

/** Write one file under the central store. */
export function writeReference(
  layout: Layout,
  path: string,
  content: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const rel = stripKnownRoots(path.trim());
  if (!rel || rel.split("/").includes("..") || isAbsolute(rel)) {
    return { ok: false, error: `reference path escapes the store: ${path}` };
  }
  const root = referenceStore(layout);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, error: `reference path escapes the store: ${path}` };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return { ok: true, path: abs };
}

function indexScript(layout: Layout): string | undefined {
  // The repo's own script is the authoritative implementation: it stays in
  // sync with store.ts and references.ts in this tree. External copies shadow
  // it today and were in danger of going stale, so prefer the shipped one and
  // fall back to external copies only if it is missing.
  const shipped = join(packageDataDir(), "scripts", "reference-index.py");
  if (existsSync(shipped)) return shipped;
  const candidates = [
    join(layout.home, "skills", "reference-index", "reference-index.py"),
    join(process.env.HOME ?? "", ".config", "opencode", "skills", "reference-index", "reference-index.py"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Regenerate the store catalog/topics/api-index. */
export function reindexReferences(layout: Layout, check = false): string {
  const script = indexScript(layout);
  if (!script) return "reference:reindex: reference-index.py not found";
  const store = referenceStore(layout);
  const run = spawnSync("python3", [script, "store", store, ...(check ? ["--check"] : [])], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const parts = [run.stdout?.trim(), run.stderr?.trim()].filter(Boolean);
  if (run.status !== 0) return `reference:reindex failed: ${parts.join("\n") || `exit ${run.status}`}`;
  return parts.filter(Boolean).join("\n") || "reference indexes up to date";
}

export function referenceFileSize(layout: Layout, value: string): number {
  const target = resolveReferencePath(layout, value);
  if (!target || !existsSync(target.abs)) return 0;
  try {
    return statSync(target.abs).size;
  } catch {
    return 0;
  }
}

export interface ReferenceEntry {
  /** Citation as the agent would write it (resolves via resolveReferencePath). */
  citation: string;
  /** Store-relative target path. */
  path: string;
  bytes: number;
  /** File mtime (ms since epoch) driving the recent sort. */
  mtime: number;
  exists: boolean;
}

const LIST_CAP = 500;

/** Bundle-level catalog of the reference store for the TUI browser. */
export function listReferenceEntries(layout: Layout): ReferenceEntry[] {
  const store = referenceStore(layout);
  const out: ReferenceEntry[] = [];
  const seen = new Set<string>();
  const push = (citation: string, abs: string): void => {
    if (seen.has(citation) || out.length >= LIST_CAP) return;
    seen.add(citation);
    let bytes = 0;
    let mtime = 0;
    try {
      const st = statSync(abs);
      bytes = st.size;
      mtime = st.mtimeMs;
    } catch {
      // keep the row visible with an unknown size
    }
    out.push({
      citation,
      path: relative(store, abs),
      bytes,
      mtime,
      exists: existsSync(abs),
    });
  };
  const root = store;
  {
    if (existsSync(root)) {
      let products: string[] = [];
      try {
        products = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        products = [];
      }
      for (const product of products) {
        // Flat bundle with no version dir (e.g. mc-26-3-ui-ux).
        const flatIndex = join(root, product, "index.md");
        if (existsSync(flatIndex)) push(product, flatIndex);
        else {
          const flatManifest = join(root, product, "manifest.yaml");
          if (existsSync(flatManifest)) push(product, flatManifest);
        }
        let versions: string[] = [];
        try {
          versions = readdirSync(join(root, product), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        } catch {
          versions = [];
        }
        for (const version of versions) {
          const index = join(root, product, version, "index.md");
          if (existsSync(index)) push(`${product}/${version}`, index);
          else {
            const manifest = join(root, product, version, "manifest.yaml");
            if (existsSync(manifest)) push(`${product}/${version}`, manifest);
          }
        }
      }
      for (const name of ["index.md", "topics.yaml"]) {
        const file = join(root, name);
        if (existsSync(file)) push(name, file);
      }
    }
  }
  return out.sort((a, b) => (a.citation < b.citation ? -1 : 1));
}
