/**
 * machine_code — named, typed commands.
 *
 * Commands declare a fixed executable or in-process handler, a typed argument
 * schema, a timeout, and capped output. They run with an argument vector
 * (never a shell) in their own process group, with a minimal environment that
 * carries no provider secrets; timeout kills the whole group.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runProc } from "../proc.js";
import { COMMAND_CAP_BYTES, capText, isSecretPath, resolveWithin, toRelative } from "../tools/safety.js";
import { issueCommands } from "./issues.js";
import { referenceCommands } from "./reference.js";
import { researchVerifyCommand } from "./research.js";
import { runCommands } from "./runs.js";
import { scriptCommands } from "./scripts.js";
import { vcsConflictsCommand, vcsMergeAbortCommand, vcsResolveCommand } from "./vcs.js";
import type { Layout } from "../paths.js";

export interface CommandSpec {
  name: string;
  description: string;
  binary: string;
  /** Builds the argument vector from validated typed args. Never interpolates shell. */
  args: (args: Record<string, unknown>) => string[];
  /** JSON-schema-ish description of accepted args, shown by `describe`. */
  schema: Record<string, { type: string; required?: boolean; description?: string }>;
  readonly: boolean;
  timeoutMs: number;
  /** Optional in-process handler; when set, runs instead of spawning `binary`. */
  handler?: (args: Record<string, unknown>, ctx: CommandContext) => Promise<CommandRunResult>;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean {
  return value === true || value === "true";
}

/** Resolve a command path and refuse the worktree root, git internals, runtime
 * state, and secret files. */
function commandPath(root: string, path: string): { abs: string; rel: string } | { error: string } {
  try {
    const abs = resolveWithin(root, path);
    if (abs === resolve(root)) return { error: "refusing to operate on the worktree root" };
    const rel = toRelative(root, abs);
    if (!rel || rel === ".") return { error: "refusing to operate on the worktree root" };
    if (rel === ".git" || rel.startsWith(".git/")) return { error: "refusing to operate on .git" };
    if (rel === ".machine_code/local" || rel.startsWith(".machine_code/local/")) {
      return { error: "refusing to operate on runtime state (.machine_code/local)" };
    }
    if (isSecretPath(rel)) return { error: `refusing to operate on secret path ${rel}` };
    return { abs, rel };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const GIT_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/^-]*$/;

function asGitRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !GIT_REF.test(value) || value.includes("..")) return undefined;
  return value;
}

const SPECS: CommandSpec[] = [
  {
    name: "core:status",
    description:
      "Working-tree status (short) with branch and staged/untracked counts, plus map and LSP health.",
    binary: "git",
    args: () => ["status", "--short", "--branch"],
    schema: {},
    readonly: true,
    timeoutMs: 60_000,
    handler: async (_args, ctx) => {
      const { runStatusCommand } = await import("./map.js");
      return runStatusCommand(ctx.root, ctx.processes);
    },
  },
  {
    name: "core:map",
    description:
      "Deterministic repository map: status, render a path slice with symbols, or refresh the cache.",
    binary: "git",
    args: () => [],
    schema: {
      action: { type: "string", description: "status | render | refresh (default render)." },
      path: { type: "string", description: "Directory or file prefix for render." },
      symbols: { type: "boolean", description: "Include symbols in render (default true)." },
      refresh: { type: "boolean", description: "Rebuild the cache before returning." },
    },
    readonly: true,
    timeoutMs: 60_000,
    handler: async (args, ctx) => {
      const { runMapCommand } = await import("./map.js");
      return runMapCommand(args, ctx.root, ctx.processes);
    },
  },
  {
    name: "core:diff",
    description: "Diff of the worktree, a commit range, or one path.",
    binary: "git",
    args: (a) => {
      const out = ["diff", "--no-color"];
      if (a.staged === true) out.push("--staged");
      const base = typeof a.base === "string" ? a.base.trim() : "";
      if (base) out.push(`${base}...HEAD`);
      const path = asPath(a.path);
      if (path) out.push("--", path);
      return out;
    },
    schema: {
      base: { type: "string", description: "Diff from this ref to HEAD (three-dot)." },
      path: { type: "string", description: "Scope to one path." },
      staged: { type: "boolean", description: "Show staged changes only." },
    },
    readonly: true,
    timeoutMs: 30_000,
  },
  {
    name: "core:history",
    description: "Recent commit history, one line per commit.",
    binary: "git",
    args: (a) => ["log", "--oneline", "--no-color", `-${asInt(a.count, 20, 1, 200)}`],
    schema: {
      count: { type: "number", description: "Number of commits (1-200, default 20)." },
    },
    readonly: true,
    timeoutMs: 15_000,
  },
  {
    name: "core:show",
    description: "Show one commit: message, stat, and patch.",
    binary: "git",
    // Models commonly spell the commit-ish as path/range; accept both rather
    // than silently showing HEAD, which looks like success but answers wrong.
    args: (a) => ["show", "--no-color", asGitRef(a.ref ?? a.path ?? a.range) ?? "HEAD"],
    schema: {
      ref: { type: "string", description: "Commit-ish (default HEAD). No '..' ranges." },
    },
    readonly: true,
    timeoutMs: 30_000,
  },
  {
    name: "core:mkdir",
    description: "Create a directory and any missing parents (typed; no shell).",
    binary: "fs",
    args: () => [],
    schema: { path: { type: "string", required: true, description: "Directory path relative to the worktree root." } },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const path = asPath(args.path);
      if (!path) return { text: "core:mkdir requires path", isError: true };
      const target = commandPath(ctx.root, path);
      if ("error" in target) return { text: target.error, isError: true };
      if (existsSync(target.abs)) {
        return statSync(target.abs).isDirectory()
          ? { text: `${target.rel} already exists`, isError: false }
          : { text: `${target.rel} exists and is not a directory`, isError: true };
      }
      mkdirSync(target.abs, { recursive: true });
      return { text: `created directory ${target.rel}`, isError: false };
    },
  },
  {
    name: "core:move",
    description: "Move or rename a file or directory inside the worktree (typed; no shell).",
    binary: "fs",
    args: () => [],
    schema: {
      from: { type: "string", required: true, description: "Source path." },
      to: { type: "string", required: true, description: "Destination path." },
      force: { type: "boolean", description: "Replace an existing destination (default false)." },
    },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const from = asPath(args.from);
      const to = asPath(args.to);
      if (!from || !to) return { text: "core:move requires from and to", isError: true };
      const src = commandPath(ctx.root, from);
      const dst = commandPath(ctx.root, to);
      if ("error" in src) return { text: src.error, isError: true };
      if ("error" in dst) return { text: dst.error, isError: true };
      if (!existsSync(src.abs)) return { text: `source does not exist: ${src.rel}`, isError: true };
      if (existsSync(dst.abs) && !asBool(args.force)) {
        return { text: `destination exists: ${dst.rel} (pass force=true to replace)`, isError: true };
      }
      mkdirSync(dirname(dst.abs), { recursive: true });
      try {
        renameSync(src.abs, dst.abs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        cpSync(src.abs, dst.abs, { recursive: true, force: true });
        rmSync(src.abs, { recursive: true, force: true });
      }
      return { text: `moved ${src.rel} -> ${dst.rel}`, isError: false };
    },
  },
  {
    name: "core:copy",
    description: "Copy a file or directory inside the worktree (typed; no shell).",
    binary: "fs",
    args: () => [],
    schema: {
      from: { type: "string", required: true, description: "Source path." },
      to: { type: "string", required: true, description: "Destination path." },
      recursive: { type: "boolean", description: "Required when copying a directory." },
      force: { type: "boolean", description: "Replace an existing destination (default false)." },
    },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const from = asPath(args.from);
      const to = asPath(args.to);
      if (!from || !to) return { text: "core:copy requires from and to", isError: true };
      const src = commandPath(ctx.root, from);
      const dst = commandPath(ctx.root, to);
      if ("error" in src) return { text: src.error, isError: true };
      if ("error" in dst) return { text: dst.error, isError: true };
      if (!existsSync(src.abs)) return { text: `source does not exist: ${src.rel}`, isError: true };
      const source = statSync(src.abs);
      const recursive = asBool(args.recursive);
      if (source.isDirectory() && !recursive) {
        return { text: `copying a directory requires recursive=true: ${src.rel}`, isError: true };
      }
      if (existsSync(dst.abs) && !asBool(args.force)) {
        return { text: `destination exists: ${dst.rel} (pass force=true to replace)`, isError: true };
      }
      mkdirSync(dirname(dst.abs), { recursive: true });
      cpSync(src.abs, dst.abs, { recursive, force: asBool(args.force) });
      return { text: `copied ${src.rel} -> ${dst.rel}`, isError: false };
    },
  },
  {
    name: "core:delete",
    description: "Delete a file or directory inside the worktree (typed; no shell). Directories require recursive=true.",
    binary: "fs",
    args: () => [],
    schema: {
      path: { type: "string", required: true, description: "Path to delete." },
      recursive: { type: "boolean", description: "Required when deleting a directory." },
    },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const path = asPath(args.path);
      if (!path) return { text: "core:delete requires path", isError: true };
      const target = commandPath(ctx.root, path);
      if ("error" in target) return { text: target.error, isError: true };
      if (!existsSync(target.abs)) return { text: `path does not exist: ${target.rel}`, isError: true };
      const stat = statSync(target.abs);
      const recursive = asBool(args.recursive);
      if (stat.isDirectory() && !recursive) {
        return { text: `deleting a directory requires recursive=true: ${target.rel}`, isError: true };
      }
      rmSync(target.abs, { recursive, force: false });
      return { text: `deleted ${target.rel}`, isError: false };
    },
  },
];

export const CORE_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ...SPECS.map((spec) => [spec.name, spec] as const),
  ["research:verify", researchVerifyCommand],
  ["vcs:conflicts", vcsConflictsCommand],
  ["vcs:resolve", vcsResolveCommand],
  ["vcs:merge-abort", vcsMergeAbortCommand],
]);

export interface CommandRunResult {
  text: string;
  isError: boolean;
}

export interface CommandContext {
  root: string;
  /** Loaded commands (core + profiles). Falls back to CORE_COMMANDS. */
  commands?: ReadonlyMap<string, CommandSpec>;
  /** When present, spawned commands are recorded by the run supervisor. */
  processes?: import("../processes/supervisor.js").ProcessSupervisor;
  /** When present, files the run has changed (for path-defaulting checks). */
  changedFiles?: () => string[];
}

/** Levenshtein distance, capped by the caller. Command names are short, so the
 * quadratic table is cheap and keeps "did you mean" honest. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Closest available command name, if it is close enough to be a useful hint. */
export function suggestCommand(name: string, available: Iterable<string>): string | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const candidate of available) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith(`:${target}`) || lower === target) return candidate;
    const distance = editDistance(target, lower);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  if (!best) return undefined;
  // One typo in a short name, or a small fraction of a long one.
  const limit = Math.max(2, Math.floor(target.length / 3));
  return best.distance <= limit ? best.name : undefined;
}

export function describeCommand(name: string, commands?: ReadonlyMap<string, CommandSpec>): string {
  const map = commands ?? CORE_COMMANDS;
  const spec = map.get(name);
  if (!spec) {
    const suggestion = suggestCommand(name, map.keys());
    const known = [...map.keys()].join(", ");
    throw new Error(
      `unknown command: ${name}.${suggestion ? ` Did you mean ${suggestion}?` : ""} Available: ${known}`,
    );
  }
  return JSON.stringify(
    {
      name: spec.name,
      description: spec.description,
      readonly: spec.readonly,
      args: spec.schema,
    },
    null,
    2,
  );
}

export async function runCommand(
  name: string,
  args: Record<string, unknown>,
  ctx: CommandContext,
  toolCallId?: string,
): Promise<CommandRunResult> {
  const map = ctx.commands ?? CORE_COMMANDS;
  const spec = map.get(name);
  if (!spec) {
    const suggestion = suggestCommand(name, map.keys());
    return {
      text: `unknown command: ${name}.${suggestion ? ` Did you mean ${suggestion}?` : ""} Available: ${[...map.keys()].join(", ")}`,
      isError: true,
    };
  }
  // Unknown args used to be ignored, so a model that passed a shell string
  // ({cmd:"git show ..."}) got a plausible but wrong answer (HEAD). Reject
  // the call and name the schema instead.
  const supplied = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const allowed = new Set(Object.keys(spec.schema));
  const unknown = Object.keys(supplied).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const shellHint = unknown.some((key) => ["cmd", "command", "shell", "script"].includes(key))
      ? " There is no shell: this command takes typed args, not a command string."
      : "";
    return {
      text:
        `bad arguments for ${name}: unknown ${unknown.join(", ")}.${shellHint} ` +
        `Schema: ${JSON.stringify(spec.schema)}`,
      isError: true,
    };
  }
  if (spec.handler) {
    try {
      return await spec.handler(args, ctx);
    } catch (error) {
      return { text: `command failed: ${(error as Error).message}`, isError: true };
    }
  }
  let argv: string[];
  try {
    argv = spec.args(args);
  } catch (error) {
    return { text: `bad arguments: ${(error as Error).message}`, isError: true };
  }
  const procOptions = {
    cwd: ctx.root,
    timeoutMs: spec.timeoutMs,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  };
  const result = ctx.processes
    ? (
        await ctx.processes.run(spec.binary, argv, {
          ...procOptions,
          origin: "command",
          name: spec.name,
          ...(toolCallId ? { toolCallId } : {}),
        })
      ).result
    : await runProc(spec.binary, argv, procOptions);
  if (result.outcome === "spawn-error") {
    return { text: `configuration gap: ${result.spawnError}`, isError: true };
  }
  if (result.outcome === "timeout") {
    return { text: `${spec.name} timed out after ${spec.timeoutMs}ms (process group killed)`, isError: true };
  }
  const capped = capText(result.stdout.trimEnd(), COMMAND_CAP_BYTES);
  if (result.code !== 0) {
    return {
      text: `${spec.name} exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}${capped.text ? `\n${capped.text}` : ""}`,
      isError: true,
    };
  }
  return { text: capped.text || "(no output)", isError: false };
}

export function allCommands(
  layout: Layout,
  options: { scriptsRoot?: string } = {},
): Map<string, CommandSpec> {
  const out = new Map<string, CommandSpec>(CORE_COMMANDS);
  for (const spec of issueCommands(layout.repoRoot)) out.set(spec.name, spec);
  for (const [k, v] of referenceCommands(layout)) out.set(k, v);
  for (const [k, v] of runCommands(layout)) out.set(k, v);
  if (options.scriptsRoot) {
    for (const [k, v] of scriptCommands(options.scriptsRoot)) out.set(k, v);
  }
  return out;
}
