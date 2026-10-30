/**
 * machine_code — tool safety: path bounds, output caps, binary rejection.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

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
    throw new ToolError(`no such file: ${path}`);
  }
  if (!st.isFile()) throw new ToolError(`not a regular file: ${path}`);
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

/** ripgrep glob arguments that keep search out of excluded directories. */
export function excludeGlobs(): string[] {
  return SEARCH_EXCLUDES.flatMap((dir) => ["--glob", `!**/${dir}/**`]);
}

export function toRelative(root: string, abs: string): string {
  const base = resolve(root);
  return abs.startsWith(base + sep) ? abs.slice(base.length + 1) : abs;
}

export { isAbsolute };
