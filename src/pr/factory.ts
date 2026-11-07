/**
 * machine_code — PR provider factory.
 */
import type { Layout } from "../paths.js";
import { runProc } from "../proc.js";
import { GitHubPrProvider } from "./github.js";
import { NullPrProvider } from "./null.js";
import type { PullRequestProvider } from "./provider.js";

export async function repoFromGit(repoRoot: string): Promise<string | null> {
  const result = await runProc("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.code !== 0) return null;
  const url = result.stdout.trim();
  const https = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const m = https ?? ssh;
  return m ? `${m[1]}/${m[2]}` : null;
}

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
