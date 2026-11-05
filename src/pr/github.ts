/**
 * machine_code — GitHub pull-request provider (gh CLI).
 *
 * Same discipline as the issue provider: structured JSON reads, argument-vector
 * writes through runProc, allowlisted environment. Merge strategy defaults to
 * squash; approval policy is enforced one layer up.
 */
import { runProc } from "../proc.js";
import { PrError, type NewPullRequest, type PullRequest, type PullRequestProvider } from "./provider.js";

const PR_FIELDS = "number,url,state,isDraft,mergeable,headRefName,baseRefName,title,createdAt,mergedAt";

const ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "NO_COLOR",
];

function ghEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface GhPr {
  number?: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  headRefName?: string;
  baseRefName?: string;
  title?: string;
  createdAt?: string;
  mergedAt?: string;
}

export class GitHubPrProvider implements PullRequestProvider {
  readonly kind = "github";
  constructor(
    private readonly repo: string,
    private readonly repoRoot: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async gh(args: string[], timeoutMs = this.timeoutMs): Promise<string> {
    const result = await runProc("gh", args, { cwd: this.repoRoot, timeoutMs, env: ghEnv() });
    if (result.outcome === "spawn-error") throw new PrError("gh_missing", result.spawnError ?? "gh is not installed");
    if (result.outcome === "timeout") throw new PrError("gh_timeout", `gh ${args[0] ?? ""} timed out`);
    if (result.code !== 0) {
      throw new PrError("gh_failed", `gh ${args[0] ?? ""} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return result.stdout;
  }

  async available(): Promise<boolean> {
    try {
      await this.gh(["auth", "status"], 15_000);
      return true;
    } catch {
      return false;
    }
  }

  private toPr(j: GhPr): PullRequest {
    const state = j.state === "MERGED" || j.mergedAt ? "merged" : j.state === "CLOSED" ? "closed" : "open";
    return {
      number: j.number ?? 0,
      url: j.url ?? "",
      state,
      isDraft: Boolean(j.isDraft),
      mergeable: j.mergeable === "MERGEABLE" ? true : j.mergeable === "CONFLICTING" ? false : undefined,
      head: j.headRefName ?? "",
      base: j.baseRefName ?? "",
      title: j.title ?? "",
      createdAt: j.createdAt,
      mergedAt: j.mergedAt,
    };
  }

  async create(input: NewPullRequest): Promise<PullRequest> {
    const args = [
      "pr",
      "create",
      "--repo",
      this.repo,
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) args.push("--draft");
    const out = await this.gh(args, 90_000);
    const m = out.match(/\/pull\/(\d+)\s*$/m);
    if (!m) throw new PrError("gh_bad_output", `could not parse created PR from: ${out.trim()}`);
    const pr = await this.status(Number(m[1]));
    if (!pr) throw new PrError("gh_bad_output", "created PR could not be read back");
    return pr;
  }

  async status(number: number): Promise<PullRequest | null> {
    try {
      const out = await this.gh(["pr", "view", String(number), "--repo", this.repo, "--json", PR_FIELDS]);
      return this.toPr(JSON.parse(out) as GhPr);
    } catch (error) {
      if (error instanceof PrError && error.code === "gh_failed" && /not found|Could not resolve/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async merge(number: number, method: "squash" | "merge" | "rebase" = "squash"): Promise<void> {
    await this.gh(["pr", "merge", String(number), "--repo", this.repo, `--${method}`], 120_000);
  }

  async close(number: number): Promise<void> {
    await this.gh(["pr", "close", String(number), "--repo", this.repo], 60_000);
  }

  async list(filter: { head?: string; base?: string; state?: "open" | "closed" | "all" } = {}): Promise<PullRequest[]> {
    const args = ["pr", "list", "--repo", this.repo, "--state", filter.state ?? "all", "--json", PR_FIELDS];
    if (filter.head) args.push("--head", filter.head);
    if (filter.base) args.push("--base", filter.base);
    const out = await this.gh(args);
    return (JSON.parse(out) as GhPr[]).map((j) => this.toPr(j));
  }
}
