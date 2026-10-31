/**
 * machine_code — LSP server pool.
 *
 * One client per (root, language). Lazy startup, bounded by timeout. Falls
 * back to ast-grep/rg when the server is missing or over budget.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LspClient } from "./client.js";

const SERVERS: Record<string, { binary: string; args: string[] }> = {
  typescript: { binary: "typescript-language-server", args: ["--stdio"] },
};

const pool = new Map<string, LspClient>();

export function lspClientFor(root: string, language: string): LspClient | null {
  const spec = SERVERS[language];
  if (!spec) return null;
  const key = `${language}:${root}`;
  let client = pool.get(key);
  if (!client) {
    client = new LspClient({ binary: spec.binary, args: spec.args, root });
    pool.set(key, client);
  }
  return client;
}

export async function shutdownAll(): Promise<void> {
  for (const client of pool.values()) await client.shutdown();
  pool.clear();
}

/** Whether the language's server binary is on PATH. */
export function serverAvailable(language: string): boolean {
  const spec = SERVERS[language];
  if (!spec) return false;
  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, spec.binary))) return true;
  }
  return false;
}
