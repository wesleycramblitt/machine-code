/**
 * machine_code — issue provider factory.
 *
 * Chooses GitHub when tracking is enabled, a GitHub remote exists, and gh is
 * authenticated; otherwise returns the null provider plus the reason. The
 * harness uses the reason for warnings and for required-policy failures.
 */
import type { Layout } from "../paths.js";
import type { MachineConfig } from "../config.js";
import { GitHubIssueProvider, repoFromGit } from "./github.js";
import { NullIssueProvider } from "./null.js";
import type { IssueProvider } from "./provider.js";

export interface IssueProviderBundle {
  provider: IssueProvider;
  /** owner/repo when a GitHub remote was resolved. */
  repo?: string;
  /** Why the null provider was chosen, if it was. */
  reason?: string;
}

export async function createIssueProvider(layout: Layout, machine: MachineConfig): Promise<IssueProviderBundle> {
  const policy = machine.issues.policy;
  if (machine.issues.provider === "none") {
    return { provider: new NullIssueProvider("issues.provider = none"), reason: "issues.provider = none" };
  }
  if (policy === "disabled") {
    return { provider: new NullIssueProvider("issue policy disabled"), reason: "issue policy disabled" };
  }
  const repo = await repoFromGit(layout.repoRoot);
  if (!repo) {
    return { provider: new NullIssueProvider("no GitHub origin remote"), reason: "no GitHub origin remote" };
  }
  const github = new GitHubIssueProvider({ repo, repoRoot: layout.repoRoot });
  if (!(await github.available())) {
    return { provider: new NullIssueProvider("gh is missing or not authenticated"), reason: "gh is missing or not authenticated" };
  }
  return { provider: github, repo };
}

export { GitHubIssueProvider } from "./github.js";
export { NullIssueProvider } from "./null.js";
export * from "./provider.js";
