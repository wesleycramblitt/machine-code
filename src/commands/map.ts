/**
 * machine_code — repository map command handlers.
 *
 * `core:map` exposes the deterministic map to agents. `core:status` keeps git
 * status first and appends map/LSP health so the model can see what is fresh.
 */
import { buildRepoMap, mapBytes, renderRepoMap, symbolCount } from "../map/deterministic.js";
import { buildModuleIndex, renderModuleIndex } from "../map/modules.js";
import { formatLspStatus, lspStatusForPaths } from "../lsp/index.js";
import { runProc } from "../proc.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import type { CommandRunResult } from "./registry.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    const built = await buildRepoMap(root, { refresh, processes });
    const modules = buildModuleIndex(built.map);
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
          `modules: ${Object.keys(modules.modules).length}`,
          formatLspStatus(lspStatusForPaths(built.map.files.map((file) => file.path))),
        ].join("\n"),
        isError: false,
      };
    }
    if (args.json === true) {
      return { text: JSON.stringify({ map: built.map, modules }, null, 2), isError: false };
    }
    const deterministicText = renderRepoMap(built.map, { path, symbols }) || "no files";
    const moduleText = args.semantic === true ? renderModuleIndex(modules, 16 * 1024, path ?? "") : "";
    return {
      text: [deterministicText, moduleText].filter(Boolean).join("\n\n"),
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
    const built = await buildRepoMap(root, { processes });
    const mapLine =
      `map ${built.cached ? "fresh" : "rebuilt"} · ${built.map.files.length} files · ` +
      `${symbolCount(built.map)} symbols · ${mapBytes(built.map)} bytes`;
    const modules = buildModuleIndex(built.map);
    const moduleLine = `modules: ${Object.keys(modules.modules).length}`;
    const lspLine = formatLspStatus(lspStatusForPaths(built.map.files.map((file) => file.path)));
    return {
      text: [gitText, "", mapLine, moduleLine, lspLine].filter(Boolean).join("\n"),
      isError: git.outcome !== "exit" || git.code !== 0,
    };
  } catch (error) {
    return {
      text: `${gitText}\n\nmap unavailable: ${error instanceof Error ? error.message : String(error)}`,
      isError: git.outcome !== "exit" || git.code !== 0,
    };
  }
}
