/**
 * machine_code — the six core tools.
 *
 * Exactly six: read, write, edit, search, command, task. Everything else is a
 * named typed command dispatched through `command`. Tools never get a shell.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runProc } from "../proc.js";
import {
  READ_CAP_BYTES,
  SEARCH_CAP_BYTES,
  ToolError,
  assertRegularFile,
  capText,
  excludeGlobs,
  globToRegExp,
  isBinaryFile,
  isSecretPath,
  numberLinesCapped,
  resolveWithin,
  toRelative,
} from "./safety.js";
import {
  buildRepoMap,
  findSymbols,
  outlineFile,
  renderOutline,
  renderRepoMap,
  symbolRange,
  rangeAround,
} from "../map/deterministic.js";
import { describeCommand, runCommand, type CommandRunResult } from "../commands/registry.js";
import { askTool, type AskContext } from "./ask.js";
import { taskTool, type TaskContext } from "./task.js";
import { issueTool, type IssueToolContext } from "./issues.js";
import { artifactTool, type ArtifactToolContext } from "./artifact.js";
import { prTool, type PrToolContext } from "./pr.js";
import { contextTool } from "./context.js";
import type { RunStateStore } from "../context/state.js";

export interface ToolContext {
  /** Worktree root every path is bound to. */
  root: string;
  /** Loaded commands (core + profiles). */
  commands: ReadonlyMap<string, import("../commands/registry.js").CommandSpec>;
  /** When provided, the `ask` tool is live (suspends the run for input). */
  ask?: AskContext;
  /** When provided, the `task` tool is live (capability-gated delegation). */
  task?: TaskContext;
  /** When provided, the `issue` tool is live (capability-gated issue access). */
  issues?: IssueToolContext;
  /** When provided, the `artifact` tool is live (tools/scripts inventory). */
  artifacts?: ArtifactToolContext;
  /** When provided, the `pr` tool is live (capability-gated PR access). */
  prs?: PrToolContext;
  /** Run state for the `context` tool. */
  state?: RunStateStore;
  /** When present, spawned commands/processes are recorded by the supervisor. */
  processes?: import("../processes/supervisor.js").ProcessSupervisor;
}

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

/* -------------------------------------------------------------------- read */

const ReadParams = Type.Object({
  path: Type.String({ description: "File path, relative to the worktree root." }),
  offset: Type.Optional(Type.Number({ description: "1-based line to start at (default 1)." })),
  limit: Type.Optional(Type.Number({ description: "Max lines to return (default 2000)." })),
  symbol: Type.Optional(Type.String({ description: "Top-level symbol to read (resolved from the repo map)." })),
  around: Type.Optional(Type.Number({ description: "1-based line; read the symbol that contains it." })),
});

export function readTool(ctx: ToolContext): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "read",
    description:
      "Read a file inside the worktree. Use symbol or around for a surgical range; offset/limit page. " +
      "Capped at 24 KiB per call; a bare full read of a larger file returns its outline. Binary files are rejected.",
    parameters: ReadParams,
    async execute(_id, params: Static<typeof ReadParams>) {
      try {
        const abs = resolveWithin(ctx.root, params.path);
        assertRegularFile(abs);
        if (isBinaryFile(abs)) return fail(`refusing to read a binary file: ${params.path}`);
        const raw = readFileSync(abs, "utf8");
        const lines = raw.split("\n");
        const bytes = Buffer.byteLength(raw, "utf8");
        if (params.symbol && params.around !== undefined) {
          return fail("use symbol or around, not both");
        }
        if ((params.symbol || params.around !== undefined) && (params.offset !== undefined || params.limit !== undefined)) {
          return fail("use symbol/around or offset/limit, not both");
        }

        let offset = Math.max(1, Math.floor(params.offset ?? 1));
        let limit = Math.max(1, Math.floor(params.limit ?? 2000));
        let header = "";

        if (params.symbol || params.around !== undefined) {
          const file = await outlineFile(ctx.root, params.path);
          const range = file
            ? params.symbol
              ? symbolRange(file, params.symbol)
              : rangeAround(file, params.around!)
            : null;
          if (!range) {
            if (params.around !== undefined && !params.symbol) {
              // No symbols in the file: fall back to a small line window.
              offset = Math.max(1, params.around - 20);
              limit = 41;
              header = `${params.path}:${offset}-${offset + 40} (around ${params.around})`;
            } else {
              const suggestion = file && file.symbols.length > 0
                ? file.symbols.slice(0, 12).map((symbol) => `${symbol.line} ${symbol.kind} ${symbol.name}`).join("\n")
                : "(no symbols)";
              return fail(
                `no ${params.symbol ? `symbol "${params.symbol}"` : `symbol around line ${params.around}`} in ${params.path}. ` +
                `Known symbols:\n${suggestion}`,
              );
            }
          } else {
            offset = range.start;
            limit = Math.max(1, range.end - range.start + 1);
            header = `${params.path}:${range.start}-${range.end} (${range.name})`;
          }
        } else if (bytes > READ_CAP_BYTES && params.offset === undefined && params.limit === undefined) {
          const file = await outlineFile(ctx.root, params.path);
          const outline = file ? renderOutline(file) : "(no symbols)";
          return ok(
            `[${params.path} is ${lines.length} lines / ${bytes} bytes; full read exceeds ${READ_CAP_BYTES} bytes]\n` +
            `${outline}\nRead a symbol or a range.`,
          );
        }

        if (offset > lines.length) {
          return ok(`[offset ${offset} is past the end of ${params.path} (${lines.length} lines)]`);
        }
        const page = numberLinesCapped(lines, offset, limit, READ_CAP_BYTES);
        const notes: string[] = [];
        if (page.truncatedLine) {
          notes.push(`[line ${page.nextOffset - 1} truncated at ${READ_CAP_BYTES} bytes]`);
        }
        if (page.nextOffset <= lines.length) {
          notes.push(
            `[${lines.length - (page.nextOffset - 1)} more lines; call read with offset ${page.nextOffset}]`,
          );
        }
        return ok([header, page.text, ...notes].filter(Boolean).join("\n"));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* ------------------------------------------------------------------- write */

const WriteParams = Type.Object({
  path: Type.String({ description: "File path, relative to the worktree root." }),
  content: Type.String({ description: "Full file content to write." }),
});

export function writeTool(ctx: ToolContext): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "write",
    description: "Write a file inside the worktree, creating parent directories.",
    parameters: WriteParams,
    async execute(_id, params: Static<typeof WriteParams>) {
      try {
        const abs = resolveWithin(ctx.root, params.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, params.content, "utf8");
        return ok(`wrote ${params.path} (${Buffer.byteLength(params.content, "utf8")} bytes)`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* -------------------------------------------------------------------- edit */

const EditParams = Type.Object({
  path: Type.String({ description: "File path, relative to the worktree root." }),
  oldString: Type.String({ description: "Exact text to find." }),
  newString: Type.String({ description: "Replacement text (must differ from oldString)." }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence (default false: a unique match is required)." }),
  ),
});

export function editTool(ctx: ToolContext): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Exact-match replacement in a file. Without replaceAll the match must be unique.",
    parameters: EditParams,
    async execute(_id, params: Static<typeof EditParams>) {
      try {
        if (params.oldString === params.newString) {
          return fail("oldString and newString must differ");
        }
        const abs = resolveWithin(ctx.root, params.path);
        assertRegularFile(abs);
        const raw = readFileSync(abs, "utf8");
        const count = raw.split(params.oldString).length - 1;
        if (count === 0) return fail(`no match in ${params.path}`);
        if (!params.replaceAll && count > 1) {
          return fail(`${count} matches in ${params.path}; add context to make the match unique or set replaceAll`);
        }
        const next = params.replaceAll
          ? raw.split(params.oldString).join(params.newString)
          : raw.replace(params.oldString, params.newString);
        writeFileSync(abs, next, "utf8");
        return ok(`edited ${params.path} (${count} replacement${count === 1 ? "" : "s"})`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* ------------------------------------------------------------------ search */

const SEARCH_MODES: readonly string[] = [
  "map", "files", "outline", "text", "structure", "json", "yaml",
  "definition", "references", "symbols", "info",
];

const SearchParams = Type.Object({
  mode: Type.Union(
    [
      Type.Literal("map"),
      Type.Literal("files"),
      Type.Literal("outline"),
      Type.Literal("text"),
      Type.Literal("structure"),
      Type.Literal("json"),
      Type.Literal("yaml"),
      Type.Literal("definition"),
      Type.Literal("references"),
      Type.Literal("symbols"),
      Type.Literal("info"),
    ],
    { description: "Search mode." },
  ),
  pattern: Type.Optional(Type.String({ description: "Pattern: regex for text, glob for files, query for json/yaml/structure, symbol name for semantic modes." })),
  path: Type.Optional(Type.String({ description: "Directory or file to scope the search (default: worktree root)." })),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Specific files or directories for text mode. Use instead of path.",
    }),
  ),
  line: Type.Optional(Type.Number({ description: "1-based line (semantic modes)." })),
  column: Type.Optional(Type.Number({ description: "1-based column (semantic modes)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 200)." })),
});

async function exec(
  binary: string,
  args: string[],
  cwd: string,
  capBytes: number,
): Promise<AgentToolResult<undefined>> {
  const result = await runProc(binary, args, { cwd, timeoutMs: 30_000 });
  if (result.outcome === "spawn-error") {
    return fail(`configuration gap: ${result.spawnError}`);
  }
  if (result.outcome === "timeout") {
    return fail(`${binary} timed out after 30s (process group killed)`);
  }
  if (result.code !== 0 && result.stdout.length === 0) {
    // rg/ast-grep exit 1 for "no matches" — not a tool error.
    if (result.code === 1) return ok("no matches");
    return fail(`${binary} exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
  }
  return ok(capText(result.stdout.trimEnd(), capBytes).text || "no matches");
}

const SEMANTIC_MODES = new Set(["definition", "references", "symbols", "info"]);

export function searchTool(ctx: ToolContext): AgentTool<typeof SearchParams> {
  return {
    name: "search",
    label: "search",
    description:
      "Read-only bounded search. Modes: map (filtered repo map with symbols), files (file listing), outline (one file's symbols), text (regex), " +
      "structure (ast-grep pattern), json/yaml (jq/yq query, e.g. `.scripts`), and semantic definition/references/symbols/info (LSP, from M1). " +
      "text accepts paths to search a specific file list. Never touches excluded directories " +
      "(node_modules, dist, build, target, .git, .machine_code/local, ...), secret files (.env, *.pem, keys), or binary files.",
    parameters: SearchParams,
    async execute(_id, params: Static<typeof SearchParams>) {
      const scope = params.path ? resolveWithin(ctx.root, params.path) : ctx.root;
      const limit = Math.max(1, Math.floor(params.limit ?? 200));
      try {
        switch (params.mode) {
          case "files": {
            if (params.pattern === "*") {
              return fail('files pattern "*" matches everything; use mode "map" or a specific glob');
            }
            const scopeIsFile = (() => {
              try {
                return statSync(scope).isFile();
              } catch {
                return false;
              }
            })();
            if (scopeIsFile) {
              const rel = toRelative(ctx.root, scope);
              if (isSecretPath(rel)) return ok("no matches");
              const match = !params.pattern || globToRegExp(params.pattern).test(rel);
              return ok(match ? rel : "no matches");
            }
            // Never pass a positive glob to rg for a listing: positive globs
            // override .gitignore and would expose ignored or secret files.
            const result = await runProc("rg", ["--files", ...excludeGlobs()], {
              cwd: scope,
              timeoutMs: 30_000,
            });
            if (result.outcome === "spawn-error") return fail(`configuration gap: ${result.spawnError}`);
            if (result.outcome === "timeout") return fail("rg timed out after 30s (process group killed)");
            if (result.code !== 0 && result.stdout.length === 0) {
              if (result.code === 1) return ok("no matches");
              return fail(`rg exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
            }
            const all = result.stdout.split("\n").filter(Boolean);
            const filtered = params.pattern ? all.filter((file) => globToRegExp(params.pattern!).test(file)) : all;
            return ok(capText(filtered.join("\n"), SEARCH_CAP_BYTES).text || "no matches");
          }
          case "text": {
            if (!params.pattern) return fail("text mode requires a pattern");
            if (params.path && params.paths && params.paths.length > 0) {
              return fail("text mode accepts path or paths, not both");
            }
            // rg needs a directory as cwd. When the caller scopes to one file,
            // run from the worktree root and pass the file explicitly.
            const scopeIsFile = (() => {
              try {
                return statSync(scope).isFile();
              } catch {
                return false;
              }
            })();
            if (scopeIsFile && isSecretPath(toRelative(ctx.root, scope))) return ok("no matches");
            const args = [
              "--line-number",
              "--with-filename",
              "--max-count",
              String(limit),
              ...excludeGlobs(),
              "--",
              params.pattern,
            ];
            if (params.paths && params.paths.length > 0) {
              const targets = params.paths.map((path) => resolveWithin(ctx.root, path));
              const visible = targets.filter((target) => !isSecretPath(toRelative(ctx.root, target)));
              if (visible.length === 0) return ok("no matches");
              args.push(...visible);
              return await exec("rg", args, ctx.root, SEARCH_CAP_BYTES);
            }
            if (scopeIsFile) args.push(params.path ?? scope);
            return await exec("rg", args, scopeIsFile ? ctx.root : scope, SEARCH_CAP_BYTES);
          }
          case "map": {
            const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
            return ok(
              renderRepoMap(built.map, {
                path: params.path,
                maxBytes: 32 * 1024,
              }) || "no files",
            );
          }
          case "outline": {
            if (!params.path) return fail("outline mode requires a path");
            const file = await outlineFile(ctx.root, params.path);
            if (!file) return fail(`no outline for ${params.path} (binary or unreadable)`);
            return ok(
              `${file.path} (${file.lines} lines)\n${renderOutline(file) || "(no symbols)"}`,
            );
          }
          case "json":
          case "yaml": {
            const binary = params.mode === "json" ? "jq" : "yq";
            if (!params.pattern) return fail(`${params.mode} mode requires a query pattern`);
            if (!params.path) return fail(`${params.mode} mode scopes to one document: pass its path`);
            const abs = resolveWithin(ctx.root, params.path);
            assertRegularFile(abs);
            return await exec(binary, [params.pattern, abs], ctx.root, SEARCH_CAP_BYTES);
          }
          case "structure": {
            if (!params.pattern) return fail("structure mode requires an ast-grep pattern");
            // Explicit "." path: without one ast-grep reads stdin and hangs.
            return await exec(
              "ast-grep",
              ["run", "--pattern", params.pattern, "--heading", "always", "."],
              scope,
              SEARCH_CAP_BYTES,
            );
          }
          default: {
            if (params.mode === "symbols") {
              const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
              const hits = findSymbols(built.map, params.pattern ?? "", limit);
              return ok(hits.join("\n") || "no symbols");
            }
            if (SEMANTIC_MODES.has(params.mode)) {
              const { lspClientFor, serverAvailable } = await import("../lsp/index.js");
              if (!serverAvailable("typescript")) {
                return fail(
                  `semantic mode "${params.mode}" unavailable: typescript-language-server not installed. ` +
                  "Fallback: outline, text, or structure.",
                );
              }
              const abs = params.path ? resolveWithin(ctx.root, params.path) : ctx.root;
              const client = lspClientFor(ctx.root, "typescript", ctx.processes);
              if (!client) return fail("LSP unavailable. Fallback: outline, text, or structure.");
              if (!params.path || params.line === undefined || params.column === undefined) {
                return fail(`semantic mode "${params.mode}" requires path + line + column`);
              }
              const pos = { line: params.line - 1, character: params.column - 1 };
              if (params.mode === "definition") {
                const locs = await client.definition(abs, pos);
                if (locs === null) return fail("LSP server did not respond");
                if (locs.length === 0) return ok("no definition");
                return ok(locs.map((l) => `${l.uri.replace("file://", "")}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join("\n"));
              }
              if (params.mode === "references") {
                const locs = await client.references(abs, pos);
                if (locs === null) return fail("LSP server did not respond");
                if (locs.length === 0) return ok("no references");
                return ok(locs.map((l) => `${l.uri.replace("file://", "")}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join("\n"));
              }
              if (params.mode === "info") {
                const hover = await client.hover(abs, pos);
                if (hover === null) return fail("LSP server did not respond");
                if (!hover) return ok("no info");
                const content = typeof hover.contents === "string" ? hover.contents : (hover.contents as { value?: string }).value ?? JSON.stringify(hover.contents);
                return ok(content);
              }
              return fail(`unknown semantic mode: ${params.mode}`);
            }
            return fail(`unknown search mode: ${params.mode}`);
          }
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* ----------------------------------------------------------------- command */

const CommandParams = Type.Object({
  action: Type.Union([Type.Literal("describe"), Type.Literal("list"), Type.Literal("run")], {
    description: "list returns every schema in one call; describe returns one; run executes it.",
  }),
  name: Type.Optional(Type.String({ description: "Command name, e.g. core:status (describe/run)." })),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Typed arguments for run." }),
  ),
});

export function commandTool(ctx: ToolContext): AgentTool<typeof CommandParams> {
  return {
    name: "command",
    label: "command",
    description:
      "List all typed command schemas in one call, describe one, or run it (core:* built-ins and allowlisted manifests). No arbitrary shell.",
    parameters: CommandParams,
    async execute(_id, params: Static<typeof CommandParams>) {
      try {
        if (params.action === "list") {
          const items = [...ctx.commands.keys()]
            .sort()
            .map((name) => describeCommand(name, ctx.commands));
          return ok(items.join("\n\n"));
        }
        if (!params.name) return fail(`${params.action} requires a name`);
        if (params.action === "describe") {
          return ok(describeCommand(params.name, ctx.commands));
        }
        const result: CommandRunResult = await runCommand(params.name, params.args ?? {}, ctx, _id);
        return result.isError ? fail(result.text) : ok(result.text);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* -------------------------------------------------------------------- task */

const TaskUnavailableParams = Type.Object({
  task: Type.String({ description: "Bounded child-task description." }),
});

function taskUnavailable(): AgentTool<typeof TaskUnavailableParams> {
  return {
    name: "task",
    label: "task",
    description: "Spawn a bounded child task in a fresh context.",
    parameters: TaskUnavailableParams,
    async execute() {
      return fail("task delegation is not wired up in this run (no run context available)");
    },
  };
}

/* --------------------------------------------------------------------- ask */

const AskUnavailableParams = Type.Object({
  question: Type.String({ description: "The clarification needed." }),
});

function askUnavailable(): AgentTool<typeof AskUnavailableParams> {
  return {
    name: "ask",
    label: "ask",
    description: "Ask the user a clarifying question and wait for the answer.",
    parameters: AskUnavailableParams,
    async execute() {
      return fail("ask is not wired up in this run (no run context available)");
    },
  };
}

/* ------------------------------------------------------------------- issue */

const IssueUnavailableParams = Type.Object({
  action: Type.String({ description: "Issue operation." }),
});

function issueUnavailable(): AgentTool<typeof IssueUnavailableParams> {
  return {
    name: "issue",
    label: "issue",
    description: "Structured GitHub issue access.",
    parameters: IssueUnavailableParams,
    async execute() {
      return fail("issue tracking is not available in this run (disabled, no GitHub remote, or gh unauthenticated)");
    },
  };
}

/* ----------------------------------------------------------------- artifact */

const ArtifactUnavailableParams = Type.Object({
  action: Type.String({ description: "Artifact operation." }),
});

function artifactUnavailable(): AgentTool<typeof ArtifactUnavailableParams> {
  return {
    name: "artifact",
    label: "artifact",
    description: "Reusable tool and script inventory.",
    parameters: ArtifactUnavailableParams,
    async execute() {
      return fail("artifact provisioning is not available in this run (role lacks artifact access)");
    },
  };
}

/* ---------------------------------------------------------------------- pr */

const PrUnavailableParams = Type.Object({
  action: Type.String({ description: "PR operation." }),
});

function prUnavailable(): AgentTool<typeof PrUnavailableParams> {
  return {
    name: "pr",
    label: "pr",
    description: "Pull-request access.",
    parameters: PrUnavailableParams,
    async execute() {
      return fail("pull requests are not available in this run (no GitHub remote, or gh unauthenticated)");
    },
  };
}

/* ------------------------------------------------------------------ all */

export type CoreToolName =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "command"
  | "context"
  | "task"
  | "ask"
  | "issue"
  | "artifact"
  | "pr";

export function coreTools(ctx: ToolContext, allowed: readonly CoreToolName[]): AgentTool[] {
  const all: Record<CoreToolName, AgentTool> = {
    read: readTool(ctx),
    write: writeTool(ctx),
    edit: editTool(ctx),
    search: searchTool(ctx),
    command: commandTool(ctx),
    context: contextTool(ctx),
    task: ctx.task ? taskTool(ctx.task) : taskUnavailable(),
    ask: ctx.ask ? askTool(ctx.ask) : askUnavailable(),
    issue: ctx.issues ? issueTool(ctx.issues) : issueUnavailable(),
    artifact: ctx.artifacts ? artifactTool(ctx.artifacts) : artifactUnavailable(),
    pr: ctx.prs ? prTool(ctx.prs) : prUnavailable(),
  };
  return allowed.map((name) => all[name]);
}
