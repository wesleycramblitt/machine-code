/**
 * machine_code — named, typed commands.
 *
 * M0 ships the four read-only core built-ins. Commands declare a fixed
 * executable, a typed argument schema, a timeout, and capped output. They run
 * with an argument vector (never a shell) in their own process group, with a
 * minimal environment that carries no provider secrets; timeout kills the
 * whole group. Mutating core commands (move/copy/delete/replace/rewrite/
 * rename) and check land with Build and LSP in M1.
 */
import { runProc } from "../proc.js";
import { COMMAND_CAP_BYTES, capText } from "../tools/safety.js";

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
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const GIT_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/^-]*$/;

function asGitRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !GIT_REF.test(value) || value.includes("..")) return undefined;
  return value;
}

const SPECS: CommandSpec[] = [
  {
    name: "core:status",
    description: "Working-tree status (short) with branch and staged/untracked counts.",
    binary: "git",
    args: () => ["status", "--short", "--branch"],
    schema: {},
    readonly: true,
    timeoutMs: 15_000,
  },
  {
    name: "core:diff",
    description: "Diff of the worktree (or one path), optionally staged only.",
    binary: "git",
    args: (a) => {
      const out = ["diff", "--no-color"];
      if (a.staged === true) out.push("--staged");
      const path = asPath(a.path);
      if (path) out.push("--", path);
      return out;
    },
    schema: {
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
    args: (a) => ["show", "--no-color", asGitRef(a.ref) ?? "HEAD"],
    schema: {
      ref: { type: "string", description: "Commit-ish (default HEAD). No '..' ranges." },
    },
    readonly: true,
    timeoutMs: 30_000,
  },
];

export const CORE_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map(
  SPECS.map((spec) => [spec.name, spec]),
);

export interface CommandRunResult {
  text: string;
  isError: boolean;
}

export interface CommandContext {
  root: string;
}

export function describeCommand(name: string): string {
  const spec = CORE_COMMANDS.get(name);
  if (!spec) {
    const known = [...CORE_COMMANDS.keys()].join(", ");
    throw new Error(`unknown command: ${name}. Available: ${known}`);
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
): Promise<CommandRunResult> {
  const spec = CORE_COMMANDS.get(name);
  if (!spec) {
    return {
      text: `unknown command: ${name}. Available: ${[...CORE_COMMANDS.keys()].join(", ")}`,
      isError: true,
    };
  }
  let argv: string[];
  try {
    argv = spec.args(args);
  } catch (error) {
    return { text: `bad arguments: ${(error as Error).message}`, isError: true };
  }
  const result = await runProc(spec.binary, argv, {
    cwd: ctx.root,
    timeoutMs: spec.timeoutMs,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
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
