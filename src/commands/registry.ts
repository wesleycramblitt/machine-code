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
import { spawn } from "node:child_process";
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

/** Minimal environment: enough for the binary, never provider secrets. */
function commandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function runCommand(
  name: string,
  args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandRunResult> {
  const spec = CORE_COMMANDS.get(name);
  if (!spec) {
    return Promise.resolve({
      text: `unknown command: ${name}. Available: ${[...CORE_COMMANDS.keys()].join(", ")}`,
      isError: true,
    });
  }
  let argv: string[];
  try {
    argv = spec.args(args);
  } catch (error) {
    return Promise.resolve({ text: `bad arguments: ${(error as Error).message}`, isError: true });
  }
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(spec.binary, argv, {
        cwd: ctx.root,
        env: commandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group: timeout kills the group, not just the leader.
        detached: true,
      });
    } catch (error) {
      resolvePromise({
        text: `configuration gap: ${spec.binary} is not runnable: ${(error as Error).message}`,
        isError: true,
      });
      return;
    }
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const settle = (result: CommandRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      settle({ text: `${spec.name} timed out after ${spec.timeoutMs}ms (process group killed)`, isError: true });
    }, spec.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle({
        text:
          error.code === "ENOENT"
            ? `configuration gap: ${spec.binary} is not installed or not on PATH`
            : `${spec.name} failed to start: ${error.message}`,
        isError: true,
      });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8").trimEnd();
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      const capped = capText(stdout, COMMAND_CAP_BYTES);
      if (code !== 0) {
        settle({
          text: `${spec.name} exited ${code}: ${stderr || "(no stderr)"}${capped.text ? `\n${capped.text}` : ""}`,
          isError: true,
        });
        return;
      }
      settle({ text: capped.text || "(no output)", isError: false });
    });
  });
}
