/**
 * machine_code — `inspect` tool: unified codebase retrieval.
 *
 * One call answers specifics or generic keywords. `query` accepts a file
 * path, a `path:start-end` anchor, a symbol name, or free text; the harness
 * routes it (path → file body, symbol → definition + callers + source,
 * otherwise ranked keyword search with dense per-file evidence) and returns
 * numbered, edit-ready excerpts with the match kind named per file. Paging
 * arguments (`offset`/`limit`/`around`, `symbol`, `detail`) scope file
 * bodies, so this tool also covers everything the old `read` did.
 *
 * Every result is stored as an artifact for `context recall`.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { READ_CAP_BYTES, capText, isBinaryFile, numberLinesCapped, resolveWithin } from "./safety.js";
import { buildRepoMap, symbolRange, type MapFile, type RepoMap } from "../map/deterministic.js";
import { suggestTaskFilesFromMap, type SuggestedFile } from "../map/suggest.js";
import type { ToolContext } from "./index.js";

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const InspectParams = Type.Object({
  query: Type.Optional(Type.String({
    description: "What to find: file path, path:start[-end], symbol name, or free keywords. Required unless legacy target/name/path is used.",
  })),
  target: Type.Optional(Type.String({
    description: "Legacy: symbol | file | directory | references. Translated to query automatically; prefer query.",
  })),
  name: Type.Optional(Type.String({ description: "Legacy symbol name (translated to query)." })),
  path: Type.Optional(Type.String({ description: "Scope to a directory/file, or the file to read when query names a symbol." })),
  detail: Type.Optional(Type.String({
    enum: ["outline", "summary", "full"],
    description: "Result depth. outline: signatures only; summary (default): signatures + matched bodies; full: capped bodies.",
  })),
  symbol: Type.Optional(Type.String({ description: "Read one top-level symbol's block instead of the whole file." })),
  offset: Type.Optional(Type.Number({ description: "1-based first line of a file slice (default 1)." })),
  limit: Type.Optional(Type.Number({ description: "Max lines of a file slice. Omit for the per-call cap." })),
  around: Type.Optional(Type.Number({ description: "1-based line to center a ~40-line window on." })),
  regex: Type.Optional(Type.Boolean({ description: "Treat query as a raw regex over file contents (grep semantics)." })),
});

type Params = Static<typeof InspectParams>;

/** Legacy {target, name, path} → query form. New callers pass query directly. */
function legacyToQuery(params: Params): Params {
  if (params.query && params.query.trim()) return params;
  const target = (params.target ?? "").trim();
  const name = (params.name ?? "").trim();
  const path = (params.path ?? "").trim();
  if ((target === "symbol" || target === "references") && name) {
    return { ...params, query: name, path: undefined };
  }
  if ((target === "file" || target === "directory") && path) {
    return { ...params, query: path, path: undefined };
  }
  if (!target && (name || path)) {
    return { ...params, query: (name || path) as string };
  }
  return params;
}

/** Split `path:start-end` / `path:line` anchors. Null when not an anchor. */
function parseAnchor(query: string): { path: string; start?: number; end?: number } | null {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(query.trim());
  if (!match) return null;
  const start = Number(match[2]);
  const end = match[3] !== undefined ? Number(match[3]) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { path: match[1]!, start, end };
}

function isFileOnDisk(root: string, query: string): boolean {
  try {
    return statSync(resolveWithin(root, query)).isFile();
  } catch {
    return false;
  }
}

function fileSlice(
  source: string,
  params: { symbol?: string; offset?: number; limit?: number; around?: number },
  file: MapFile | null,
  capBytes: number,
): { header: string; text: string; start: number; end: number } | { error: string } {
  const lines = source.split("\n");
  const total = lines.length;
  let start = 1;
  let end = total;
  let label = "";
  if (params.symbol) {
    const range = file ? symbolRange(file, params.symbol) : null;
    if (!range) return { error: `symbol "${params.symbol}" not found in this file` };
    start = range.start;
    end = range.end;
    label = ` (${params.symbol})`;
  } else if (params.around != null && Number.isFinite(params.around) && params.around > 0) {
    start = Math.max(1, Math.floor(params.around) - 20);
    end = Math.min(total, start + 40);
    label = ` (around ${Math.floor(params.around)})`;
  } else if (params.offset != null || params.limit != null) {
    start = Math.max(1, Math.floor(params.offset ?? 1));
    end = Math.min(total, start + Math.max(1, Math.floor(params.limit ?? total)) - 1);
  }
  const page = numberLinesCapped(lines, start, Math.max(1, end - start + 1), capBytes);
  return {
    header: `${start}-${start + page.delivered - 1} of ${total} lines${label}`,
    text: page.text,
    start,
    end: start + page.delivered - 1,
  };
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
    for (const lang of ["typescript", "javascript", "python", "rust", "go", "csharp", "java"]) {
      if (!serverAvailable(lang)) continue;
      const client = lspClientFor(root, lang, processes);
      if (!client) continue;
      const symbols = await client.workspaceSymbols(name);
      if (!symbols || symbols.length === 0) continue;
      const exact = symbols.filter((s: { name?: string }) => (s.name ?? "") === name);
      const matched = exact.length > 0 ? exact : symbols.slice(0, 16);
      const lines = formatSymbols(matched);
      if (lines.length > 0) return [`symbol: ${name} (LSP)`, ...lines];
    }
  } catch {
    // fall through to map
  }
  return null;
}

/** Ranked keyword fallback: symbol-substring + path-substring + ranker. */
function fuzzyFiles(map: RepoMap, query: string, scope?: string): SuggestedFile[] {
  const q = query.toLowerCase();
  const inScope = (p: string): boolean => !scope || p === scope || p.startsWith(`${scope}/`);
  const ranked = suggestTaskFilesFromMap(map, query, map.files.length);
  const rankByPath = new Map(ranked.map((entry) => [entry.path, entry]));
  const out: SuggestedFile[] = [];
  const seen = new Set<string>();
  const push = (entry: SuggestedFile): void => {
    if (seen.has(entry.path) || !inScope(entry.path)) return;
    seen.add(entry.path);
    out.push(entry);
  };
  // Exact symbol names first — decisive, never outranked by prose.
  for (const file of map.files) {
    if (!inScope(file.path)) continue;
    const hit = file.symbols.find((symbol) => symbol.name.toLowerCase() === q);
    if (hit) {
      const rankedEntry = rankByPath.get(file.path);
      push({
        path: file.path,
        reason: `${hit.name} symbol`,
        score: 1_000_000,
        matched: [hit.name],
        keywords: [query],
        symbolVia: { [hit.name]: [query] },
      });
      void rankedEntry;
    }
  }
  // Basename / path substring next.
  const base = basename(query).toLowerCase();
  for (const file of map.files) {
    if (seen.has(file.path) || !inScope(file.path)) continue;
    const fileBase = (file.path.split("/").pop() ?? "").toLowerCase();
    if ((base.length >= 3 && fileBase.includes(base)) || file.path.toLowerCase().includes(q)) {
      const rankedEntry = rankByPath.get(file.path);
      push({
        path: file.path,
        reason: rankedEntry?.reason ?? "path match",
        score: 500_000,
        matched: rankedEntry?.matched ?? [query],
        keywords: rankedEntry?.keywords ?? [query],
        symbolVia: rankedEntry?.symbolVia ?? {},
      });
    }
    if (out.length >= 8) break;
  }
  // Ranker evidence fills the rest, capped.
  for (const entry of ranked) {
    if (out.length >= 6) break;
    push(entry);
  }
  return out.slice(0, 6);
}

const BODY_LINE_CAP = 60;
const FIND_BYTES_CAP = 12 * 1024;

export function inspectTool(ctx: ToolContext): AgentTool<typeof InspectParams> {
  return {
    name: "inspect",
    label: "inspect",
    description:
      "Find and read code in one call: pass a file path, path:line range, symbol name, or free keywords. " +
      "Returns numbered, edit-ready excerpts with the match kind (symbol | path | keyword | regex) named per file. " +
      "Use detail=outline for signatures, summary (default) for matched bodies, full for capped bodies; " +
      "offset/limit/around/symbol page a file. This replaces read and search — do not page with offset unless paging.",
    parameters: InspectParams,
    prepareArguments: (args) => legacyToQuery(args as Params) as Static<typeof InspectParams>,
    async execute(_id, raw: Static<typeof InspectParams>) {
      const params = legacyToQuery(raw as Params);
      const query = (params.query ?? "").trim();
      if (!query) {
        return fail(
          'inspect requires query: a file path, path:line, symbol name, or keywords. Example: {"query": "approveIssue"} or {"query": "src/tasks/issue.ts:83-116"}.',
        );
      }
      const detail = params.detail ?? "summary";
      if (detail !== "outline" && detail !== "summary" && detail !== "full") {
        return fail(`unknown detail "${params.detail}". Use outline | summary | full.`);
      }
      const scope = params.path?.trim() || undefined;
      if (scope) {
        try {
          const abs = resolveWithin(ctx.root, scope);
          void abs;
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }

      try {
        const built = await buildRepoMap(ctx.root, { processes: ctx.processes });
        const map = built.map;
        const byPath = new Map(map.files.map((file) => [file.path, file]));

        // Mode 1 — regex over contents (explicit opt-in, grep semantics).
        if (params.regex === true) {
          const { runProc } = await import("../proc.js");
          const { excludeGlobs } = await import("./safety.js");
          const args = ["--line-number", "--with-filename", "--no-heading", "--color", "never",
            "--max-count", "60", "--context", "2", ...excludeGlobs(), "--", query];
          if (scope) args.push(scope);
          const result = await runProc("rg", args, { cwd: ctx.root, timeoutMs: 30_000 });
          if (result.outcome !== "exit" || (result.code !== 0 && !result.stdout)) {
            return fail(`regex search failed: ${result.spawnError ?? `exit ${result.code ?? "?"}`}`);
          }
          const text = result.stdout.trimEnd() || "no matches";
          const envelope = `<inspect query="${query}" mode="find" match="regex">\n${text}\n</inspect>`;
          const artifact = ctx.state?.putArtifact(envelope);
          const capped = capText(envelope, READ_CAP_BYTES);
          return ok(artifact ? `${capped.text}\n\n[artifact: ${artifact.id}]` : capped.text);
        }

        // Mode 2 — anchored slice or whole file (this is the read path).
        const anchor = parseAnchor(query);
        const queryIsFile = !anchor && isFileOnDisk(ctx.root, query);
        if (anchor || queryIsFile) {
          const rel = anchor ? anchor.path : query;
          let abs: string;
          try {
            abs = resolveWithin(ctx.root, rel);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          if (!existsSync(abs)) return fail(`file not found: ${rel}`);
          if (isBinaryFile(abs)) return fail(`refusing to read binary file: ${rel}`);
          const source = readFileSync(abs, "utf8");
          const file = byPath.get(rel) ?? null;
          if (detail === "outline") {
            const lines: string[] = [`path: ${rel} [match: path]`, `lines: ${source.split("\n").length}`];
            for (const symbol of file?.symbols ?? []) lines.push(`  ${symbol.kind} ${symbol.name} (${symbol.line}-${symbol.end})`);
            if (lines.length === 2) lines.push("(no symbols indexed; use detail=full to read the body)");
            const envelope = `<inspect query="${query}" mode="file" match="path">\n${lines.join("\n")}\n</inspect>`;
            const artifact = ctx.state?.putArtifact(envelope);
            return ok(artifact ? `${envelope}\n\n[artifact: ${artifact.id}]` : envelope);
          }
          let slice: { header: string; text: string; start: number; end: number } | { error: string };
          if (anchor && anchor.start !== undefined && anchor.end !== undefined) {
            const aStart = anchor.start;
            const aEnd = anchor.end;
            const lines = source.split("\n");
            const page = numberLinesCapped(lines, aStart, aEnd - aStart + 1, READ_CAP_BYTES);
            slice = { header: `${aStart}-${aStart + page.delivered - 1} of ${lines.length} lines`, text: page.text, start: aStart, end: aStart + page.delivered - 1 };
          } else {
            slice = fileSlice(source, { symbol: params.symbol, offset: params.offset, limit: params.limit, around: params.around }, file, READ_CAP_BYTES);
          }
          if ("error" in slice) return fail(`${slice.error}. Use detail=outline to list symbols first.`);
          const envelope = `<inspect query="${query}" mode="file" match="path">\n### ${rel}: ${slice.header}\n${slice.text}\n</inspect>`;
          const artifact = ctx.state?.putArtifact(envelope);
          const capped = capText(envelope, READ_CAP_BYTES);
          return ok(artifact ? `${capped.text}\n\n[artifact: ${artifact.id}]` : capped.text);
        }

        // Mode 3 — directory listing.
        if (scope && !queryIsFile) {
          try {
            if (statSync(resolveWithin(ctx.root, scope)).isDirectory() && map.files.every((f) => f.path !== query)) {
              const prefix = scope.endsWith("/") ? scope : `${scope}/`;
              const children = map.files.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/")).sort((a, b) => a.path.localeCompare(b.path));
              const dirs = new Set<string>();
              for (const f of map.files) {
                if (!f.path.startsWith(prefix)) continue;
                const rest = f.path.slice(prefix.length);
                const slash = rest.indexOf("/");
                if (slash >= 0) dirs.add(rest.slice(0, slash));
              }
              const lines = [`directory: ${scope} [match: path]`, `subdirectories: ${[...dirs].sort().join(", ") || "(none)"}`];
              for (const child of children.slice(0, 40)) lines.push(`  ${child.path} (${child.symbols.length} symbols, ${child.lines} lines)`);
              const envelope = `<inspect query="${query}" mode="directory" match="path">\n${lines.join("\n")}\n</inspect>`;
              const artifact = ctx.state?.putArtifact(envelope);
              return ok(artifact ? `${envelope}\n\n[artifact: ${artifact.id}]` : envelope);
            }
          } catch {
            // not a directory — fall through to symbol/find
          }
        }

        // Mode 4 — exact symbol (definition + callers + source).
        const lspResult = await lspSymbolLookup(ctx.root, query.split(".").pop()!, ctx.processes);
        const defFile = map.files.find((f) => f.symbols.some((s) => s.name === query));
        if (lspResult || defFile) {
          const lines: string[] = lspResult ?? [];
          let body = "";
          if (defFile) {
            const abs = join(ctx.root, defFile.path);
            if (existsSync(abs) && !lspResult) {
              const source = readFileSync(abs, "utf8");
              const range = symbolRange(defFile, query);
              if (range) {
                lines.push(`symbol: ${query} [match: symbol]`, `file: ${defFile.path}`, `lines: [${range.start}, ${range.end}]`);
                const sig = source.split("\n")[range.start - 1]?.trim() ?? "";
                if (sig) lines.push(`signature: "${sig.slice(0, 200)}"`);
                if (detail !== "outline") {
                  const raw = source.split("\n").slice(range.start - 1, range.end);
                  const numbered = raw.map((line, i) => `${range.start + i}: ${line}`).join("\n");
                  body = capText(numbered, detail === "full" ? READ_CAP_BYTES : 6 * 1024).text;
                }
              }
            } else if (defFile) {
              lines.push(`definition: ${defFile.path} [match: symbol]`);
            }
            const callers = map.files.filter((entry) => entry.path !== defFile.path && (entry.imports ?? []).includes(defFile.path)).slice(0, 6);
            if (callers.length > 0) {
              lines.push("callers:");
              for (const caller of callers) lines.push(`  ${caller.path}`);
            }
          }
          const envelope = `<inspect query="${query}" mode="symbol" match="symbol">\n${lines.join("\n")}${body ? `\n${body}` : ""}\n</inspect>`;
          const artifact = ctx.state?.putArtifact(envelope);
          const capped = capText(envelope, READ_CAP_BYTES);
          return ok(artifact ? `${capped.text}\n\n[artifact: ${artifact.id}]` : capped.text);
        }

        // Mode 5 — ranked keyword find with dense per-file evidence.
        const files = fuzzyFiles(map, query, scope);
        if (files.length === 0) {
          return ok(
            `<inspect query="${query}" mode="find" match="none">\nno matches for "${query}". Try a shorter keyword, a basename, or regex:true.\n</inspect>`,
          );
        }
        const blocks: string[] = [`<inspect query="${query}" mode="find">`];
        let used = 0;
        for (const entry of files) {
          const file = byPath.get(entry.path);
          const kind = entry.score >= 1_000_000 || entry.reason.endsWith("symbol") ? "symbol"
            : /path match/i.test(entry.reason) ? "path" : "keyword";
          const header = `## ${entry.path} — ${entry.reason} [match: ${kind}]`;
          const evidence: string[] = [];
          for (const symbol of file?.symbols.slice(0, 8) ?? []) {
            const via = entry.symbolVia[symbol.name] ?? [];
            if (via.length > 0) evidence.push(`"${via.join('", "')}" → ${symbol.kind} ${symbol.name} (${symbol.line}-${symbol.end})`);
          }
          const parts: string[] = [header];
          if (evidence.length > 0 && detail !== "outline") parts.push(`  ${evidence.slice(0, 4).join("; ")}`);
          if (detail !== "outline" && file) {
            try {
              const source = readFileSync(join(ctx.root, entry.path), "utf8");
              const bodies: string[] = [];
              for (const name of Object.keys(entry.symbolVia).slice(0, 3)) {
                const range = symbolRange(file, name);
                if (!range || range.end - range.start + 1 > BODY_LINE_CAP) continue;
                const text = source.split("\n").slice(range.start - 1, range.end).map((line, i) => `${range.start + i}: ${line}`).join("\n");
                const cost = Buffer.byteLength(text, "utf8");
                if (used + cost > FIND_BYTES_CAP) break;
                used += cost;
                bodies.push(text);
              }
              if (bodies.length > 0) parts.push(...bodies);
              else if (detail === "summary") {
                const head = source.split("\n").slice(0, 15).map((line, i) => `${i + 1}: ${line}`).join("\n");
                parts.push(head, `… [${source.split("\n").length - 15} more lines; detail=full or query "${entry.path}:START-END"]`);
              }
            } catch {
              // unreadable — header still stands
            }
          }
          if (file && (file.imports?.length || map.files.some((f) => (f.imports ?? []).includes(entry.path)))) {
            const importedBy = map.files.filter((f) => (f.imports ?? []).includes(entry.path)).slice(0, 4).map((f) => f.path);
            const relations = [
              ...(file.imports?.length ? [`imports: ${file.imports.slice(0, 4).join(", ")}`] : []),
              ...(importedBy.length ? [`imported by: ${importedBy.join(", ")}`] : []),
            ].join(" · ");
            if (relations) parts.push(`  ${relations}`);
          }
          const rest = (file?.symbols ?? []).filter((s) => !(s.name in entry.symbolVia)).slice(0, 6);
          if (rest.length > 0 && detail === "full") parts.push(`  also: ${rest.map((s) => `${s.kind} ${s.name} (${s.line}-${s.end})`).join(", ")}`);
          parts.push("");
          const block = parts.join("\n");
          if (used + block.length > FIND_BYTES_CAP + 4 * 1024) break;
          used += block.length;
          blocks.push(block);
        }
        blocks.push("</inspect>");
        const envelope = blocks.join("\n");
        const artifact = ctx.state?.putArtifact(envelope);
        const capped = capText(envelope, READ_CAP_BYTES);
        return ok(artifact ? `${capped.text}\n\n[artifact: ${artifact.id}]` : capped.text);
      } catch (error) {
        return fail(`inspect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
