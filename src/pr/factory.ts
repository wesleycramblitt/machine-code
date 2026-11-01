/**
 * machine_code — PR provider factory.
 */
import type { Layout } from "../paths.js";
import { repoFromGit } from "../issues/github.js";
import { GitHubPrProvider } from "./github.js";
import { NullPrProvider } from "./null.js";
import type { PullRequestProvider } from "./provider.js";

export interface PrProviderBundle {
  provider: PullRequestProvider;
  repo?: string;
  reason?: string;
}

export async function createPrProviderFor(layout: Layout, repoRoot = layout.repoRoot): Promise<PrProviderBundle> {
  const repo = await repoFromGit(repoRoot);
  if (!repo) return { provider: new NullPrProvider("no GitHub origin remote"), reason: "no GitHub origin remote" };
  const github = new GitHubPrProvider(repo, repoRoot);
  if (!(await github.available())) {
    return { provider: new NullPrProvider("gh is missing or not authenticated"), reason: "gh is missing or not authenticated" };
  }
  return { provider: github, repo };
}
