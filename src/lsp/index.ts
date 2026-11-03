/**
 * machine_code — LSP server pool.
 *
 * One client per (root, language). Lazy startup, bounded by timeout. The
 * registry in servers.ts decides which binary and languageId a path uses.
 * Every lookup falls back to the deterministic map or rg when a server is
 * missing or over budget.
 */
import { spawnSync } from "node:child_process";
import { findOnPath } from "../install.js";
import { LspClient } from "./client.js";
import {
  allServers,
  argsFor,
  languageForPath,
  languageIdForPath,
  serverForLanguage,
  serverForPath,
  type LspServerSpec,
} from "./servers.js";

export {
  allServers,
  languageForPath,
  languageIdForPath,
  serverForLanguage,
  serverForPath,
  type LspServerSpec,
};

const pool = new Map<string, LspClient>();

export function lspClientFor(
  root: string,
  language: string,
  processes?: import("../processes/supervisor.js").ProcessSupervisor,
): LspClient | null {
  const spec = serverForLanguage(language);
  if (!spec) return null;
  const key = `${spec.id}:${root}`;
  let client = pool.get(key);
  if (!client) {
    client = new LspClient({
      binary: spec.binary,
      args: argsFor(spec, root),
      root,
      languageId: spec.languageIds["*"] ?? "plaintext",
      languageIdForPath,
      initializationOptions: spec.initializationOptions,
      processes,
    });
    pool.set(key, client);
  }
  return client;
}

export async function shutdownAll(): Promise<void> {
  for (const client of pool.values()) await client.shutdown();
  pool.clear();
}

// Detached servers would otherwise outlive a normal CLI exit. The exit event
// cannot await, so kill synchronously; explicit shutdown still uses shutdown().
process.on("exit", () => {
  for (const client of pool.values()) client.kill();
  pool.clear();
});

const availability = new Map<string, boolean>();

/** Whether the language's server binary is on PATH and actually runs. */
export function serverAvailable(language: string): boolean {
  const spec = serverForLanguage(language);
  if (!spec) return false;
  const cached = availability.get(spec.id);
  if (cached !== undefined) return cached;
  const binary = findOnPath(spec.binaries ?? [spec.binary]);
  if (!binary) {
    availability.set(spec.id, false);
    return false;
  }
  const args = spec.versionArgs ?? ["--version"];
  let ok = true;
  if (args.length > 0) {
    const probe = spawnSync(binary, args, { timeout: 2_000, stdio: "ignore" });
    // A timeout usually means the binary is a server waiting on stdio, not a
    // broken shim. A clean exit 0 is ready; an error/exit 1 is not.
    ok = probe.error
      ? (probe.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      : probe.status === 0;
  }
  availability.set(spec.id, ok);
  return ok;
}

/** The binary that satisfies a spec, or null. */
export function serverBinary(language: string): string | null {
  const spec = serverForLanguage(language);
  if (!spec) return null;
  return findOnPath(spec.binaries ?? [spec.binary]);
}

const SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

/** Format LSP workspace symbols as `path:line:col kind name (container)`. */
export function formatSymbols(symbols: readonly unknown[]): string[] {
  return symbols.map((value) => {
    const symbol = value as {
      name?: string;
      kind?: number;
      containerName?: string;
      location?: { uri?: string; range?: { start?: { line?: number; character?: number } } };
    };
    const location = symbol.location ?? {};
    const path = (location.uri ?? "").replace(/^file:\/\//, "");
    const start = location.range?.start;
    const pos = start?.line !== undefined
      ? `:${start.line + 1}:${(start.character ?? 0) + 1}`
      : "";
    const kind = SYMBOL_KINDS[symbol.kind ?? 0] ?? "symbol";
    const container = symbol.containerName ? ` (${symbol.containerName})` : "";
    return `${path}${pos} ${kind} ${symbol.name ?? "(anonymous)"}${container}`;
  });
}

/** Declarations worth showing in an outline; skip local variables/callbacks. */
const DOCUMENT_SYMBOL_KINDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19, 22, 23, 24, 25, 26,
]);

/** Only these containers expose useful children in an outline. */
const CONTAINER_SYMBOL_KINDS = new Set([1, 2, 3, 4, 5, 10, 11, 19, 23]);

/** Format document symbols as `path:line:col kind name`, nested by children. */
export function formatDocumentSymbols(symbols: readonly unknown[], path: string): string[] {
  const out: string[] = [];
  const lineOf = (value: unknown): number => {
    const item = value as {
      range?: { start?: { line?: number } };
      selectionRange?: { start?: { line?: number } };
      location?: { range?: { start?: { line?: number } } };
    };
    return (item.selectionRange ?? item.range ?? item.location?.range)?.start?.line ?? 0;
  };
  const walk = (items: readonly unknown[], depth: number): void => {
    for (const value of [...items].sort((a, b) => lineOf(a) - lineOf(b))) {
      const item = value as {
        name?: string;
        kind?: number;
        range?: { start?: { line?: number; character?: number } };
        selectionRange?: { start?: { line?: number; character?: number } };
        location?: { range?: { start?: { line?: number; character?: number } } };
        children?: unknown[];
      };
      const kindId = item.kind ?? 0;
      if (DOCUMENT_SYMBOL_KINDS.has(kindId)) {
        const start = (item.selectionRange ?? item.range ?? item.location?.range)?.start;
        const pos = start?.line !== undefined
          ? `:${start.line + 1}:${(start.character ?? 0) + 1}`
          : "";
        const kind = SYMBOL_KINDS[kindId] ?? "symbol";
        const indent = depth > 0 ? "  ".repeat(depth) : "";
        out.push(`${path}${pos} ${kind} ${indent}${item.name ?? "(anonymous)"}`);
      }
      // Do not descend into functions/methods: their children are locals and
      // callbacks, not outline entries.
      if (item.children && item.children.length > 0 && CONTAINER_SYMBOL_KINDS.has(kindId)) {
        walk(item.children, depth + 1);
      }
    }
  };
  walk(symbols, 0);
  return out;
}

export interface LspStatusEntry {
  language: string;
  name: string;
  available: boolean;
  binary: string | null;
  install: string;
}

/** Status for every server that matches at least one path. */
export function lspStatusForPaths(paths: readonly string[]): LspStatusEntry[] {
  const specs = new Map<string, LspServerSpec>();
  for (const path of paths) {
    const spec = serverForPath(path);
    if (spec) specs.set(spec.id, spec);
  }
  return [...specs.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((spec) => ({
      language: spec.id,
      name: spec.name,
      available: serverAvailable(spec.id),
      binary: serverBinary(spec.id),
      install: spec.install,
    }));
}

export function formatLspStatus(entries: readonly LspStatusEntry[]): string {
  if (entries.length === 0) return "lsp: no matching language servers";
  return `lsp: ${entries
    .map((entry) => `${entry.language} ${entry.available ? "ready" : "missing"}`)
    .join(" · ")}`;
}

/** Human-readable registry listing used by `machine_code lsp list`. */
export function formatServerList(): string {
  return allServers()
    .map((spec) => {
      const available = serverAvailable(spec.id);
      const files = [...(spec.filenames ?? []), ...spec.extensions].join(",");
      return [
        spec.id.padEnd(12),
        spec.name.padEnd(24),
        files.padEnd(34),
        available ? "ready" : "missing",
        available ? "" : spec.install,
      ].join("  ").trimEnd();
    })
    .join("\n");
}
