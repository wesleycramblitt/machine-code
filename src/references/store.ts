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
 *
 * Agents resolve a topic or symbol through the indexes, then read exactly one
 * `content/file.md#anchor`. The store is outside the worktree, so reference
 * commands are the only path that can read or write it.
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

export function referenceView(layout: Layout): string {
  return join(layout.repoDir, "references");
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
export function resolveReferencePath(layout: Layout, value: string): ReferencePath | null {
  let raw = value.trim();
  if (!raw || /^[a-z]+:\/\//i.test(raw)) return null;
  const hash = raw.indexOf("#");
  const anchor = hash >= 0 ? raw.slice(hash + 1).trim() || undefined : undefined;
  if (hash >= 0) raw = raw.slice(0, hash);
  let rel = stripKnownRoots(raw.trim());
  if (!rel) return null;
  if (rel.split("/").includes("..")) return null;

  // A bare bundle key resolves to its hand-authored topic map.
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 2 && !rel.endsWith(".md") && !rel.endsWith(".yaml")) {
    rel = `${rel}/index.md`;
  }

  const root = referenceStore(layout);
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return { abs, rel: relative(root, abs), ...(anchor ? { anchor } : {}) };
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

/** Read one cited store file, optionally narrowed to a heading anchor. */
export function readReference(layout: Layout, value: string, cap = READ_CAP): ReferenceReadResult {
  const target = resolveReferencePath(layout, value);
  if (!target) return { ok: false, error: `reference is outside the store: ${value}` };
  if (target.rel.split("/").includes("raw")) {
    return { ok: false, error: "raw/ is archival; read the indexed content file instead" };
  }
  if (!existsSync(target.abs)) return { ok: false, error: `reference not found: ${target.rel}` };
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

/** Search the cheap index layer, never bundle content or raw files. */
export function findReferences(layout: Layout, query: string, limit = 20): string {
  const q = query.trim().toLowerCase();
  if (!q) return "reference:find requires query";
  const files: string[] = [];
  const store = referenceStore(layout);
  const view = referenceView(layout);

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
      }
    }
  }
  for (const root of [store, view]) {
    if (!existsSync(root)) continue;
    for (const name of ["topics.yaml", "index.md"]) {
      const file = join(root, name);
      if (existsSync(file)) files.push(file);
    }
  }

  const hits: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (hits.length >= Math.min(FIND_CAP, limit)) break;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(store, file);
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

/** Write one file under the store or a project view. */
export function writeReference(
  layout: Layout,
  path: string,
  content: string,
  scope: "store" | "project" = "store",
): { ok: true; path: string } | { ok: false; error: string } {
  let rel = stripKnownRoots(path.trim());
  if (!rel || rel.split("/").includes("..") || isAbsolute(rel)) {
    return { ok: false, error: `reference path escapes the store: ${path}` };
  }
  const root = scope === "project" ? referenceView(layout) : referenceStore(layout);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, error: `reference path escapes the store: ${path}` };
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  if (scope === "project" && rel !== "links.yaml") {
    const links = join(root, "links.yaml");
    if (!existsSync(links)) {
      writeFileSync(links, `store: ${referenceStore(layout)}\nlinks: []\n`, "utf8");
    }
  }
  return { ok: true, path: abs };
}

function indexScript(layout: Layout): string | undefined {
  const candidates = [
    join(layout.home, "skills", "reference-index", "reference-index.py"),
    join(process.env.HOME ?? "", ".config", "opencode", "skills", "reference-index", "reference-index.py"),
    join(packageDataDir(), "scripts", "reference-index.py"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Regenerate the store catalog/topics/api-index and an optional project view. */
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
  const view = referenceView(layout);
  if (existsSync(join(view, "links.yaml"))) {
    const viewRun = spawnSync("python3", [script, "view", view, ...(check ? ["--check"] : [])], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const viewParts = [viewRun.stdout?.trim(), viewRun.stderr?.trim()].filter(Boolean);
    if (viewRun.status !== 0) {
      return `${parts.join("\n")}\nreference:reindex view failed: ${viewParts.join("\n") || `exit ${viewRun.status}`}`;
    }
    parts.push(viewParts.join("\n"));
  }
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
