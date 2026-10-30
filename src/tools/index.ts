/**
 * machine_code — the six core tools.
 *
 * Exactly six: read, write, edit, search, command, task. Everything else is a
 * named typed command dispatched through `command`. Tools never get a shell.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  READ_CAP_BYTES,
  SEARCH_CAP_BYTES,
  ToolError,
  assertRegularFile,
  capText,
  excludeGlobs,
  isBinaryFile,
  resolveWithin,
} from "./safety.js";
import { describeCommand, runCommand, type CommandRunResult } from "../commands/registry.js";

export interface ToolContext {
  /** Worktree root every path is bound to. */
  root: string;
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
});

export function readTool(ctx: ToolContext): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "read",
    description:
      "Read a file inside the worktree. Line-paged, capped at 24 KiB per call; binary files are rejected.",
    parameters: ReadParams,
    async execute(_id, params: Static<typeof ReadParams>) {
      try {
        const abs = resolveWithin(ctx.root, params.path);
        assertRegularFile(abs);
        if (isBinaryFile(abs)) return fail(`refusing to read a binary file: ${params.path}`);
        const raw = readFileSync(abs, "utf8");
        const lines = raw.split("\n");
        const offset = Math.max(1, Math.floor(params.offset ?? 1));
        const limit = Math.max(1, Math.floor(params.limit ?? 2000));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join("\n");
        const capped = capText(numbered, READ_CAP_BYTES);
        const more =
          offset - 1 + slice.length < lines.length
            ? `\n[${lines.length - (offset - 1 + slice.length)} more lines; call read with offset ${offset + slice.length}]`
            : "";
        return ok(capped.text + more);
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
  "map", "files", "text", "structure", "json", "yaml",
  "definition", "references", "symbols", "info",
];

const SearchParams = Type.Object({
  mode: Type.Union(
    [
      Type.Literal("map"),
      Type.Literal("files"),
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
  pattern: Type.Optional(Type.String({ description: "Pattern: regex for text, glob for files, query for json/yaml/structure." })),
  path: Type.Optional(Type.String({ description: "Directory or file to scope the search (default: worktree root)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 200)." })),
});

function exec(
  binary: string,
  args: string[],
  cwd: string,
  capBytes: number,
): Promise<AgentToolResult<undefined>> {
  return new Promise((resolvePromise) => {
    execFile(
      binary,
      args,
      { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "" } },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          // rg exits 1 for "no matches" — not a tool error.
          if ((error as { code?: number }).code === 1) {
            resolvePromise(ok("no matches"));
            return;
          }
          resolvePromise(fail(`${binary} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise(ok(capText(stdout.trimEnd(), capBytes).text || "no matches"));
      },
    );
  });
}

const SEMANTIC_MODES = new Set(["definition", "references", "symbols", "info"]);

export function searchTool(ctx: ToolContext): AgentTool<typeof SearchParams> {
  return {
    name: "search",
    label: "search",
    description:
      "Read-only bounded search. Modes: map (filtered repo map), files (file listing), text (regex), " +
      "structure (ast-grep pattern), json/yaml (jq/yq query), and semantic definition/references/symbols/info (LSP, from M1). " +
      "Never touches excluded directories (node_modules, dist, build, target, .git, .machine_code/local, ...) or binary files.",
    parameters: SearchParams,
    async execute(_id, params: Static<typeof SearchParams>) {
      const scope = params.path ? resolveWithin(ctx.root, params.path) : ctx.root;
      const limit = Math.max(1, Math.floor(params.limit ?? 200));
      try {
        switch (params.mode) {
          case "files": {
            const args = ["--files", ...excludeGlobs()];
            if (params.pattern) args.push("--glob", params.pattern);
            return await exec("rg", args, scope, SEARCH_CAP_BYTES);
          }
          case "text": {
            if (!params.pattern) return fail("text mode requires a pattern");
            return await exec(
              "rg",
              ["--line-number", "--max-count", String(limit), ...excludeGlobs(), "--", params.pattern],
              scope,
              SEARCH_CAP_BYTES,
            );
          }
          case "map": {
            const result = await exec(
              "rg",
              ["--files", ...excludeGlobs()],
              scope,
              SEARCH_CAP_BYTES,
            );
            return result;
          }
          case "json":
          case "yaml": {
            const binary = params.mode === "json" ? "jq" : "yq";
            if (!params.pattern) return fail(`${params.mode} mode requires a query pattern`);
            return fail(
              `configuration gap: ${binary} is not installed (install it or disable the query) — named query ${params.pattern} not run`,
            );
          }
          case "structure": {
            return fail(
              "configuration gap: ast-grep (sg) is not installed — structural search unavailable",
            );
          }
          default: {
            if (SEMANTIC_MODES.has(params.mode)) {
              return fail(`semantic search mode "${params.mode}" arrives in M1 (LSP); use text or files`);
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
  action: Type.Union([Type.Literal("describe"), Type.Literal("run")], {
    description: "describe returns the command's typed schema; run executes it.",
  }),
  name: Type.String({ description: "Command name, e.g. core:status." }),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Typed arguments for run." }),
  ),
});

export function commandTool(ctx: ToolContext): AgentTool<typeof CommandParams> {
  return {
    name: "command",
    label: "command",
    description:
      "Describe or run a named, typed command (core:* built-ins and allowlisted manifests). No arbitrary shell.",
    parameters: CommandParams,
    async execute(_id, params: Static<typeof CommandParams>) {
      try {
        if (params.action === "describe") {
          return ok(describeCommand(params.name));
        }
        const result: CommandRunResult = await runCommand(params.name, params.args ?? {}, ctx);
        return result.isError ? fail(result.text) : ok(result.text);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* -------------------------------------------------------------------- task */

const TaskParams = Type.Object({
  task: Type.String({ description: "Bounded child-task description." }),
});

export function taskTool(_ctx: ToolContext): AgentTool<typeof TaskParams> {
  return {
    name: "task",
    label: "task",
    description: "Spawn a bounded child task in a fresh context.",
    parameters: TaskParams,
    async execute() {
      return fail("task is not enabled in M0; it spawns child agent runs from M1");
    },
  };
}

/* ------------------------------------------------------------------ all */

export type CoreToolName = "read" | "write" | "edit" | "search" | "command" | "task";

export function coreTools(ctx: ToolContext, allowed: readonly CoreToolName[]): AgentTool[] {
  const all: Record<CoreToolName, AgentTool> = {
    read: readTool(ctx),
    write: writeTool(ctx),
    edit: editTool(ctx),
    search: searchTool(ctx),
    command: commandTool(ctx),
    task: taskTool(ctx),
  };
  return allowed.map((name) => all[name]);
}
