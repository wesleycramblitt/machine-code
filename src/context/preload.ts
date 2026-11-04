/**
 * machine_code — task preload inference.
 *
 * Build runs should not spend their first turns searching for files the task
 * already names. This module extracts explicit paths from the task text and
 * infers the matching test files. It is deterministic and only returns files
 * that exist inside the worktree.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { loadSemantic, searchSemantic } from "../map/semantic.js";
import { isSecretPath } from "../tools/safety.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts",
  ".json", ".md", ".toml", ".yaml", ".yml",
  ".py", ".rs", ".go", ".java", ".rb", ".sh",
  ".css", ".html", ".vue", ".svelte", ".php",
  ".c", ".h", ".cc", ".cpp", ".hpp",
]);

const IGNORED_PREFIXES = [
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  "coverage/",
  ".git/",
  ".machine_code/local/",
  "knowledge/",
  "plans/",
];

const PATH_RE = /(?:^|[`"'(<\s])([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)/g;

function normalize(root: string, raw: string): string | null {
  let value = raw.trim().replace(/^[`"'(<]+|[`"')>,.;:]+$/g, "");
  if (!value || value.startsWith("http://") || value.startsWith("https://")) return null;
  value = value.replace(/^\.\//, "");
  if (!value || value.startsWith("/") || value.startsWith("~") || value.startsWith("../")) return null;
  if (value.split("/").some((part) => part === "..")) return null;
  if (IGNORED_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  if (isSecretPath(value)) return null;
  if (!CODE_EXTENSIONS.has(extname(value).toLowerCase())) return null;
  const abs = resolve(root, value);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return relative(base, abs).split(sep).join("/");
}

function addUnique(out: string[], path: string | null): void {
  if (path && !out.includes(path)) out.push(path);
}

function inferredTests(path: string): string[] {
  if (!path.startsWith("src/")) return [];
  const extension = extname(path);
  const stem = basename(path, extension);
  const parent = basename(dirname(path));
  const module = parent === "src" ? stem : parent;
  return [
    `test/${module}-${stem}.test.js`,
    `test/${module}-${stem}.test.ts`,
    `test/${stem}.test.js`,
    `test/${stem}.test.ts`,
    `test/${parent}/${stem}.test.js`,
    `test/${parent}/${stem}.test.ts`,
    `test/${stem}.spec.js`,
    `test/${module}/${stem}.test.js`,
  ];
}

/** Extract explicit, existing repo paths from prose or packet JSON. */
export function extractTaskPaths(root: string, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    addUnique(out, normalize(root, match[1] ?? ""));
  }
  return out;
}

/**
 * Files to seed into the working set before a Build starts.
 *
 * Explicit task paths lead, inferred tests follow, then semantic matches when
 * the task text names few concrete files. The caller caps the final list.
 */
export function inferPreloadFiles(root: string, text: string, limit = 6): string[] {
  const out: string[] = [];
  const explicit = extractTaskPaths(root, text);
  for (const path of explicit) addUnique(out, path);
  for (const path of explicit) {
    for (const test of inferredTests(path)) {
      addUnique(out, normalize(root, test));
    }
  }

  const sources = out.filter((path) => path.startsWith("src/")).length;
  if (sources < 2) {
    const semantic = loadSemantic(root);
    if (semantic) {
      for (const match of searchSemantic(semantic, text, 6)) {
        for (const file of match.entry.keyFiles ?? []) {
          addUnique(out, normalize(root, file));
        }
      }
    }
  }
  return out.slice(0, Math.max(1, limit));
}
