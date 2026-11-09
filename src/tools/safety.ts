/**
 * machine_code — tool safety: path bounds, output caps, binary rejection.
 */
import { closeSync, openSync, readSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";

/** Per-call read budget (~25k tokens at 4 chars/token), like Claude Code. */
export const READ_PAGE_BYTES = 100 * 1024;
/** Whole files above this are paged or refused, like Claude Code. */
export const READ_MAX_FILE_BYTES = 256 * 1024;
/** allow_large ceiling; explicit whole-file reads still stop somewhere sane. */
export const READ_LARGE_MAX_BYTES = 1024 * 1024;
export const READ_CAP_BYTES = 24 * 1024;
export const SEARCH_CAP_BYTES = 12 * 1024;
export const COMMAND_CAP_BYTES = 8 * 1024;

/** Always-excluded directory names (plus the repo's own excludes later). */
export const SEARCH_EXCLUDES = [
  ".git",
  ".machine_code/local",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
];

/** Files that never enter a listing, search, map, or model context. */
export const SECRET_GLOBS = [
  "!**/.env",
  "!**/.env.*",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/id_rsa*",
  "!**/id_ed25519*",
  "!**/.npmrc",
  "!**/.netrc",
  "!**/.git-credentials",
];

export class ToolError extends Error {}

/** Resolve a caller path inside root; reject escapes, including symlink hops. */
export function resolveWithin(root: string, callerPath: string): string {
  const base = resolve(root);
  const target = resolve(base, callerPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ToolError(`path escapes the worktree: ${callerPath}`);
  }
  // Symlink check on the deepest existing ancestor (the file itself may not exist yet).
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (probe === target && real !== target) {
        if (real !== base && !real.startsWith(base + sep)) {
          throw new ToolError(`path is a symlink escaping the worktree: ${callerPath}`);
        }
        return real;
      }
      if (!real.startsWith(base) && real !== base) {
        throw new ToolError(`path resolves outside the worktree: ${callerPath}`);
      }
      return target;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const parent = resolve(probe, "..");
      if (parent === probe) return target; // filesystem root; base check above already ran
      probe = parent;
    }
  }
}

export function isBinaryFile(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).includes(0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function assertRegularFile(path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    const hint = missingFileHint(path);
    throw new ToolError(hint ? `no such file: ${path} (did you mean ${hint}?)` : `no such file: ${path}`);
  }
  if (!st.isFile()) throw new ToolError(`not a regular file: ${path}`);
}

/**
 * When a path doesn't exist, look in the same directory for same-basename
 * files with a different extension (e.g. asked .js, have .ts). Returns the
 * single match, or null when there are zero or several candidates.
 */
export function missingFileHint(absPath: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dirname(absPath));
  } catch {
    return null;
  }
  const base = basename(absPath, extname(absPath));
  const matches = entries.filter((e) => {
    if (e === basename(absPath)) return false;
    if (!e.startsWith(base + ".")) return false;
    try {
      return statSync(resolve(dirname(absPath), e)).isFile();
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Resolve a requested absolute path, auto-correcting a wrong extension when
 * the directory holds exactly one same-basename alternative. Returns the
 * resolved path plus the correction note, or null when unresolvable.
 */
export function resolveWithExtensionFallback(absPath: string): { path: string; note: string } | null {
  try {
    if (statSync(absPath).isFile()) return { path: absPath, note: "" };
  } catch {
    // fall through to the hint lookup
  }
  const hint = missingFileHint(absPath);
  if (!hint) return null;
  return { path: resolve(dirname(absPath), hint), note: `resolved ${basename(absPath)} → ${hint}` };
}

export interface Capped {
  text: string;
  truncated: boolean;
}

export function capText(text: string, capBytes: number): Capped {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= capBytes) return { text, truncated: false };
  const sliced = buf.subarray(0, capBytes).toString("utf8");
  return { text: `${sliced}\n[truncated: output capped at ${capBytes} bytes]`, truncated: true };
}

/** ripgrep glob arguments that keep search out of excluded directories and secrets. */
export function excludeGlobs(): string[] {
  return [
    ...SEARCH_EXCLUDES.flatMap((dir) => ["--glob", `!**/${dir}/**`]),
    ...SECRET_GLOBS.flatMap((glob) => ["--glob", glob]),
  ];
}

/** Truncate text to a UTF-8 byte budget without splitting a code point. */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

export interface NumberedPage {
  text: string;
  /** First line not delivered. Equals offset when nothing was delivered. */
  nextOffset: number;
  delivered: number;
  /** True when the first delivered line was cut to fit the byte cap. */
  truncatedLine: boolean;
}

/**
 * Number and emit lines until the byte cap. The continuation offset is derived
 * from delivered lines, never from the requested line slice. This is the fix
 * for the old bug that skipped lines between the byte cut and the line limit.
 */
export function numberLinesCapped(
  lines: readonly string[],
  offset: number,
  limit: number,
  capBytes: number,
): NumberedPage {
  const out: string[] = [];
  let used = 0;
  let nextOffset = offset;
  let truncatedLine = false;
  const last = Math.min(lines.length, offset - 1 + Math.max(1, limit));
  for (let index = offset - 1; index < last; index++) {
    const lineNo = index + 1;
    const raw = lines[index] ?? "";
    const text = `${lineNo}: ${raw}`;
    const cost = Buffer.byteLength(text, "utf8") + (out.length > 0 ? 1 : 0);
    if (used + cost > capBytes) {
      if (out.length === 0) {
        const prefix = `${lineNo}: `;
        const room = Math.max(0, capBytes - Buffer.byteLength(prefix, "utf8"));
        const cut = prefix + truncateToBytes(raw, room);
        out.push(cut);
        used += Buffer.byteLength(cut, "utf8");
        nextOffset = lineNo + 1;
        truncatedLine = true;
      } else {
        nextOffset = lineNo;
      }
      break;
    }
    out.push(text);
    used += cost;
    nextOffset = lineNo + 1;
  }
  return { text: out.join("\n"), nextOffset, delivered: out.length, truncatedLine };
}

/** True when a relative path matches a secret-file glob. */
export function isSecretPath(relPath: string): boolean {
  return SECRET_GLOBS.some((glob) => globToRegExp(glob.slice(1)).test(relPath));
}

/**
 * Match ripgrep-like globs against a path. A glob without "/" matches the
 * basename at any depth; a glob with "/" matches the relative path.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.replaceAll("\\", "/");
  let prefix = "";
  if (pattern.startsWith("**/")) {
    prefix = "(?:.*/)?";
    pattern = pattern.slice(3);
  } else if (!pattern.includes("/")) {
    prefix = "(?:.*/)?";
  }
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // `**/` matches zero or more directories, so `data/**/*.md`
          // includes `data/a.md` as well as `data/x/a.md`.
          body += "(?:.*/)?";
          i += 2;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${prefix}${body}$`);
}

/** Expand simple `{a,b}` alternatives in a glob. */
export function expandGlobBraces(glob: string): string[] {
  const start = glob.indexOf("{");
  if (start === -1) return [glob];
  const end = glob.indexOf("}", start + 1);
  if (end === -1) return [glob];
  const prefix = glob.slice(0, start);
  const body = glob.slice(start + 1, end);
  const suffix = glob.slice(end + 1);
  const parts = body.split(",");
  if (parts.length < 2) return [glob];
  return parts.flatMap((part) => expandGlobBraces(`${prefix}${part}${suffix}`));
}

export function toRelative(root: string, abs: string): string {
  const base = resolve(root);
  return abs.startsWith(base + sep) ? abs.slice(base.length + 1) : abs;
}

export { isAbsolute };
