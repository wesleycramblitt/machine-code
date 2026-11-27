/**
 * machine_code — repository map command handlers.
 *
 * `core:map` exposes the deterministic map to agents. `core:status` keeps git
 * status first and appends map/LSP health so the model can see what is fresh.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepoMap, mapBytes, renderRepoMap, symbolCount, type RepoMap } from "../map/deterministic.js";
import { formatLspStatus, lspStatusForPaths } from "../lsp/index.js";
import { runProc } from "../proc.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import type { CommandRunResult } from "./registry.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}


/* ------------------------------------------------------------ graph queries */

/** Direct importers of a path: the reverse of the map's resolved import edges. */
function dependentsOf(map: RepoMap, path: string): { direct: string[]; transitive: string[] } {
  const direct = map.files
    .filter((file) => file.path !== path && (file.imports ?? []).includes(path))
    .map((file) => file.path)
    .sort();
  // One more hop: files that import the importers. Enough to see blast radius
  // without pretending to be a real call graph.
  const seen = new Set<string>([path, ...direct]);
  const transitive: string[] = [];
  for (const file of map.files) {
    if (seen.has(file.path)) continue;
    if ((file.imports ?? []).some((imported) => direct.includes(imported))) {
      transitive.push(file.path);
      seen.add(file.path);
    }
  }
  return { direct, transitive: transitive.sort() };
}

const REF_CAP = 40;

/** Word-boundary references to a symbol. rg when available, bounded scan otherwise. */
function referencesTo(root: string, query: string, files: readonly string[]): { lines: string[]; note: string } {
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const run = spawnSync("rg", ["-n", "--no-heading", "--color", "never", "-w", "-F", "--", query, "."], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.status === 0 || run.status === 1) {
      const lines = (run.stdout ?? "").trim().split("\n").filter(Boolean);
      return {
        lines: lines.slice(0, REF_CAP).map((line) => line.replace(/^\.\//, "")),
        note: lines.length > REF_CAP ? `${lines.length - REF_CAP} more (narrow with path:)` : "",
      };
    }
  } catch {
    // fall through to the bounded scan
  }
  const word = new RegExp(`\\b${pattern}\\b`);
  const lines: string[] = [];
  let bytes = 0;
  for (const rel of files) {
    if (lines.length >= REF_CAP || bytes > 32 * 1024 * 1024) break;
    try {
      const text = readFileSync(join(root, rel), "utf8");
      bytes += text.length;
      text.split("\n").forEach((line, index) => {
        if (lines.length < REF_CAP && word.test(line)) lines.push(`${rel}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
    } catch {
      // unreadable — skip
    }
  }
  return { lines, note: "" };
}


/** Resolve a caller-supplied path against the map: exact, then unique suffix. */
function resolveMapPath(map: RepoMap, value: string): { path: string } | { error: string } {
  const clean = value.replace(/^\.\//, "").replace(/^\//, "");
  if (map.files.some((file) => file.path === clean)) return { path: clean };
  const matches = map.files.filter((file) => file.path.endsWith(`/${clean}`) || file.path.endsWith(clean));
  if (matches.length === 1) return { path: matches[0]!.path };
  if (matches.length > 1) {
    return { error: `ambiguous path ${value}: ${matches.slice(0, 5).map((m) => m.path).join(", ")}${matches.length > 5 ? ", …" : ""}` };
  }
  return { error: `not in the map: ${value} (core:map status lists the root; paths are repo-relative)` };
}

function mapGraph(
  root: string,
  map: RepoMap,
  action: string,
  path: string | undefined,
  query: string | undefined,
  json: boolean,
): CommandRunResult {
  if (action === "refs") {
    if (!query) return { text: "core:map refs requires query (a symbol or identifier)", isError: true };
    const { lines, note } = referencesTo(root, query, map.files.map((file) => file.path));
    const text = lines.length > 0
      ? `refs to ${query} (${lines.length}${note ? `, ${note}` : ""}):\n${lines.join("\n")}`
      : `no references to ${query} in ${map.files.length} mapped files`;
    return { text: json ? JSON.stringify({ query, refs: lines }, null, 2) : text, isError: false };
  }
  if (!path) return { text: `core:map ${action} requires path (repo-relative file)`, isError: true };
  const resolved = resolveMapPath(map, path);
  if ("error" in resolved) return { text: resolved.error, isError: true };
  const target = resolved.path;
  const file = map.files.find((entry) => entry.path === target);
  if (action === "imports") {
    const imports = file?.imports ?? [];
    if (json) return { text: JSON.stringify({ path: target, imports }, null, 2), isError: false };
    return {
      text: imports.length > 0
        ? `imports of ${target} (${imports.length}):\n${imports.map((entry) => `  ${entry}`).join("\n")}`
        : `${target} has no resolved local imports`,
      isError: false,
    };
  }
  // dependents
  const { direct, transitive } = dependentsOf(map, target);
  if (json) return { text: JSON.stringify({ path: target, direct, transitive }, null, 2), isError: false };
  const head = direct.length > 0
    ? `dependents of ${target} (direct ${direct.length}):\n${direct.map((entry) => `  ${entry}`).join("\n")}`
    : `nothing imports ${target}`;
  const tail = transitive.length > 0 ? `\ntransitive (one more hop): ${transitive.length} more\n${transitive.slice(0, 20).map((entry) => `  ${entry}`).join("\n")}` : "";
  return { text: `${head}${tail}`, isError: false };
}

export async function runMapCommand(
  args: Record<string, unknown>,
  root: string,
  processes?: ProcessSupervisor,
): Promise<CommandRunResult> {
  const action = str(args.action) ?? "render";
  const refresh = args.refresh === true || action === "refresh";
  const path = str(args.path);
  const symbols = args.symbols !== false;
  try {
    const built = await buildRepoMap(root, { refresh });
    if (action === "status") {
      return {
        text: [
          `map root: ${built.map.root}`,
          `head: ${built.map.head || "(no git)"}`,
          `files: ${built.map.files.length}`,
          `symbols: ${symbolCount(built.map)}`,
          `bytes: ${mapBytes(built.map)}`,
          `cache: ${built.cachePath}`,
          `cache: ${built.cached ? "fresh" : "rebuilt"}`,
          formatLspStatus(lspStatusForPaths(built.map.files.map((file) => file.path))),
        ].join("\n"),
        isError: false,
      };
    }
    if (action === "imports" || action === "dependents" || action === "refs") {
      return mapGraph(root, built.map, action, path, str(args.query), args.json === true);
    }
    if (args.json === true) {
      return { text: JSON.stringify({ map: built.map }, null, 2), isError: false };
    }
    const deterministicText = renderRepoMap(built.map, { path, symbols }) || "no files";
    return {
      text: deterministicText,
      isError: false,
    };
  } catch (error) {
    return { text: `map failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export async function runStatusCommand(root: string, processes?: ProcessSupervisor): Promise<CommandRunResult> {
  const git = processes
    ? (
        await processes.run("git", ["status", "--short", "--branch"], {
          cwd: root,
          timeoutMs: 15_000,
          origin: "tool",
          name: "map:git-status",
        })
      ).result
    : await runProc("git", ["status", "--short", "--branch"], {
        cwd: root,
        timeoutMs: 15_000,
      });
  const gitText =
    git.outcome === "exit" && git.code === 0
      ? git.stdout.trimEnd()
      : `git status unavailable: ${git.spawnError ?? `exit ${git.code ?? "?"}`}`;
  try {
    const built = await buildRepoMap(root);
    const mapLine =
      `map ${built.cached ? "fresh" : "rebuilt"} · ${built.map.files.length} files · ` +
      `${symbolCount(built.map)} symbols · ${mapBytes(built.map)} bytes`;
    const lspLine = formatLspStatus(lspStatusForPaths(built.map.files.map((file) => file.path)));
    return {
      text: [gitText, "", mapLine, lspLine].filter(Boolean).join("\n"),
      isError: git.outcome !== "exit" || git.code !== 0,
    };
  } catch (error) {
    return {
      text: `${gitText}\n\nmap unavailable: ${error instanceof Error ? error.message : String(error)}`,
      isError: git.outcome !== "exit" || git.code !== 0,
    };
  }
}
