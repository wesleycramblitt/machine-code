/**
 * machine_code — repository map command handlers.
 *
 * `core:map` exposes the deterministic map to agents. `core:status` keeps git
 * status first and appends map/LSP health so the model can see what is fresh.
 */
import { buildRepoMap, mapBytes, renderRepoMap, symbolCount } from "../map/deterministic.js";
import { isSemanticFresh, loadSemantic, readSemanticDirty, renderSemanticIndex } from "../map/semantic.js";
import { serverAvailable } from "../lsp/index.js";
import { runProc } from "../proc.js";
import type { CommandRunResult } from "./registry.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runMapCommand(
  args: Record<string, unknown>,
  root: string,
): Promise<CommandRunResult> {
  const action = str(args.action) ?? "render";
  const refresh = args.refresh === true || action === "refresh";
  const path = str(args.path);
  const symbols = args.symbols !== false;
  try {
    const built = await buildRepoMap(root, { refresh });
    const semantic = loadSemantic(root);
    const semanticDirty = readSemanticDirty(root);
    const semanticFresh = isSemanticFresh(semantic, built.map, semanticDirty);
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
          `semantic: ${semantic ? (semanticFresh ? "fresh" : "stale") : "missing"} · ` +
            `${Object.keys(semantic?.modules ?? {}).length} modules` +
            `${semanticDirty.length ? ` · ${semanticDirty.length} dirty` : ""}`,
          `lsp typescript: ${serverAvailable("typescript") ? "ready" : "missing"}`,
        ].join("\n"),
        isError: false,
      };
    }
    if (args.json === true) {
      return { text: JSON.stringify({ map: built.map, semantic }, null, 2), isError: false };
    }
    const deterministic = renderRepoMap(built.map, { path, symbols }) || "no files";
    const semanticText = args.semantic === true ? renderSemanticIndex(semantic) : "";
    return {
      text: [deterministic, semanticText].filter(Boolean).join("\n\n"),
      isError: false,
    };
  } catch (error) {
    return { text: `map failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export async function runStatusCommand(root: string): Promise<CommandRunResult> {
  const git = await runProc("git", ["status", "--short", "--branch"], {
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
    const semantic = loadSemantic(root);
    const dirty = readSemanticDirty(root);
    const semanticFresh = isSemanticFresh(semantic, built.map, dirty);
    const semanticLine =
      `semantic ${semantic ? (semanticFresh ? "fresh" : "stale") : "missing"} · ` +
      `${Object.keys(semantic?.modules ?? {}).length} modules` +
      `${dirty.length ? ` · ${dirty.length} dirty` : ""}`;
    const lspLine = `lsp typescript: ${serverAvailable("typescript") ? "ready" : "missing"}`;
    return {
      text: [gitText, "", mapLine, semanticLine, lspLine].filter(Boolean).join("\n"),
      isError: git.outcome !== "exit" || git.code !== 0,
    };
  } catch (error) {
    return {
      text: `${gitText}\n\nmap unavailable: ${error instanceof Error ? error.message : String(error)}`,
      isError: git.outcome !== "exit" || git.code !== 0,
    };
  }
}
