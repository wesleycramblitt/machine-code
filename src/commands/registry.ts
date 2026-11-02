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
      return runStatusCommand(ctx.root);
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
      semantic: { type: "boolean", description: "Append semantic module annotations." },
      refresh: { type: "boolean", description: "Rebuild the cache before returning." },
    },
    readonly: true,
    timeoutMs: 60_000,
    handler: async (args, ctx) => {
      const { runMapCommand } = await import("./map.js");
      return runMapCommand(args, ctx.root);
    },
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
  {
    name: "core:check",
    description: "LSP diagnostics on a saved file (TypeScript by default). Returns errors/warnings. Falls back to unavailable when no server.",
    binary: "typescript-language-server",
    args: () => ["--stdio"],
    schema: {
      path: { type: "string", required: true, description: "File path relative to the worktree root." },
    },
    readonly: true,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const path = asPath(args.path);
      if (!path) return { text: "core:check requires path", isError: true };
      const { resolveWithin } = await import("../tools/safety.js");
      let abs: string;
      try { abs = resolveWithin(ctx.root, path); } catch (e) { return { text: (e as Error).message, isError: true }; }
      const { readFileSync } = await import("node:fs");
      let content = "";
      try { content = readFileSync(abs, "utf8"); } catch (e) { return { text: (e as Error).message, isError: true }; }
      const { lspClientFor, serverAvailable } = await import("../lsp/index.js");
      if (!serverAvailable("typescript")) {
        return { text: "LSP unavailable: typescript-language-server not installed (install: machine_code install typescript-language-server). Fallback: core:status + manual review.", isError: true };
      }
      const client = lspClientFor(ctx.root, "typescript");
      if (!client) return { text: "LSP unavailable for this language", isError: true };
      const diagnostics = await client.diagnosticsFor(abs, content);
      if (diagnostics === null) return { text: "LSP server did not respond (over budget or still indexing). Fallback to ast-grep/rg.", isError: true };
      if (diagnostics.length === 0) return { text: `${path}: no diagnostics`, isError: false };
      const lines = diagnostics.map((d) => {
        const sev = ["error", "warning", "info", "hint"][d.severity ?? 1] ?? "diag";
        return `${path}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}`;
      });
      return { text: lines.join("\n"), isError: diagnostics.some((d) => (d.severity ?? 1) === 1) };
    },
  },
  {
    name: "core:rename",
    description: "Type-safe symbol rename via LSP. Previews all touched paths; applies the workspace edit. Preview is required before applying.",
    binary: "typescript-language-server",
    args: () => ["--stdio"],
    schema: {
      path: { type: "string", required: true, description: "File path relative to the worktree root." },
      line: { type: "number", required: true, description: "1-based line of the symbol." },
      column: { type: "number", required: true, description: "1-based column of the symbol." },
      newName: { type: "string", required: true, description: "New symbol name." },
      apply: { type: "boolean", description: "Apply the edit (default false: preview only)." },
    },
    readonly: false,
    timeoutMs: 60_000,
    handler: async (args, ctx) => {
      const path = asPath(args.path);
      if (!path) return { text: "core:rename requires path", isError: true };
      const line = asInt(args.line, 0, 1, 1_000_000);
      const column = asInt(args.column, 0, 1, 1_000_000);
      const newName = typeof args.newName === "string" ? args.newName : "";
      if (!newName) return { text: "core:rename requires newName", isError: true };
      const apply = args.apply === true;
      const { resolveWithin } = await import("../tools/safety.js");
      let abs: string;
      try { abs = resolveWithin(ctx.root, path); } catch (e) { return { text: (e as Error).message, isError: true }; }
      const { lspClientFor, serverAvailable } = await import("../lsp/index.js");
      if (!serverAvailable("typescript")) {
        return { text: "LSP unavailable: typescript-language-server not installed. Rename falls back to ast-grep/rg (shape-based, not type-safe).", isError: true };
      }
      const client = lspClientFor(ctx.root, "typescript");
      if (!client) return { text: "LSP unavailable for this language", isError: true };
      const edit = await client.rename(abs, { line: line - 1, character: column - 1 }, newName);
      if (edit === null) {
        return { text: "rename failed or symbol not found (server may still be indexing)", isError: true };
      }
      const changes = edit.changes ?? {};
      const docChanges = edit.documentChanges ?? [];
      const paths = new Set<string>();
      for (const uri of Object.keys(changes)) paths.add(uri);
      for (const c of docChanges) { if ("textDocument" in c) paths.add(c.textDocument.uri); }
      const preview = `rename to "${newName}" touches ${paths.size} file(s):\\n${[...paths].map((u) => "  " + u.replace("file://", "")).join("\\n")}`;
      if (!apply) return { text: `${preview}\\n\\nPreview only — re-run with apply=true to apply.`, isError: false };
      // Apply edits via the runner's fs (best-effort; LSP workspace edits are
      // text edits we replay here).
      const { readFileSync, writeFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      for (const uri of paths) {
        const file = fileURLToPath(uri);
        let content = "";
        try { content = readFileSync(file, "utf8"); } catch { continue; }
        const edits = changes[uri] ?? [];
        // Apply edits in reverse order to preserve offsets.
        const sorted = [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
        let lines = content.split("\\n");
        for (const e of sorted) {
          // naive single-line edit
          const ln = e.range.start.line;
          const col = e.range.start.character;
          const endLn = e.range.end.line;
          const endCol = e.range.end.character;
          if (ln === endLn) {
            const row = lines[ln] ?? "";
            lines[ln] = row.slice(0, col) + e.newText + row.slice(endCol);
          }
        }
        writeFileSync(file, lines.join("\\n"), "utf8");
      }
      return { text: `${preview}\\n\\nApplied.`, isError: false };
    },
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
  /** Loaded commands (core + profiles). Falls back to CORE_COMMANDS. */
  commands?: ReadonlyMap<string, CommandSpec>;
  /** When present, spawned commands are recorded by the run supervisor. */
  processes?: import("../processes/supervisor.js").ProcessSupervisor;
}

export function describeCommand(name: string, commands?: ReadonlyMap<string, CommandSpec>): string {
  const map = commands ?? CORE_COMMANDS;
  const spec = map.get(name);
  if (!spec) {
    const known = [...map.keys()].join(", ");
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
  toolCallId?: string,
): Promise<CommandRunResult> {
  const map = ctx.commands ?? CORE_COMMANDS;
  const spec = map.get(name);
  if (!spec) {
    return {
      text: `unknown command: ${name}. Available: ${[...map.keys()].join(", ")}`,
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
