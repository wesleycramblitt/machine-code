/**
 * machine_code — `inspect` tool: deterministic codebase retrieval.
 *
 * Replaces `context expand` with a cleaner interface.  Uses the deterministic
 * repo map for structure, filesystem for source, and (when available) LSP for
 * precise symbol resolution.
 *
 * Auto-stores complete results as artifacts for re-fetch via `recall`.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { READ_CAP_BYTES, capText, resolveWithin, isBinaryFile } from "./safety.js";
import { buildRepoMap, symbolRange, type MapFile, type RepoMap } from "../map/deterministic.js";
import type { ToolContext } from "./index.js";

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const INSPECT_TARGETS = ["symbol", "file", "directory", "references"] as const;

const InspectParams = Type.Object({
  target: Type.String({
    enum: [...INSPECT_TARGETS],
    description: "What to inspect: symbol | file | directory | references.",
  }),
  name: Type.Optional(Type.String({ description: "Symbol name (for target=symbol or target=references)." })),
  path: Type.Optional(Type.String({ description: "File or directory path (for target=file or target=directory)." })),
  detail: Type.Optional(
    Type.String({
      enum: ["summary", "full"],
      description: "Result depth. summary (default) returns compact info; full returns source excerpts.",
    }),
  ),
});

function fileOutline(file: MapFile, source: string, full: boolean): string[] {
  const lines: string[] = [];
  const total = source.split("\n").length;
  lines.push(`path: ${file.path}`);
  lines.push(`language: ${file.lang}`);
  lines.push(`lines: ${total}`);
  lines.push(`symbols: ${file.symbols.length}`);
  lines.push(`bytes: ${file.bytes}`);
  if (file.doc) lines.push(`documentation: ${file.doc.split("\n")[0]!.slice(0, 200)}`);
  if (file.imports && file.imports.length > 0) {
    lines.push(`imports: ${file.imports.slice(0, 12).join(", ")}`);
  }
  if (!full) return lines;
  const excerpt = source.split("\n").slice(0, 200);
  lines.push("");
  for (let i = 0; i < excerpt.length; i++) {
    lines.push(`${i + 1}: ${excerpt[i]}`);
  }
  if (excerpt.length < total) lines.push(`… [${total - 200} more lines]`);
  return lines;
}

function symbolLines(file: MapFile, source: string, name: string, full: boolean): string[] {
  const lines: string[] = [];
  const range = symbolRange(file, name);
  if (!range) {
    lines.push(`symbol "${name}" not found in ${file.path}`);
    return lines;
  }
  const raw = source.split("\n");
  lines.push(`symbol: ${name}`);
  lines.push(`kind: ${range.kind}`);
  lines.push(`file: ${file.path}`);
  lines.push(`lines: [${range.start}, ${range.end}]`);
  const sig = raw[range.start - 1]?.trim() ?? "";
  if (sig) lines.push(`signature: "${sig}"`);
  if (full) {
    const body = raw.slice(range.start - 1, range.end);
    lines.push("");
    for (let i = 0; i < body.length; i++) {
      lines.push(`${range.start + i}: ${body[i]}`);
    }
  }
  return lines;
}

function directoryListing(root: string, path: string, map: RepoMap): string[] {
  const lines: string[] = [];
  const abs = resolveWithin(root, path);
  if (!abs) return ["path is outside the repo"];
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const children = map.files
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"))
    .sort((a, b) => a.path.localeCompare(b.path));
  const dirs = new Set<string>();
  for (const f of map.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) dirs.add(rest.slice(0, slash));
  }
  lines.push(`directory: ${path}`);
  lines.push(`subdirectories: ${[...dirs].sort().join(", ")}`);
  lines.push("");
  for (const child of children) {
    const label = child.symbols.length > 0
      ? `${child.path} (${child.symbols.length} symbols, ${child.lines} lines)`
      : `${child.path} (${child.lines} lines)`;
    lines.push(label);
  }
  return lines;
}

/** Try to locate a symbol via LSP. Returns formatted lines or null. */
async function lspSymbolLookup(
  root: string,
  name: string,
  processes: import("../processes/supervisor.js").ProcessSupervisor | undefined,
): Promise<string[] | null> {
  if (!processes) return null;
  try {
    const { lspClientFor, serverAvailable, formatSymbols } = await import("../lsp/index.js");
    // Try each language that has a server configured
    for (const lang of ["typescript", "javascript", "python", "rust", "go", "csharp", "java"]) {
      if (!serverAvailable(lang)) continue;
      const client = lspClientFor(root, lang, processes);
      if (!client) continue;
      const symbols = await client.workspaceSymbols(name);
      if (!symbols || symbols.length === 0) continue;
      // Filter to exact matches first
      const exact = symbols.filter((s: { name?: string }) => (s.name ?? "") === name);
      const matched = exact.length > 0 ? exact : symbols.slice(0, 16);
      const lines = formatSymbols(matched);
      if (lines.length > 0) {
        const result: string[] = [`symbol: ${name} (LSP)`];
        result.push(...lines);
        // Try to get the definition location for source
        const first = matched[0] as
          { location?: { uri?: string; range?: { start?: { line?: number } } } } | undefined;
        if (first?.location?.uri) {
          const filePath = first.location.uri.replace(/^file:\/\//, "");
          const pos = {
            line: (first.location.range?.start?.line ?? 0),
            character: 0,
          };
          const defs = await client.definition(filePath, pos);
          if (defs && defs.length > 0) {
            const def = defs[0] as { uri?: string; range?: { start?: { line?: number; character?: number } } } | undefined;
            if (def?.uri) {
              const defPath = def.uri.replace(/^file:\/\//, "");
              const defLine = (def.range?.start?.line ?? 0) + 1;
              result.push(`definition: ${defPath}:${defLine}`);
            }
          }
        }
        return result;
      }
    }
  } catch {
    // LSP unavailable, fall through to map
  }
  return null;
}

/** Try to get references via LSP. Returns formatted lines or null. */
async function lspReferencesLookup(
  root: string,
  name: string,
  processes: import("../processes/supervisor.js").ProcessSupervisor | undefined,
): Promise<string[] | null> {
  if (!processes) return null;
  try {
    const { lspClientFor, serverAvailable } = await import("../lsp/index.js");
    for (const lang of ["typescript", "javascript", "python", "rust", "go", "csharp", "java"]) {
      if (!serverAvailable(lang)) continue;
      const client = lspClientFor(root, lang, processes);
      if (!client) continue;
      const symbols = await client.workspaceSymbols(name);
      if (!symbols || symbols.length === 0) continue;
      const matched = symbols.filter((s: { name?: string }) => (s.name ?? "") === name);
      if (matched.length === 0) continue;
      // Find the definition file + line for the first match
      const first = matched[0] as
        { location?: { uri?: string; range?: { start?: { line?: number } } } } | undefined;
      if (!first?.location?.uri) continue;
      const filePath = first.location.uri.replace(/^file:\/\//, "");
      const pos = {
        line: (first.location.range?.start?.line ?? 0),
        character: 0,
      };
      const refs = await client.references(filePath, pos);
      if (!refs || refs.length === 0) return null;
      const result: string[] = [`symbol: ${name} (LSP references)`];
      for (const ref of refs) {
        const r = ref as { uri?: string; range?: { start?: { line?: number; character?: number } } } | undefined;
        if (!r?.uri) continue;
        const refPath = r.uri.replace(/^file:\/\//, "");
        const refLine = (r.range?.start?.line ?? 0) + 1;
        const refChar = (r.range?.start?.character ?? 0) + 1;
        result.push(`  ${refPath}:${refLine}:${refChar}`);
      }
      if (result.length > 1) return result;
    }
  } catch {
    // LSP unavailable, fall through to map
  }
  return null;
}

/** Try to get document symbols via LSP. Returns formatted lines or null. */
async function lspFileOutline(
  root: string,
  path: string,
  processes: import("../processes/supervisor.js").ProcessSupervisor | undefined,
): Promise<string[] | null> {
  if (!processes) return null;
  try {
    const { lspClientFor, serverAvailable, languageForPath, formatDocumentSymbols } = await import("../lsp/index.js");
    const lang = languageForPath(path);
    if (!lang || !serverAvailable(lang)) return null;
    const client = lspClientFor(root, lang, processes);
    if (!client) return null;
    const symbols = await client.documentSymbols(resolveWithin(root, path));
    if (!symbols || symbols.length === 0) return null;
    const formatted = formatDocumentSymbols(symbols, path);
    if (formatted.length === 0) return null;
    return [`outline (LSP symbols):`, ...formatted];
  } catch {
    return null;
  }
}

export function inspectTool(ctx: ToolContext): AgentTool<typeof InspectParams> {
  return {
    name: "inspect",
    label: "inspect",
    description:
      "Deterministic codebase retrieval: inspect a symbol, file, directory, or references. " +
      "Prefer inspect over read/search/map for symbol definitions, references, file outlines, " +
      "and directory listings — it combines definitions, callers, imports, and source in one call. " +
      "Results auto-stored as artifacts.",
    parameters: InspectParams,
    async execute(_id, params: Static<typeof InspectParams>) {
      const target = params.target;
      const rawName = params.name?.trim();
      const rawPath = params.path?.trim();
      const full = params.detail === "full";

      if (!rawName && !rawPath) return fail(`${target} requires a name or path`);
      if ((target === "symbol" || target === "references") && !rawName) {
        return fail(`${target} requires "name"`);
      }
      if ((target === "file" || target === "directory") && !rawPath) {
        return fail(`${target} requires "path"`);
      }

      const name = rawName!;
      const path = rawPath!;

      try {
        const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
        const map = built.map;

        let parts: string[] = [];

        switch (target) {
          case "symbol": {
            // Try LSP first for precise resolution
            const lspResult = await lspSymbolLookup(ctx.root, name, ctx.processes);
            if (lspResult) {
              parts = lspResult;
              break;
            }
            // Fall back to the deterministic map
            const file = map.files.find((f) => f.symbols.some((s) => s.name === name));
            if (!file) {
              const candidates = map.files
                .filter((f) => f.symbols.some((s) => s.name.includes(name)))
                .slice(0, 8)
                .map((f) => f.path);
              if (candidates.length > 0) {
                return ok(
                  `symbol "${name}" not found. Did you mean one of these files?\n${candidates.map((p) => `  ${p}`).join("\n")}\n\n` +
                  `Use inspect target=file for file outlines to find the correct symbol name.`
                );
              }
              return ok(`symbol "${name}" not found in the repo map. Use search text or map outline to locate it.`);
            }
            const abs = join(ctx.root, file.path);
            if (!existsSync(abs)) return fail(`file not found: ${file.path}`);
            const source = readFileSync(abs, "utf8");
            const lines = symbolLines(file, source, name, full);
            parts = [...lines];

            const callers = map.files
              .filter((entry) => entry.path !== file.path && (entry.imports ?? []).includes(file.path))
              .slice(0, 6);
            if (callers.length > 0) {
              parts.push("");
              parts.push("callers:");
              for (const caller of callers) parts.push(`  ${caller.path}`);
            }
            break;
          }

          case "file": {
            const abs = resolveWithin(ctx.root, path);
            if (!abs || !existsSync(abs)) return fail(`file not found: ${path}`);
            const absPath = join(ctx.root, path);
            if (isBinaryFile(absPath)) return fail(`refusing to read binary file: ${path}`);

            // Try LSP for a richer outline when detail=summary
            if (!full) {
              const lspOutline = await lspFileOutline(ctx.root, path, ctx.processes);
              if (lspOutline) {
                parts = lspOutline;
                break;
              }
            }
            // Fall back to the deterministic map
            const source = readFileSync(abs, "utf8");
            const file = map.files.find((f) => f.path === path);
            if (file) {
              parts = fileOutline(file, source, full);
            } else {
              const total = source.split("\n").length;
              parts.push(`path: ${path}`);
              parts.push(`lines: ${total}`);
              parts.push(`bytes: ${source.length}`);
              if (full) {
                const excerpt = source.split("\n").slice(0, 200);
                parts.push("");
                for (let i = 0; i < excerpt.length; i++) {
                  parts.push(`${i + 1}: ${excerpt[i]}`);
                }
                if (excerpt.length < total) parts.push(`… [${total - 200} more lines]`);
              }
            }
            break;
          }

          case "directory": {
            const abs = resolveWithin(ctx.root, path);
            if (!abs || !existsSync(abs)) return fail(`directory not found: ${path}`);
            parts = directoryListing(ctx.root, path, map);
            break;
          }

          case "references": {
            // Try LSP first for precise reference locations
            const lspResult = await lspReferencesLookup(ctx.root, name, ctx.processes);
            if (lspResult) {
              parts = lspResult;
              break;
            }
            // Fall back to the deterministic map
            const defFiles = map.files.filter((f) => f.symbols.some((s) => s.name === name));
            if (defFiles.length === 0) {
              return ok(`no definitions found for "${name}". Use search text to find usages.`);
            }
            parts.push(`symbol: ${name}`);
            parts.push("definitions:");
            for (const def of defFiles) {
              const range = symbolRange(def, name);
              if (range) parts.push(`  ${def.path}:${range.start}-${range.end}`);
            }
            const importerPaths = new Set<string>();
            for (const def of defFiles) {
              const callers = map.files
                .filter((f) => f.path !== def.path && (f.imports ?? []).includes(def.path))
                .slice(0, 10);
              for (const caller of callers) importerPaths.add(caller.path);
            }
            if (importerPaths.size > 0) {
              parts.push("possible references (via imports):");
              for (const p of [...importerPaths].sort().slice(0, 12)) parts.push(`  ${p}`);
            }
            break;
          }
        }

        if (parts.length === 0) return ok(`inspect returned no results for ${target} "${name || path}"`);

        const text = `<inspect target="${target}"${name ? ` name="${name}"` : ""}${path ? ` path="${path}"` : ""}>\n${parts.join("\n")}\n</inspect>`;

        let artifactId = "";
        if (ctx.state) {
          const artifact = ctx.state.putArtifact(text);
          artifactId = artifact.id;
        }

        const capped = capText(text, READ_CAP_BYTES);
        const result = artifactId
          ? `${capped.text}\n\n[artifact: ${artifactId}]`
          : capped.text;
        return ok(result);
      } catch (error) {
        return fail(`inspect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}