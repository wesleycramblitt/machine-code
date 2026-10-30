/**
 * machine_code — layout paths.
 *
 * Machine state: ~/.machine_code/ (MACHINE_CODE_HOME overrides).
 * Repo policy: .machine_code/ (committed). Generated/local: .machine_code/local/ (gitignored).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface Layout {
  /** Machine-wide home. */
  home: string;
  /** Machine config.toml. */
  machineConfig: string;
  /** Machine curation.toml. */
  curation: string;
  /** Generated catalogue. */
  catalogueFile: string;
  /** Repo root (absolute). */
  repoRoot: string;
  /** Committed repo state dir. */
  repoDir: string;
  /** Gitignored local state dir. */
  localDir: string;
  /** Repo policy.toml. */
  policyFile: string;
  /** Per-run directories. */
  runsDir: string;
}

export function layout(repoRoot: string = process.cwd()): Layout {
  const home = process.env.MACHINE_CODE_HOME ?? join(homedir(), ".machine_code");
  const repoDir = join(repoRoot, ".machine_code");
  const localDir = join(repoDir, "local");
  return {
    home,
    machineConfig: join(home, "config.toml"),
    curation: join(home, "curation.toml"),
    catalogueFile: join(home, "catalogue", "models.json"),
    repoRoot,
    repoDir,
    localDir,
    policyFile: join(repoDir, "policy.toml"),
    runsDir: join(localDir, "runs"),
  };
}
