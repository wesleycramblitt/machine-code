/**
 * Load local .env files without overriding variables already exported by the
 * shell. Node 22 provides this natively and keeps provider keys out of command
 * lines and child-process environments unless the caller passes them.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function loadEnvFiles(start: string = process.cwd()): string[] {
  const loaded: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];

  // Walk from the working directory to the filesystem root, then check the
  // machine home (or its override).
  let dir = resolve(start);
  while (true) {
    candidates.push(join(dir, ".env"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = process.env.MACHINE_CODE_HOME ?? join(homedir(), ".machine_code");
  candidates.push(join(home, ".env"));

  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      loaded.push(file);
    } catch {
      // A malformed .env should not prevent the CLI from starting. Providers
      // remain unconfigured and the normal status output explains what is set.
    }
  }
  return loaded;
}
