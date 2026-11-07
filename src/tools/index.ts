/**
 * machine_code — the core tools.
 *
 * Read, write, edit, search, command, context, ask, issue, artifact, and pr.
 * Everything else is a named typed command dispatched through `command`.
 * Tools never get a shell.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runProc } from "../proc.js";
import {
  READ_CAP_BYTES,
  SEARCH_CAP_BYTES,
  ToolError,
  assertRegularFile,
  capText,
  excludeGlobs,
  expandGlobBraces,
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
import { documentSections, sectionTitle } from "../map/sections.js";
import { askTool, type AskContext } from "./ask.js";
import { issueGraphTool, issueTool, type IssueToolContext } from "./issues.js";
import { artifactTool, type ArtifactToolContext } from "./artifact.js";
import { skillTool, type SkillToolContext } from "./skill.js";
import { prTool, type PrToolContext } from "./pr.js";
import { contextTool } from "./context.js";
import { loadSemanticOrDeterministic, renderModuleGraph, searchSemantic, type SemanticMap } from "../map/semantic.js";
import { languageForPath, serverForLanguage } from "../lsp/servers.js";
import type { LedgerEntry, RunStateStore } from "../context/state.js";

export interface ToolContext {
  /** Worktree root every path is bound to. */
  root: string;
  /** Loaded commands (core + profiles). */
  commands: ReadonlyMap<string, import("../commands/registry.js").CommandSpec>;
  /** Tools available to this run, for role-aware errors. */
  tools?: readonly string[];
  /** When provided, the `ask` tool is live (suspends the run for input). */
  ask?: AskContext;
  /** When provided, the `issue` tool is live (capability-gated issue access). */
  issues?: IssueToolContext;
  /** When provided, the `artifact` tool is live (tools/scripts inventory). */
  artifacts?: ArtifactToolContext;
  /** When provided, the `skill` tool is live (on-demand skill bodies). */
  skills?: SkillToolContext;
  /** When provided, the `pr` tool is live (capability-gated PR access). */
  prs?: PrToolContext;
  /** Run state for the `context` tool. */
  state?: RunStateStore;
  /** Current semantic map, if one is available. */
  semantic?: () => SemanticMap | null;
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
  offset: Type.Optional(Type.Number({ description: "1-based line to start at (default 1). Use only for a large unindexed file." })),
  limit: Type.Optional(Type.Number({ description: "Max lines to return (default 2000)." })),
  symbol: Type.Optional(Type.String({ description: "Top-level symbol to read (resolved from the repo map). Prefer this." })),
  symbols: Type.Optional(Type.Array(Type.String(), { description: "Several symbols from one file in one call. Prefer this for a sweep." })),
  around: Type.Optional(Type.Number({ description: "1-based line; read the symbol that contains it." })),
  section: Type.Optional(Type.String({ description: "Comment or Markdown section heading to read. Prefer this over offset paging." })),
  sections: Type.Optional(Type.Array(Type.String(), { description: "Several sections from one file in one call." })),
});

/** Find a nested or non-map declaration so `read { symbol }` can still help. */
function findSymbolLine(lines: readonly string[], symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `(?:^|\\s)(?:function|class|const|let|var|interface|type|enum|def|fn|func)\\s+${escaped}\\b`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    if (declaration.test(lines[index] ?? "")) return index + 1;
  }
  const word = new RegExp(`\\b${escaped}\\b`);
  for (let index = 0; index < lines.length; index += 1) {
    if (word.test(lines[index] ?? "")) return index + 1;
  }
  return 0;
}

/** Stable cache key for one read target: symbol, section, window, or full file. */
function readCacheKey(path: string, params: { symbol?: string | null; symbols?: readonly string[] | null; section?: string | null; sections?: readonly string[] | null; around?: number | null; offset?: number | null; limit?: number | null }): string {
  if (params.symbols && params.symbols.length > 0) return `${path}#symbols:${[...params.symbols].sort().join(",")}`;
  if (params.sections && params.sections.length > 0) return `${path}#sections:${[...params.sections].map((item) => item.trim().toLowerCase()).sort().join(",")}`;
  if (params.symbol) return `${path}#symbol:${params.symbol}`;
  if (params.section) return `${path}#section:${params.section.trim().toLowerCase()}`;
  if (params.around != null) return `${path}#around:${params.around}`;
  if (params.offset != null || params.limit != null) {
    return `${path}@${Math.max(1, Math.floor(params.offset ?? 1))}:${Math.max(1, Math.floor(params.limit ?? 2000))}`;
  }
  return `${path}#full`;
}

function readTargetLabel(path: string, params: { symbol?: string | null; symbols?: readonly string[] | null; section?: string | null; sections?: readonly string[] | null; around?: number | null; offset?: number | null; limit?: number | null }): string {
  if (params.symbols && params.symbols.length > 0) return `${path}#${params.symbols.join(",")}`;
  if (params.sections && params.sections.length > 0) return `${path}#${params.sections.join(",")}`;
  if (params.symbol) return `${path}#${params.symbol}`;
  if (params.section) return `${path}#${params.section.trim()}`;
  if (params.around != null) return `${path}#around ${params.around}`;
  if (params.offset != null || params.limit != null) {
    const start = Math.max(1, Math.floor(params.offset ?? 1));
    return `${path}:${start}-${start + Math.max(1, Math.floor(params.limit ?? 2000)) - 1}`;
  }
  return path;
}

/** Weak models serialize absent optionals as the string "null". No definable
 * symbol or section is literally named "null", so treat it as absent before
 * the mutual-exclusion checks below. Anything else passes through untouched
 * for schema validation to judge. */
const NULL_SELECTOR = new Set(["null", "undefined"]);

/** Above this size, `read { around }` returns a page around the line instead
 * of the whole enclosing symbol. */
const AROUND_MAX_SYMBOL_LINES = 160;

function cleanReadSelectors(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  let changed = false;
  for (const key of ["symbol", "section"] as const) {
    const value = out[key];
    if (typeof value === "string" && NULL_SELECTOR.has(value.trim())) {
      delete out[key];
      changed = true;
    }
  }
  // Weak models send a scalar where the schema wants a list. Coerce it
  // instead of spending a turn on a validation error.
  for (const key of ["symbols", "sections"] as const) {
    const value = out[key];
    if (value === null || value === undefined) {
      delete out[key];
      changed = true;
    } else if (typeof value === "string") {
      if (NULL_SELECTOR.has(value.trim())) delete out[key];
      else out[key] = [value];
      changed = true;
    } else if (Array.isArray(value)) {
      const kept = value.filter(
        (item) => !(typeof item === "string" && NULL_SELECTOR.has(item.trim())),
      );
      if (kept.length !== value.length) {
        if (kept.length > 0) out[key] = kept;
        else delete out[key];
        changed = true;
      }
    }
  }
  // A single selector and its list form are the same request. Merge so the
  // read does not append the same symbol twice.
  for (const [single, list] of [["symbol", "symbols"], ["section", "sections"]] as const) {
    const value = out[single];
    if (typeof value !== "string") continue;
    const existing = Array.isArray(out[list]) ? (out[list] as unknown[]) : [];
    out[list] = [...existing, value];
    delete out[single];
    changed = true;
  }
  // Numeric selectors sometimes arrive as null or the string "null".
  for (const key of ["offset", "limit", "around"] as const) {
    const value = out[key];
    if (
      value === null ||
      value === undefined ||
      (typeof value === "string" && (value.trim() === "" || NULL_SELECTOR.has(value.trim())))
    ) {
      delete out[key];
      changed = true;
    }
  }
  return changed ? out : args;
}

export function readTool(ctx: ToolContext): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "read",
    description:
      "Read a file inside the worktree. Prefer symbol or section for a targeted sweep; use offset/limit only " +
      "for a large unindexed file. Capped at 24 KiB per call; a bare full read of a larger file returns its outline. " +
      "Binary files are rejected. A past-end offset is an error; do not page further. " +
      "Examples: {\"path\":\"src/tui.ts\",\"symbol\":\"runTui\"}; {\"path\":\"README.md\",\"section\":\"Configuration\"}; " +
      "{\"path\":\"src/tui.ts\",\"offset\":2400,\"limit\":120}.",
    parameters: ReadParams,
    prepareArguments: (args) => cleanReadSelectors(args) as Static<typeof ReadParams>,
    async execute(_id, params: Static<typeof ReadParams>) {
      try {
        const abs = resolveWithin(ctx.root, params.path);
        assertRegularFile(abs);
        if (isBinaryFile(abs)) return fail(`refusing to read a binary file: ${params.path}`);
        const wantsSymbols = Boolean(params.symbols && params.symbols.length > 0);
        const wantsSections = Boolean(params.sections && params.sections.length > 0);
        // Selectors compose instead of excluding each other: every requested
        // symbol, section, and range is appended to one bounded result. Weak
        // models hedge by filling several fields at once.
        const parts: string[] = [];
        const stat = statSync(abs);
        const fileSig = `${stat.mtimeMs}:${stat.size}`;
        const cacheKey = readCacheKey(params.path, params);
        const cached = ctx.state?.cachedRead(cacheKey, fileSig);
        if (cached !== null && cached !== undefined) return ok(cached);
        const raw = readFileSync(abs, "utf8");
        const lines = raw.split("\n");
        const bytes = Buffer.byteLength(raw, "utf8");
        // Symbol/around wins when a model also passes offset/limit. Ignore the
        // paging arguments instead of spending a turn on a schema correction.

        let offset = Math.max(1, Math.floor(params.offset ?? 1));
        let limit = Math.max(1, Math.floor(params.limit ?? 2000));
        let header = "";
        let symbolFallback = false;
        const remember = (text: string, kind: LedgerEntry["kind"], label?: string) => {
          ctx.state?.rememberRead({
            key: cacheKey,
            path: params.path,
            label: label ?? readTargetLabel(params.path, params),
            kind,
            content: text,
            fileSig,
          });
          return ok(text);
        };

        if (wantsSymbols) {
          const file = await outlineFile(ctx.root, params.path);
          const missing: string[] = [];
          for (const name of params.symbols!) {
            const range = file ? symbolRange(file, name) : null;
            if (range) {
              const page = numberLinesCapped(
                lines,
                range.start,
                Math.max(1, range.end - range.start + 1),
                READ_CAP_BYTES,
              );
              parts.push(`### ${params.path}:${range.start}-${range.end} (${name})\n${page.text}`);
              continue;
            }
            const found = findSymbolLine(lines, name);
            if (found > 0) {
              const start = Math.max(1, found - 20);
              const page = numberLinesCapped(lines, start, 41, READ_CAP_BYTES);
              parts.push(`### ${params.path}:${start}-${start + 40} (around ${name})\n${page.text}`);
            } else {
              missing.push(name);
            }
          }
          if (missing.length > 0) parts.push(`[no symbol: ${missing.join(", ")}]`);
        }

        if (wantsSections) {
          const headings = documentSections(raw, params.path);
          const missing: string[] = [];
          for (const wanted of params.sections!) {
            const needle = wanted.trim().toLowerCase();
            const index = headings.findIndex((heading) => {
              const title = sectionTitle(heading.text).toLowerCase();
              return title === needle || title.includes(needle) || heading.text.toLowerCase().includes(needle);
            });
            if (index < 0) {
              missing.push(wanted);
              continue;
            }
            const heading = headings[index]!;
            const next = headings[index + 1];
            const start = heading.line;
            const end = next ? next.line - 1 : lines.length;
            const page = numberLinesCapped(lines, start, Math.max(1, end - start + 1), READ_CAP_BYTES);
            parts.push(`### ${params.path}:${start}-${end} (section ${sectionTitle(heading.text) || heading.text})\n${page.text}`);
          }
          if (missing.length > 0) parts.push(`[no section: ${missing.join(", ")}]`);
        }

        // A single section resolves to a page range appended below. A miss
        // fails fast when nothing else succeeded, and degrades to a note
        // when array parts already answer the call.
        let singleResolved = false;
        if (params.section && !wantsSymbols && !wantsSections) {
          const headings = documentSections(raw, params.path);
          const needle = params.section.trim().toLowerCase();
          const index = headings.findIndex((heading) => {
            const title = sectionTitle(heading.text).toLowerCase();
            return title === needle || title.includes(needle) || heading.text.toLowerCase().includes(needle);
          });
          if (index < 0) {
            const known = headings.slice(0, 12).map((heading) => sectionTitle(heading.text) || heading.text);
            const note =
              `no section "${params.section}" in ${params.path}. ` +
              (known.length > 0 ? `Known sections:\n${known.join("\n")}` : "This file has no section headings; use symbol or a range.");
            if (parts.length > 0) {
              parts.push(`[${note}]`);
            } else {
              return fail(note);
            }
          } else {
            const heading = headings[index]!;
            const next = headings[index + 1];
            offset = heading.line;
            limit = Math.max(1, (next ? next.line - 1 : lines.length) - heading.line + 1);
            header = `${params.path}:${offset}-${offset + limit - 1} (section ${sectionTitle(heading.text) || heading.text})`;
            singleResolved = true;
          }
        } else if (params.section) {
          // Combined with arrays, a single section is just another part.
          const headings = documentSections(raw, params.path);
          const needle = params.section.trim().toLowerCase();
          const index = headings.findIndex((heading) => {
            const title = sectionTitle(heading.text).toLowerCase();
            return title === needle || title.includes(needle) || heading.text.toLowerCase().includes(needle);
          });
          if (index < 0) {
            parts.push(`[no section "${params.section}" in ${params.path}]`);
          } else {
            const heading = headings[index]!;
            const next = headings[index + 1];
            const start = heading.line;
            const end = next ? next.line - 1 : lines.length;
            const page = numberLinesCapped(lines, start, Math.max(1, end - start + 1), READ_CAP_BYTES);
            parts.push(`### ${params.path}:${start}-${end} (section ${sectionTitle(heading.text) || heading.text})\n${page.text}`);
          }
        }
        if (params.symbol || params.around != null) {
          const file = await outlineFile(ctx.root, params.path);
          const range = file
            ? params.symbol
              ? symbolRange(file, params.symbol)
              : rangeAround(file, params.around!)
            : null;
          if (!range) {
            if (params.symbol) {
              // Nested functions and local bindings are not top-level map
              // symbols. Show the declaration's neighborhood instead of a
              // dead end.
              const found = findSymbolLine(lines, params.symbol);
              if (found > 0) {
                offset = Math.max(1, found - 20);
                limit = 41;
                header = `${params.path}:${offset}-${offset + 40} (around ${params.symbol})`;
                symbolFallback = true;
                singleResolved = true;
              } else {
                const suggestion = file && file.symbols.length > 0
                  ? file.symbols.slice(0, 12).map((symbol) => `${symbol.line} ${symbol.kind} ${symbol.name}`).join("\n")
                  : "(no symbols)";
                const note =
                  `no symbol "${params.symbol}" in ${params.path}. ` +
                  `Try search text for the name, or read { around }. Known top-level symbols:\n${suggestion}`;
                if (parts.length > 0) {
                  parts.push(`[${note}]`);
                } else {
                  return fail(note);
                }
              }
            } else {
              // No symbols in the file: fall back to a small line window.
              offset = Math.max(1, params.around! - 20);
              limit = 41;
              header = `${params.path}:${offset}-${offset + 40} (around ${params.around})`;
              singleResolved = true;
            }
          } else if (
            params.around != null &&
            range.end - range.start + 1 > AROUND_MAX_SYMBOL_LINES
          ) {
            // `around` means "the page at this line", not "everything the
            // enclosing symbol spans." A 4,600-line function would otherwise
            // flood the transcript and push the actual evidence out.
            const start = Math.max(range.start, params.around - 20);
            const end = Math.min(range.end, start + 40);
            offset = start;
            limit = Math.max(1, end - start + 1);
            header =
              `${params.path}:${offset}-${offset + limit - 1} (around ${params.around}; ` +
              `${range.name} is ${range.end - range.start + 1} lines)`;
            singleResolved = true;
          } else {
            offset = range.start;
            limit = Math.max(1, range.end - range.start + 1);
            header = `${params.path}:${range.start}-${range.end} (${range.name})`;
            singleResolved = true;
          }
        } else if (parts.length === 0 && bytes > READ_CAP_BYTES && params.offset == null && params.limit == null) {
          const file = await outlineFile(ctx.root, params.path);
          const outline = file ? renderOutline(file) : "(no symbols)";
          return remember(
            `[${params.path} is ${lines.length} lines / ${bytes} bytes; full read exceeds ${READ_CAP_BYTES} bytes]\n` +
            `${outline}\nRead a symbol or a range.`,
            "outline",
            `${params.path}#outline`,
          );
        }

        const pageParts: string[] = [];
        let pageNextOffset: number | undefined;
        const wantPage = singleResolved || params.offset != null || params.limit != null || parts.length === 0;
        if (wantPage) {
          if (offset > lines.length) {
            // A past-end page is an error, not an empty successful read. The
            // state ingester would otherwise record a read range that does not
            // exist and the model would page forever.
            const last = Math.max(1, lines.length);
            const pastEnd =
              `offset ${offset} is past the end of ${params.path} (${lines.length} lines). ` +
              `The file ends at line ${last}. Do not page further; use symbol, around, or context recall.`;
            if (parts.length > 0) {
              parts.push(`[${pastEnd}]`);
            } else {
              return fail(pastEnd);
            }
          } else {
            const page = numberLinesCapped(lines, offset, limit, READ_CAP_BYTES);
            const notes: string[] = [];
            if (symbolFallback) {
              notes.push(`[${params.symbol} is not a top-level map symbol; showing the first match]`);
            }
            if (page.truncatedLine) {
              notes.push(`[line ${page.nextOffset - 1} truncated at ${READ_CAP_BYTES} bytes]`);
            }
            if (page.nextOffset <= lines.length) {
              notes.push(
                `[${lines.length - (page.nextOffset - 1)} more lines; call read with offset ${page.nextOffset}]`,
              );
            }
            if (page.nextOffset <= lines.length) pageNextOffset = page.nextOffset;
            pageParts.push([header, page.text, ...notes].filter(Boolean).join("\n"));
          }
        }
        // Parts are individually capped; cap the total only when arrays
        // contributed, so a lone page keeps its trailing navigation note.
        // If the cap eats that note, re-attach the offset explicitly.
        const body = [...parts, ...pageParts].filter(Boolean).join("\n\n");
        let text = body;
        if (parts.length > 0) {
          const capped = capText(body, READ_CAP_BYTES);
          text = capped.text;
          if (
            capped.truncated &&
            pageNextOffset !== undefined &&
            !/call read with offset/.test(text)
          ) {
            text += `\n[${lines.length - (pageNextOffset - 1)} more lines; call read with offset ${pageNextOffset}]`;
          }
        }
        return remember(
          text,
          wantsSymbols ? "symbol" : wantsSections || params.section ? "section" : params.symbol ? "symbol" : "file",
          header || readTargetLabel(params.path, params),
        );
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

/** A path literally named "null" is a serialization artifact, never a real
 * target — and unlike read/edit, write would create the junk file. Drop it
 * so schema validation names the missing path instead. */
function cleanWritePath(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  if (typeof out.path === "string" && (out.path.trim() === "null" || out.path.trim() === "undefined")) {
    delete out.path;
    return out;
  }
  return args;
}

export function writeTool(ctx: ToolContext): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "write",
    description: "Write a file inside the worktree, creating parent directories.",
    parameters: WriteParams,
    prepareArguments: (args) => cleanWritePath(args) as Static<typeof WriteParams>,
    async execute(_id, params: Static<typeof WriteParams>) {
      try {
        // A role that can write but not edit (research) persists only under
        // the project's knowledge/, plans/, and .machine_code/ runner dirs.
        if (ctx.tools && !ctx.tools.includes("edit")) {
          const p = params.path.replace(/\\/g, "/").replace(/^\.\//, "");
          const allowed =
            p === "knowledge" ||
            p.startsWith("knowledge/") ||
            p === "plans" ||
            p.startsWith("plans/") ||
            p === ".machine_code" ||
            p.startsWith(".machine_code/");
          if (!allowed) {
            return fail(`write is limited to knowledge/ or plans/ for this role: ${params.path}`);
          }
        }
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

/**
 * Weak models fill every field: a multi-hunk call arrives with top-level
 * `oldString: ""` / `newString: ""` alongside a real `edits` array, which
 * the tool rejects as mixed forms. Empty strings are never a real anchor
 * (exact match needs text) and never a real path, so drop them before
 * schema validation. A real oldString with an empty newString is a
 * legitimate deletion and is kept.
 */
function cleanEditArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  let changed = false;
  const isNullish = (value: unknown): boolean =>
    typeof value === "string" && (value.trim() === "" || value.trim() === "null" || value.trim() === "undefined");
  if (isNullish(out.path)) {
    delete out.path;
    changed = true;
  }
  if (isNullish(out.symbol)) {
    delete out.symbol;
    changed = true;
  }
  if (isNullish(out.section)) {
    delete out.section;
    changed = true;
  }
  if (isNullish(out.oldString)) {
    delete out.oldString;
    changed = true;
  }
  // An empty replacement is only meaningful against a real anchor.
  if (typeof out.newString === "string" && out.newString.trim() === "" && out.oldString === undefined) {
    delete out.newString;
    changed = true;
  } else if (typeof out.newString === "string" && (out.newString.trim() === "null" || out.newString.trim() === "undefined")) {
    delete out.newString;
    changed = true;
  }
  if (Array.isArray(out.edits)) {
    const kept = out.edits.filter(
      (hunk): hunk is { oldString: string; newString: string } =>
        !!hunk &&
        typeof hunk === "object" &&
        typeof (hunk as Record<string, unknown>).oldString === "string" &&
        ((hunk as Record<string, unknown>).oldString as string).trim() !== "",
    );
    if (kept.length !== out.edits.length) {
      if (kept.length > 0) out.edits = kept;
      else delete out.edits;
      changed = true;
    }
  }
  return changed ? out : args;
}

const EditParams = Type.Object({  path: Type.String({ description: "File path, relative to the worktree root." }),
  oldString: Type.Optional(Type.String({ description: "Exact text to find (single-hunk form)." })),
  newString: Type.Optional(Type.String({ description: "Replacement text (single-hunk form)." })),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        oldString: Type.String({ description: "Exact text to find." }),
        newString: Type.String({ description: "Replacement text." }),
        replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence in the scope." })),
      }),
      { description: "Several exact-match hunks applied atomically to one file." },
    ),
  ),
  symbol: Type.Optional(Type.String({ description: "Limit the edit to one top-level symbol." })),
  section: Type.Optional(Type.String({ description: "Limit the edit to one comment or Markdown section." })),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence in the scope (single-hunk form)." }),
  ),
});

/** Whitespace-collapsed view plus a map back to original offsets. Models copy
 * read output with different indentation, so an exact miss can still be a
 * correct edit. Mirrors the fallback the other CLI harnesses use. */
function collapseWhitespace(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let space = false;
  let spaceAt = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      if (out.length > 0) {
        space = true;
        spaceAt = index;
      }
      continue;
    }
    if (space) {
      out += " ";
      map.push(spaceAt);
      space = false;
    }
    out += char;
    map.push(index);
  }
  return { text: out, map };
}

/** Remove `1: `-style line-number prefixes a model copied from read output. */
function stripLineNumbers(text: string): string {
  if (!/(?:^|\n)\s*\d+:\s?/.test(text)) return text;
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+:\s?/, ""))
    .join("\n");
}

function exactCount(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(needle, at + 1);
  }
  return count;
}

function findCollapsed(
  text: string,
  needle: string,
): { start: number; end: number; count: number } | null {
  const hay = collapseWhitespace(text);
  const pin = collapseWhitespace(needle);
  if (!pin.text) return null;
  let count = 0;
  let first = -1;
  let at = hay.text.indexOf(pin.text);
  while (at >= 0) {
    count += 1;
    if (first < 0) first = at;
    at = hay.text.indexOf(pin.text, at + 1);
  }
  if (first < 0) return null;
  const start = hay.map[first]!;
  const end = hay.map[first + pin.text.length - 1]! + 1;
  return { start, end, count };
}

/** A numbered window around the closest line, so a miss re-anchors in place. */
function nearestRegionText(
  lines: readonly string[],
  needle: string,
  scopeStart: number,
  scopeEnd: number,
): string {
  const first = needle
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const start = Math.max(1, scopeStart);
  const end = Math.min(lines.length, scopeEnd);
  let hit = -1;
  if (first) {
    for (let index = start - 1; index < end; index += 1) {
      if (lines[index]!.includes(first)) {
        hit = index;
        break;
      }
    }
  }
  const center = hit >= 0 ? hit : start - 1;
  const from = Math.max(start, center - 15);
  const to = Math.min(end, from + 40);
  return numberLinesCapped(lines, from, to - from + 1, 4_000).text;
}

export function editTool(ctx: ToolContext): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Exact-match replacement in a file. Prefer one call with an edits array for several hunks. " +
      "A lone oldString/newString pair is applied first, then the array, in one atomic pass. " +
      "symbol or section scopes the match so an identical anchor elsewhere cannot win. " +
      "Without replaceAll each hunk must be unique inside its scope.",
    parameters: EditParams,
    prepareArguments: (args) => cleanEditArgs(args) as Static<typeof EditParams>,
    async execute(_id, params: Static<typeof EditParams>) {
      try {
        // A single-hunk call and an edits array are the same operation, not
        // alternatives: apply the single hunk first, then the array, in one
        // atomic pass. Weak models hedge by filling both forms.
        const singleOld =
          typeof params.oldString === "string" && params.oldString.trim() !== "" ? params.oldString : undefined;
        const single =
          singleOld !== undefined && params.newString !== undefined
            ? [{ oldString: singleOld, newString: params.newString, replaceAll: params.replaceAll }]
            : [];
        const edits = [
          ...single,
          ...(params.edits && params.edits.length > 0
            ? params.edits.filter((hunk) => typeof hunk.oldString === "string" && hunk.oldString.trim() !== "")
            : []),
        ];
        if (edits.length === 0) return fail("edit requires oldString/newString or a non-empty edits array");

        const abs = resolveWithin(ctx.root, params.path);
        assertRegularFile(abs);
        const raw = readFileSync(abs, "utf8");
        const lines = raw.split("\n");
        const lineOffsets = [0];
        for (let index = 0; index < lines.length; index += 1) {
          lineOffsets.push(lineOffsets[index]! + lines[index]!.length + 1);
        }

        let startChar = 0;
        let endChar = raw.length;
        let scopeLabel = "";
        let scopeStart = 1;
        let scopeEnd = lines.length;
        if (params.symbol) {
          const file = await outlineFile(ctx.root, params.path);
          const range = file ? symbolRange(file, params.symbol) : null;
          if (!range) return fail(`no symbol "${params.symbol}" in ${params.path}`);
          startChar = lineOffsets[range.start - 1] ?? 0;
          endChar = Math.min(raw.length, lineOffsets[range.end] ?? raw.length);
          scopeLabel = `symbol ${params.symbol}`;
          scopeStart = range.start;
          scopeEnd = Math.max(range.start, range.end);
        } else if (params.section) {
          const headings = documentSections(raw, params.path);
          const needle = params.section.trim().toLowerCase();
          const index = headings.findIndex((heading) => {
            const title = sectionTitle(heading.text).toLowerCase();
            return title === needle || title.includes(needle) || heading.text.toLowerCase().includes(needle);
          });
          if (index < 0) return fail(`no section "${params.section}" in ${params.path}`);
          const heading = headings[index]!;
          const next = headings[index + 1];
          const startLine = heading.line;
          const endLine = next ? next.line - 1 : lines.length;
          startChar = lineOffsets[startLine - 1] ?? 0;
          endChar = Math.min(raw.length, lineOffsets[endLine] ?? raw.length);
          scopeLabel = `section ${sectionTitle(heading.text) || heading.text}`;
          scopeStart = startLine;
          scopeEnd = Math.max(startLine, endLine);
        }

        const scoped = raw.slice(startChar, endChar);
        let working = scoped;
        let replacements = 0;
        for (const edit of edits) {
          if (edit.oldString.length === 0) return fail("oldString must not be empty");
          if (edit.oldString === edit.newString) return fail("oldString and newString must differ");
          // Try the exact hunk, then the same hunk without copied line numbers.
          const stripped = stripLineNumbers(edit.oldString);
          const needles = stripped === edit.oldString ? [edit.oldString] : [edit.oldString, stripped];
          let applied = false;
          for (const needle of needles) {
            const count = exactCount(working, needle);
            if (count === 0) continue;
            if (!edit.replaceAll && count > 1) {
              return fail(
                `${count} matches in ${params.path}${scopeLabel ? ` (${scopeLabel})` : ""}; ` +
                  "add context to make the match unique or set replaceAll",
              );
            }
            working = edit.replaceAll
              ? working.split(needle).join(edit.newString)
              : working.replace(needle, edit.newString);
            replacements += count;
            applied = true;
            break;
          }
          if (applied) continue;
          // Whitespace-insensitive fallback: the hunk is the same code with
          // different indentation or blank-line spacing.
          const fuzzy = findCollapsed(working, stripped);
          if (fuzzy) {
            // Ignoring whitespace can merge distinct hunks. Only apply when
            // exactly one region matches; otherwise make the model narrow it.
            if (fuzzy.count > 1) {
              return fail(
                `${fuzzy.count} matches in ${params.path}${scopeLabel ? ` (${scopeLabel})` : ""} ` +
                  "after ignoring whitespace; add context to make the match unique",
              );
            }
            working = working.slice(0, fuzzy.start) + edit.newString + working.slice(fuzzy.end);
            replacements += 1;
            continue;
          }
          // Re-anchor every miss, scoped or not, with the closest current
          // text. The model usually has the right idea against stale bytes;
          // returning the fresh region costs one cheap call instead of a
          // blind re-read and a second failed edit.
          const miss = `no match in ${params.path}${scopeLabel ? ` (${scopeLabel})` : ""}`;
          const page = nearestRegionText(lines, stripped, scopeStart, scopeEnd);
          return fail(`${miss}\nClosest current text:\n${page}`);
        }

        const next = raw.slice(0, startChar) + working + raw.slice(endChar);
        writeFileSync(abs, next, "utf8");
        return ok(
          `edited ${params.path} (${replacements} replacement${replacements === 1 ? "" : "s"})` +
            (scopeLabel ? ` in ${scopeLabel}` : ""),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/* ------------------------------------------------------------------ search */

const SEARCH_MODES: readonly string[] = [
  "auto", "map", "files", "outline", "sections", "text", "structure", "json", "yaml",
  "definition", "references", "symbols", "info", "semantic", "graph", "locate",
];

const SearchParams = Type.Object({
  pattern: Type.Optional(Type.String({ description: "What to find: an identifier, a path, or a regex. The harness routes automatically: identifier → definitions + references with read anchors; file path → outline; anything else → text search with context." })),
  path: Type.Optional(Type.String({ description: "Directory or file to scope the search (default: worktree root). A bare file path returns its outline." })),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Specific files or directories to search. Use instead of path.",
    }),
  ),
  line: Type.Optional(Type.Number({ description: "1-based line. With column + path, answers definition + references + hover at that position." })),
  column: Type.Optional(Type.Number({ description: "1-based column. With line + path, answers definition + references + hover at that position." })),
  language: Type.Optional(Type.String({ description: "Language id, e.g. typescript, python, rust. Default: infer from path." })),
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

const POSITION_MODES = new Set(["definition", "references", "info"]);

/** Weak models serialize absent optionals as the string "null". A null mode
 * means "no mode asked for", so drop it (the default applies); null entries
 * in paths are never real targets. The pattern itself is left alone — "null"
 * is legitimate search text. path and paths together mean the union: fold a
 * real path into the paths list instead of failing. */
function cleanSearchArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  let changed = false;
  const isNullish = (value: unknown): boolean =>
    typeof value === "string" && (value.trim() === "null" || value.trim() === "undefined");
  if (isNullish(out.mode)) {
    delete out.mode;
    changed = true;
  }
  if (isNullish(out.path)) {
    delete out.path;
    changed = true;
  }
  if (Array.isArray(out.paths)) {
    const kept = out.paths.filter((item) => !isNullish(item));
    if (kept.length !== out.paths.length) {
      if (kept.length > 0) out.paths = kept;
      else delete out.paths;
      changed = true;
    }
  }
  if (typeof out.path === "string" && Array.isArray(out.paths) && out.paths.length > 0) {
    out.paths = [out.path, ...out.paths.filter((item) => item !== out.path)];
    delete out.path;
    changed = true;
  }
  return changed ? out : args;
}

/** Files above this size get a line count before any hint decision. */
const LARGE_FILE_BYTES = 40 * 1024;
/** A hit file with more lines than this earns a read-around hint. */
const LARGE_FILE_LINES = 800;

/** Append a read-around hint for hits inside huge files. A bare `path:line:`
 * match in a 5,000-line file invites another dozen offset pages; one line
 * naming `read { around }` points at the one call that resolves it. Only
 * files above LARGE_FILE_LINES are named, at most three, each with its first
 * hit line. Never fires on "no matches". */
function withLargeFileHint(root: string, text: string): string {
  if (!text || text === "no matches") return text;
  const hits = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(.+?):(\d+)[:-]/.exec(line);
    if (!match || hits.has(match[1]!)) continue;
    if (hits.size >= 8) break;
    hits.set(match[1]!, Number(match[2]));
  }
  const notes: string[] = [];
  for (const [rel, line] of hits) {
    if (notes.length >= 3) break;
    let size = 0;
    try {
      size = statSync(resolveWithin(root, rel)).size;
    } catch {
      continue;
    }
    if (size < LARGE_FILE_BYTES) continue;
    let lines = 0;
    try {
      const raw = readFileSync(resolveWithin(root, rel), "utf8");
      lines = raw.split("\n").length;
    } catch {
      continue;
    }
    if (lines > LARGE_FILE_LINES) {
      notes.push(
        `[${rel} is ${lines} lines; page it with read { "path": "${rel}", "around": ${line} } or batch read { "symbols": [...] }, not offset pages]`,
      );
    }
  }
  return notes.length > 0 ? `${text}\n${notes.join("\n")}` : text;
}

export function searchTool(ctx: ToolContext): AgentTool<typeof SearchParams> {
  return {
    name: "search",
    label: "search",
    description:
      "Read-only bounded search. One verb: pass an identifier, a file path, or a " +
      "regex, optionally scoped by path/paths. The harness routes automatically: identifier → definitions + " +
      "references with enclosing code and read anchors; file path → outline; path + line + column → definition + " +
      "references + hover at that position; anything else → text search with 2 context lines. " +
      "Large-file hits name a read-around line; empty results name the call to try next. " +
      "Never touches excluded directories (node_modules, dist, build, target, .git, .machine_code/local, ...), secret files (.env, *.pem, keys), or binary files.",
    parameters: SearchParams,
    prepareArguments: (args) => cleanSearchArgs(args) as Static<typeof SearchParams>,
    async execute(_id, params: Static<typeof SearchParams>) {
      const scope = params.path ? resolveWithin(ctx.root, params.path) : ctx.root;
      // `mode` is intentionally absent from the model-visible schema: the
      // harness routes every query itself. It is still honored when present
      // (tests, internal callers), with auto as the default.
      const requestedMode = (params as unknown as { mode?: string }).mode ?? "auto";
      let mode = requestedMode;
      if (mode === "auto") {
        if (params.path) {
          try {
            // A pattern plus a file path asks for matches inside that file;
            // a bare file path asks for its outline.
            mode = statSync(scope).isFile() ? (params.pattern ? "text" : "outline") : "text";
          } catch {
            mode = "text";
          }
        } else if (params.pattern && /^[A-Za-z_$][\w$]*$/.test(params.pattern.trim())) {
          mode = "locate";
        } else {
          mode = "text";
        }
      }
      if (!SEARCH_MODES.includes(mode)) {
        return fail(`unknown search mode "${mode}". Use one of: ${SEARCH_MODES.join(", ")}.`);
      }
      const limit = Math.max(1, Math.floor(params.limit ?? 200));
      // Text search as a callable unit: `locate` composes it with symbol
      // lookup, and the no-match pointer needs the raw result. Returns raw
      // matches; callers add presentation.
      const execTextSearch = async (): Promise<AgentToolResult<undefined>> => {
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
          "--context",
          "2",
          ...excludeGlobs(),
          "--",
          params.pattern,
        ];
        if (params.paths && params.paths.length > 0) {
          const targets = params.paths.map((path) => resolveWithin(ctx.root, path));
          const visible = targets.filter((target) => !isSecretPath(toRelative(ctx.root, target)));
          if (visible.length === 0) return ok("no matches");
          args.push(...visible);
          const result = await exec("rg", args, ctx.root, SEARCH_CAP_BYTES);
          if (result.isError) return result;
          // rg prints absolute targets; keep state and model paths repo-relative.
          const text = result.content
            .map((item) => (item.type === "text" ? item.text : ""))
            .join("\n")
            .replaceAll(`${ctx.root}/`, "");
          return ok(text);
        }
        // Always run from the worktree root and pass the scope as a target.
        // With cwd=scope, rg prints paths relative to that directory, which
        // the state ingester then stores as bogus root-relative files.
        if (scopeIsFile || scope !== ctx.root) args.push(toRelative(ctx.root, scope));
        const scoped = await exec("rg", args, ctx.root, SEARCH_CAP_BYTES);
        if (scoped.isError) return scoped;
        return ok(
          scoped.content
            .map((item) => (item.type === "text" ? item.text : ""))
            .join("\n"),
        );
      };
      const runText = async (): Promise<AgentToolResult<undefined>> => {
        const found = await execTextSearch();
        if (found.isError) return found;
        return ok(
          withLargeFileHint(
            ctx.root,
            found.content
              .map((item) => (item.type === "text" ? item.text : ""))
              .join("\n"),
          ),
        );
      };
      // Position query: path + line + column answers definition, references,
      // and hover in one call instead of three LSP round trips. Like the
      // outline path below, the server only starts when the run supplies a
      // process supervisor: a library call or a test must never spawn a
      // detached LSP server that outlives its caller. The fallback still
      // answers the position with the file's outline.
      const runAtPosition = async (
        outlinePath: string,
        line: number,
        column: number,
      ): Promise<AgentToolResult<undefined>> => {
        const header = `${outlinePath}:${line}:${column}`;
        const language = ctx.processes ? params.language ?? languageForPath(outlinePath) : null;
        const abs = resolveWithin(ctx.root, outlinePath);
        const pos = { line: line - 1, character: column - 1 };
        if (language) {
          const { lspClientFor, serverAvailable } = await import("../lsp/index.js");
          if (serverAvailable(language)) {
            const client = lspClientFor(ctx.root, language, ctx.processes);
            if (client) {
              const [defs, refs, hover] = await Promise.all([
                client.definition(abs, pos),
                client.references(abs, pos),
                client.hover(abs, pos),
              ]);
              if (defs !== null || refs !== null || hover !== null) {
                const parts: string[] = [];
                if (defs && defs.length > 0) {
                  parts.push(
                    `definition:\n${defs.map((loc) => `${loc.uri.replace("file://", "")}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`).join("\n")}`,
                  );
                }
                if (refs && refs.length > 0) {
                  parts.push(
                    `references (${refs.length}):\n${refs.slice(0, limit).map((loc) => `${loc.uri.replace("file://", "")}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`).join("\n")}`,
                  );
                }
                if (hover) {
                  const info =
                    typeof hover.contents === "string"
                      ? hover.contents
                      : ((hover.contents as { value?: string }).value ?? JSON.stringify(hover.contents));
                  if (info) parts.push(`info:\n${info}`);
                }
                if (parts.length > 0) {
                  return ok([header, ...parts, `next: read { "path": "${outlinePath}", "around": ${line} }`].join("\n"));
                }
              }
            }
          }
        }
        const file = await outlineFile(ctx.root, outlinePath);
        if (!file) return fail(`no outline for ${outlinePath} (binary or unreadable)`);
        return ok(
          [
            header,
            `${file.path} (${file.lines} lines${language ? `; LSP ${language} unavailable` : "; outline only — no LSP in this context"})`,
            renderOutline(file) || "(no symbols)",
            `next: read { "path": "${outlinePath}", "around": ${line} }`,
          ].join("\n"),
        );
      };
      if (
        requestedMode === "auto" &&
        params.line != null &&
        params.column != null &&
        typeof params.path === "string"
      ) {
        return runAtPosition(params.path, params.line, params.column);
      }
      try {
        switch (mode) {
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
            const matchers = params.pattern
              ? expandGlobBraces(params.pattern).map((pattern) => globToRegExp(pattern))
              : [];
            if (scopeIsFile) {
              const rel = toRelative(ctx.root, scope);
              if (isSecretPath(rel)) return ok("no matches");
              const match = matchers.length === 0 || matchers.some((matcher) => matcher.test(rel));
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
            // `rg` lists paths relative to the scope. Match both forms so a
            // caller can pass path=test with pattern=test/*.js, and always
            // return repo-relative paths to the model.
            const rootRelative = (file: string): string => toRelative(ctx.root, join(scope, file));
            const filtered = matchers.length > 0
              ? all.filter((file) => {
                  const rooted = rootRelative(file);
                  return matchers.some((matcher) => matcher.test(file) || matcher.test(rooted));
                })
              : all;
            const listed = filtered.map(rootRelative);
            return ok(capText(listed.join("\n"), SEARCH_CAP_BYTES).text || "no matches");
          }
          case "text": {
            const found = await runText();
            if (found.isError) return found;
            const text = found.content
              .map((item) => (item.type === "text" ? item.text : ""))
              .join("\n");
            if (text === "no matches" && params.pattern) {
              // A bare "no matches" costs a turn and teaches nothing. The
              // usual causes are a case-mismatched identifier or a symbol
              // the model has not named exactly; point at the call that
              // answers either way.
              return ok(
                `no matches for "${params.pattern}"\n` +
                  `[try search { "pattern": "${params.pattern}" } for identifier forms, or check case and scope]`,
              );
            }
            return found;
          }
          case "locate": {
            // One call answering "where is this defined and used": symbol
            // definitions plus every text reference with enclosing code and
            // the read call that resolves each file. No follow-up needed.
            if (!params.pattern) return fail("locate mode requires an identifier pattern");
            const query = params.pattern.trim();
            const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
            const defs: string[] = [];
            if (scope && params.path) {
              try {
                if (statSync(scope).isFile()) {
                  const rel = toRelative(ctx.root, scope);
                  const file = built.map.files.find((entry) => entry.path === rel) ??
                    (await outlineFile(ctx.root, rel));
                  for (const symbol of file?.symbols ?? []) {
                    if (symbol.name.toLowerCase().includes(query.toLowerCase())) {
                      defs.push(`${rel}:${symbol.line} ${symbol.kind} ${symbol.name}`);
                    }
                    if (defs.length >= 10) break;
                  }
                } else {
                  defs.push(...findSymbols(built.map, query, 10));
                }
              } catch {
                defs.push(...findSymbols(built.map, query, 10));
              }
            } else {
              defs.push(...findSymbols(built.map, query, 10));
            }
            const refs = await execTextSearch();
            if (refs.isError) {
              return refs;
            }
            const raw = refs.content
              .map((item) => (item.type === "text" ? item.text : ""))
              .join("\n");
            if (!raw || raw === "no matches") {
              return ok(
                defs.length > 0
                  ? `locate "${query}": ${defs.length} definition(s), no references\ndefinitions:\n${defs.join("\n")}`
                  : `no matches for "${query}"`,
              );
            }
            const outlines = new Map<string, Awaited<ReturnType<typeof outlineFile>>>();
            const filesInOrder: string[] = [];
            for (const line of raw.split("\n")) {
              const match = /^(.+?):(\d+)[:-]/.exec(line);
              if (match && !filesInOrder.includes(match[1]!)) filesInOrder.push(match[1]!);
              if (filesInOrder.length >= 7) break;
            }
            const annotate = filesInOrder.length <= 6;
            if (annotate) {
              for (const rel of filesInOrder) {
                try {
                  outlines.set(rel, await outlineFile(ctx.root, rel));
                } catch {
                  outlines.set(rel, null);
                }
              }
            }
            let references = 0;
            const anchors: Array<{ path: string; line: number }> = [];
            const rendered = raw.split("\n").map((line) => {
              const match = /^(.+?):(\d+):(.*)$/.exec(line);
              if (!match) return line;
              references += 1;
              const rel = match[1]!;
              const lineNo = match[2]!;
              const code = match[3]!;
              if (!anchors.some((anchor) => anchor.path === rel)) {
                anchors.push({ path: rel, line: Number(lineNo) });
              }
              if (!annotate) return line;
              const file = outlines.get(rel);
              const container = file ? rangeAround(file, Number(lineNo)) : null;
              return container && container.name ? `${rel}:${lineNo} [in ${container.name}]${code}` : line;
            });
            const next = anchors.slice(0, 3).map(
              (anchor) => `read { "path": "${anchor.path}", "around": ${anchor.line} }`,
            );
            return ok(
              [
                `locate "${query}": ${defs.length} definition(s), ${references} reference(s)`,
                ...(defs.length > 0 ? ["definitions:", ...defs] : []),
                "references:",
                ...rendered,
                ...(next.length > 0 ? [`next: ${next.join(" · ")}`] : []),
              ].join("\n"),
            );
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
          case "semantic": {
            if (!params.pattern) return fail("semantic mode requires a query");
            const semantic = ctx.semantic?.() ?? loadSemanticOrDeterministic(ctx.root);
            if (!semantic) {
              return fail(
                "semantic map is not available; use map, outline, or text search, or refresh with machine_code map --semantic",
              );
            }
            const matches = searchSemantic(semantic, params.pattern, limit);
            if (matches.length === 0) {
              return ok(`no semantic matches for "${params.pattern}"; try text or outline`);
            }
            return ok(
              matches
                .map((match) => {
                  const files = match.entry.keyFiles?.length
                    ? `\n  files: ${match.entry.keyFiles.join(", ")}`
                    : "";
                  const deps = match.entry.deps?.length
                    ? `\n  deps: ${match.entry.deps.join(", ")}`
                    : "";
                  const hints = match.entry.editHints?.length
                    ? `\n  hints: ${match.entry.editHints.join("; ")}`
                    : "";
                  return `${match.module} (score ${match.score})\n  ${match.entry.summary}${files}${deps}${hints}`;
                })
                .join("\n\n"),
            );
          }
          case "graph": {
            const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
            const semantic = ctx.semantic?.() ?? loadSemanticOrDeterministic(ctx.root);
            return ok(
              renderModuleGraph(built.map, semantic, params.pattern ?? params.path ?? "", 16 * 1024),
            );
          }
          case "sections": {
            // Comment headings inside one large file. A giant function can
            // hide every useful block from a top-level outline.
            const sectionPath = params.path ?? params.pattern;
            if (!sectionPath) return fail('sections mode requires a path (e.g. "src/tui.ts")');
            const abs = resolveWithin(ctx.root, sectionPath);
            if (isSecretPath(toRelative(ctx.root, abs))) return ok("no matches");
            assertRegularFile(abs);
            if (isBinaryFile(abs)) return fail(`refusing to read a binary file: ${sectionPath}`);
            const text = readFileSync(abs, "utf8");
            const lines = text.split("\n");
            const found = documentSections(text, sectionPath).map((heading) => `${heading.line}: ${heading.text}`);
            if (found.length === 0) return ok(`no section headings in ${sectionPath}; use outline or text`);
            return ok(`${sectionPath} (${lines.length} lines)\n${found.slice(0, limit).join("\n")}`);
          }
          case "outline": {
            // Accept the path in `pattern` too: models often put the filename
            // there before they learn the schema.
            const outlinePath = params.path ?? params.pattern;
            if (!outlinePath) return fail('outline mode requires a path (e.g. "src/file.ts")');
            // LSP document symbols see nested containers and give line:column
            // positions. Fall back to the deterministic top-level outline.
            const language = params.language ?? languageForPath(outlinePath);
            // A real run supplies the process supervisor. Without it, do not
            // start a detached LSP server from a library call or a test.
            if (language && ctx.processes) {
              const { formatDocumentSymbols, lspClientFor, serverAvailable } = await import("../lsp/index.js");
              if (serverAvailable(language)) {
                const client = lspClientFor(ctx.root, language, ctx.processes);
                if (client) {
                  const symbols = await client.documentSymbols(resolveWithin(ctx.root, outlinePath));
                  if (symbols && symbols.length > 0) {
                    const formatted = formatDocumentSymbols(symbols, outlinePath);
                    if (formatted.length > 0) {
                      const query = params.path ? (params.pattern ?? "").toLowerCase() : "";
                      const filtered = query
                        ? formatted.filter((line) => line.toLowerCase().includes(query))
                        : formatted;
                      return ok(
                        `${outlinePath} (LSP symbols)\n${(filtered.length > 0 ? filtered : formatted).slice(0, limit).join("\n")}`,
                      );
                    }
                  }
                }
              }
            }
            const file = await outlineFile(ctx.root, outlinePath);
            if (!file) return fail(`no outline for ${outlinePath} (binary or unreadable)`);
            return ok(
              `${file.path} (${file.lines} lines)\n${renderOutline(file) || "(no symbols)"}`,
            );
          }
          case "json":
          case "yaml": {
            const binary = mode === "json" ? "jq" : "yq";
            if (!params.pattern) return fail(`${mode} mode requires a query pattern`);
            if (!params.path) return fail(`${mode} mode scopes to one document: pass its path`);
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
            if (mode === "symbols") {
              const language = params.language ?? (params.path ? languageForPath(params.path) : null);
              if (language) {
                const { formatDocumentSymbols, formatSymbols, lspClientFor, serverAvailable } = await import("../lsp/index.js");
                if (serverAvailable(language)) {
                  const client = lspClientFor(ctx.root, language, ctx.processes);
                  if (client) {
                    if (params.path) {
                      const symbols = await client.documentSymbols(resolveWithin(ctx.root, params.path));
                      if (symbols && symbols.length > 0) {
                        const formatted = formatDocumentSymbols(symbols, params.path);
                        if (formatted.length > 0) {
                          const query = (params.pattern ?? "").toLowerCase();
                          const filtered = query
                            ? formatted.filter((line) => line.toLowerCase().includes(query))
                            : formatted;
                          return ok((filtered.length > 0 ? filtered : formatted).slice(0, limit).join("\n"));
                        }
                      }
                    } else {
                      const symbols = await client.workspaceSymbols(params.pattern ?? "");
                      if (symbols && symbols.length > 0) {
                        return ok(formatSymbols(symbols.slice(0, limit)).join("\n"));
                      }
                    }
                  }
                }
              }
              const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
              let scopedMap = built.map;
              if (params.path) {
                const scopedPath = toRelative(ctx.root, resolveWithin(ctx.root, params.path));
                const file =
                  built.map.files.find((entry) => entry.path === scopedPath) ??
                  (await outlineFile(ctx.root, scopedPath));
                scopedMap = { ...built.map, files: file ? [file] : [] };
              }
              const hits = findSymbols(scopedMap, params.pattern ?? "", limit);
              const note = language ? `\n[LSP ${language} unavailable or empty; used repo map]` : "";
              if (hits.length === 0) {
                // An explicit symbols query with no hits is a dead end that
                // costs a turn and teaches nothing. Point at the call that
                // answers instead of leaving the model to guess it.
                return ok(
                  `no symbols matching "${params.pattern ?? ""}"${note}\n` +
                    `[try search { "pattern": "${params.pattern ?? ""}" } for definitions + references, or text for strings]`,
                );
              }
              return ok(hits.join("\n") + note);
            }
            if (POSITION_MODES.has(mode)) {
              if (!params.path || params.line == null || params.column == null) {
                return fail(`LSP mode "${mode}" requires path + line + column`);
              }
              const language = params.language ?? languageForPath(params.path);
              if (!language) {
                return fail(`no LSP server for ${params.path}; use outline, text, or structure`);
              }
              const spec = serverForLanguage(language);
              if (!spec) return fail(`no LSP server for language "${language}"`);
              const { lspClientFor, serverAvailable } = await import("../lsp/index.js");
              if (!serverAvailable(language)) {
                return fail(
                  `LSP ${language} unavailable (${spec.name}). Install: ${spec.install}. ` +
                  "Fallback: outline, text, or structure.",
                );
              }
              const abs = resolveWithin(ctx.root, params.path);
              const client = lspClientFor(ctx.root, language, ctx.processes);
              if (!client) return fail(`LSP ${language} unavailable. Fallback: outline, text, or structure.`);
              const pos = { line: params.line - 1, character: params.column - 1 };
              if (mode === "definition") {
                const locs = await client.definition(abs, pos);
                if (locs === null) return fail("LSP server did not respond. For TypeScript, ensure typescript is installed in the project. Fallback: outline, text, or structure.");
                if (locs.length === 0) return ok("no definition");
                return ok(locs.map((l) => `${l.uri.replace("file://", "")}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join("\n"));
              }
              if (mode === "references") {
                const locs = await client.references(abs, pos);
                if (locs === null) return fail("LSP server did not respond. For TypeScript, ensure typescript is installed in the project. Fallback: outline, text, or structure.");
                if (locs.length === 0) return ok("no references");
                return ok(locs.map((l) => `${l.uri.replace("file://", "")}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join("\n"));
              }
              if (mode === "info") {
                const hover = await client.hover(abs, pos);
                if (hover === null) return fail("LSP server did not respond. For TypeScript, ensure typescript is installed in the project. Fallback: outline, text, or structure.");
                if (!hover) return ok("no info");
                const content = typeof hover.contents === "string" ? hover.contents : (hover.contents as { value?: string }).value ?? JSON.stringify(hover.contents);
                return ok(content);
              }
              return fail(`unknown LSP mode: ${mode}`);
            }
            return fail(`unknown search mode: ${mode}`);
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

const CORE_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "search",
  "command",
  "context",
  "ask",
  "issue",
  "artifact",
  "pr",
]);

/** Weak models serialize absent optionals as the string "null". No command
 * is named "null", so treat it as absent instead of failing the call. */
function cleanCommandArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  // Accept the common {command, args} spelling as {action:"run", name, args}.
  // Models guess this shape; one shape miss should not cost a turn.
  if (
    out.name === undefined &&
    typeof out.command === "string" &&
    out.command.trim() !== "" &&
    out.command.trim() !== "null"
  ) {
    out.name = out.command;
    out.action = out.action ?? "run";
    delete out.command;
  }
  if (typeof out.name === "string" && (out.name.trim() === "" || out.name.trim() === "null" || out.name.trim() === "undefined")) {
    delete out.name;
  }
  return out;
}

export function commandTool(ctx: ToolContext): AgentTool<typeof CommandParams> {
  return {
    name: "command",
    label: "command",
    description:
      "List all typed command schemas (large); describe one; or run it (core:* built-ins and allowlisted manifests). No arbitrary shell. " +
      "issue, pr, artifact, read, search, context, and ask are tools, not commands; call them directly.",
    parameters: CommandParams,
    prepareArguments: (args) => cleanCommandArgs(args) as Static<typeof CommandParams>,
    async execute(_id, params: Static<typeof CommandParams>) {
      try {
        if (params.action === "list") {
          // A name with list means describe: the model wants one schema, and
          // failing the call only to name describe would waste a turn.
          if (params.name) return ok(describeCommand(params.name, ctx.commands));
          const items = [...ctx.commands.keys()]
            .sort()
            .map((name) => describeCommand(name, ctx.commands));
          return ok(items.join("\n\n"));
        }
        if (!params.name) return fail(`${params.action} requires a name`);
        if (params.name === "command") {
          // The model is treating this as a shell. Name the actual surface
          // once, instead of repeating "command is a tool" at itself.
          return fail(
            "There is no shell here. The command tool runs typed commands only: " +
              `${[...ctx.commands.keys()].sort().join(", ")}. ` +
              'Example: {"action":"run","name":"typescript:build","args":{}}.',
          );
        }
        if (CORE_TOOL_NAMES.has(params.name)) {
          const available = !ctx.tools || ctx.tools.includes(params.name);
          return fail(
            available
              ? `${params.name} is a tool, not a command. Call the ${params.name} tool directly with its action/parameters.`
              : `${params.name} is a tool, but this role does not have it. Available tools: ${
                  (ctx.tools ?? []).join(", ") || "(none)"
                }.`,
          );
        }
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

const IssueGraphUnavailableParams = Type.Object({});

function issueGraphUnavailable(): AgentTool<typeof IssueGraphUnavailableParams> {
  return {
    name: "issue_graph",
    label: "issue_graph",
    description: "Create an Epic with Features and Tasks.",
    parameters: IssueGraphUnavailableParams,
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

/* ------------------------------------------------------------------- skill */

const SkillUnavailableParams = Type.Object({
  action: Type.String({ description: "Skill operation." }),
});

function skillUnavailable(): AgentTool<typeof SkillUnavailableParams> {
  return {
    name: "skill",
    label: "skill",
    description: "On-demand skill bodies.",
    parameters: SkillUnavailableParams,
    async execute() {
      return fail("skill bodies are not available in this run (role lacks skill access)");
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
  | "ask"
  | "issue"
  | "issue_graph"
  | "artifact"
  | "skill"
  | "pr";

export function coreTools(ctx: ToolContext, allowed: readonly CoreToolName[]): AgentTool[] {
  const all: Record<CoreToolName, AgentTool> = {
    read: readTool(ctx),
    write: writeTool(ctx),
    edit: editTool(ctx),
    search: searchTool(ctx),
    command: commandTool(ctx),
    context: contextTool(ctx),
    ask: ctx.ask ? askTool(ctx.ask) : askUnavailable(),
    issue: ctx.issues ? issueTool(ctx.issues) : issueUnavailable(),
    issue_graph: ctx.issues ? issueGraphTool(ctx.issues) : issueGraphUnavailable(),
    artifact: ctx.artifacts ? artifactTool(ctx.artifacts) : artifactUnavailable(),
    skill: ctx.skills ? skillTool(ctx.skills) : skillUnavailable(),
    pr: ctx.prs ? prTool(ctx.prs) : prUnavailable(),
  };
  // Prefer provider-side JSON-schema constrained sampling. Models that pass
  // tool-call tests in OpenCode are often much weaker without it: Beam Free is
  // one example. `prefer` makes unsupported providers fall back to plain
  // schemas instead of failing the run.
  return allowed.map((name) => ({
    ...all[name],
    constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
  }));
}
