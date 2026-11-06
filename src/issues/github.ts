/**
 * machine_code — GitHub issue provider (gh CLI).
 *
 * Structured JSON only: every read uses `gh issue ... --json`, every write uses
 * an argument vector through runProc (never a shell). The environment is
 * allowlisted so gh can authenticate but provider API keys never leak into
 * subprocesses.
 *
 * Hierarchy uses native parent/sub-issue relationships when GitHub reports
 * them; issue types are used when the repository has them configured, with
 * `mc:epic|feature` labels as the fallback.
 */
import { runProc } from "../proc.js";
import {
  IssueError,
  parseAcceptance,
  parseApprovalMarker,
  type Issue,
  type IssueKind,
  type IssueListFilter,
  type IssuePatch,
  type IssueProvider,
  type IssueRef,
  type NewIssue,
} from "./provider.js";
import { parsePlanMarker } from "../plan/schema.js";

const ISSUE_FIELDS = [
  "number",
  "title",
  "state",
  "body",
  "labels",
  "issueType",
  "parent",
  "subIssues",
  "blockedBy",
  "blocking",
  "url",
  "createdAt",
  "updatedAt",
].join(",");

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

/** owner/name from the repo's origin remote (https or ssh). */
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

type GhRelation = Array<{ number?: number }> | { nodes?: Array<{ number?: number }> } | null;

export function relationItems(value: GhRelation | undefined): Array<{ number?: number }> {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.nodes) ? value.nodes : [];
}

interface GhJsonIssue {
  number?: number;
  title?: string;
  state?: string;
  body?: string;
  labels?: Array<{ name?: string } | string>;
  issueType?: { name?: string } | null;
  parent?: { number?: number } | null;
  subIssues?: GhRelation;
  blockedBy?: GhRelation;
  blocking?: GhRelation;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubProviderOptions {
  repo: string;
  repoRoot: string;
  timeoutMs?: number;
}

export class GitHubIssueProvider implements IssueProvider {
  readonly kind = "github";
  private readonly repo: string;
  private readonly repoRoot: string;
  private readonly timeoutMs: number;
  private issueTypes: { epic?: string; feature?: string } | null | undefined;
  /** Labels already created or confirmed in this process. */
  private readonly ensuredLabels = new Set<string>();

  constructor(options: GitHubProviderOptions) {
    this.repo = options.repo;
    this.repoRoot = options.repoRoot;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async gh(args: string[], timeoutMs = this.timeoutMs) {
    const result = await runProc("gh", args, {
      cwd: this.repoRoot,
      timeoutMs,
      env: ghEnv(),
    });
    if (result.outcome === "spawn-error") {
      throw new IssueError("gh_missing", result.spawnError ?? "gh is not installed");
    }
    if (result.outcome === "timeout") {
      throw new IssueError("gh_timeout", `gh ${args[0] ?? ""} timed out after ${timeoutMs}ms`);
    }
    if (result.code !== 0) {
      throw new IssueError("gh_failed", `gh ${args[0] ?? ""} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return result.stdout;
  }

  /** Create missing labels before an issue write; gh refuses unknown labels. */
  private async ensureLabels(labels: Iterable<string>): Promise<void> {
    for (const label of labels) {
      if (!label || this.ensuredLabels.has(label)) continue;
      try {
        await this.gh(
          [
            "label",
            "create",
            label,
            "--repo",
            this.repo,
            "--force",
            "--color",
            "ededed",
            "--description",
            "machine_code managed",
          ],
          20_000,
        );
        this.ensuredLabels.add(label);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new IssueError("label_failed", `could not ensure label ${label}: ${message}`);
      }
    }
  }

  async available(): Promise<boolean> {
    try {
      // A cheap authenticated call; avoids trusting an unauthenticated gh.
      await this.gh(["auth", "status"], 15_000);
      return true;
    } catch {
      return false;
    }
  }

  private ref(number: number): IssueRef {
    return { provider: this.kind, repo: this.repo, number };
  }

  private async detectIssueTypes(): Promise<{ epic?: string; feature?: string } | null> {
    if (this.issueTypes !== undefined) return this.issueTypes;
    try {
      const [owner, name] = this.repo.split("/");
      const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issueTypes(first:50){nodes{name}}}}`;
      const out = await this.gh(
        ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`],
        20_000,
      );
      const parsed = JSON.parse(out) as {
        data?: { repository?: { issueTypes?: { nodes?: Array<{ name?: string }> } | null } };
      };
      const nodes = parsed.data?.repository?.issueTypes?.nodes;
      if (!nodes || nodes.length === 0) {
        this.issueTypes = null;
        return null;
      }
      const names = nodes.map((n) => n.name ?? "").filter(Boolean);
      const find = (needle: string) => names.find((n) => n.toLowerCase() === needle);
      this.issueTypes = {
        epic: find("epic"),
        feature: find("feature"),
      };
      return this.issueTypes;
    } catch {
      this.issueTypes = null;
      return null;
    }
  }

  private inferKind(j: GhJsonIssue): IssueKind {
    const typeName = j.issueType?.name?.toLowerCase() ?? "";
    if (typeName.includes("epic")) return "epic";
    // Legacy task types and labels read as Features; only Epic and Feature remain.
    if (typeName.includes("feature") || typeName.includes("task")) return "feature";
    const labels = (j.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).map((l) => l.toLowerCase());
    if (labels.includes("mc:epic")) return "epic";
    if (labels.includes("mc:feature") || labels.includes("mc:task")) return "feature";
    // Depth fallback: roots are Epics, children are Features.
    const hasParent = Boolean(j.parent?.number);
    return hasParent ? "feature" : "epic";
  }

  private toIssue(j: GhJsonIssue): Issue {
    const number = j.number;
    if (typeof number !== "number") throw new IssueError("gh_bad_output", "issue JSON is missing a number");
    const body = j.body ?? "";
    const plan = parsePlanMarker(body);
    const labels = (j.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name ?? ""))
      .filter((l): l is string => l.length > 0);
    const parent = j.parent?.number ? this.ref(j.parent.number) : undefined;
    const refs = (list?: GhRelation) =>
      relationItems(list)
        .map((entry) => entry.number)
        .filter((n): n is number => typeof n === "number")
        .map((n) => this.ref(n));
    const children = refs(j.subIssues);
    return {
      ref: this.ref(number),
      title: j.title ?? "",
      body,
      state: j.state === "CLOSED" || j.state === "closed" ? "closed" : "open",
      kind: this.inferKind(j),
      issueType: j.issueType?.name,
      labels,
      parent,
      children,
      blockedBy: refs(j.blockedBy),
      blocking: refs(j.blocking),
      acceptance: parseAcceptance(body),
      approval: parseApprovalMarker(body),
      ...(plan.plan ? { plan: plan.plan } : {}),
      ...(plan.error ? { planError: plan.error } : {}),
      url: j.url,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    };
  }

  async get(ref: IssueRef): Promise<Issue | null> {
    try {
      const out = await this.gh(["issue", "view", String(ref.number), "--repo", this.repo, "--json", ISSUE_FIELDS]);
      return this.toIssue(JSON.parse(out) as GhJsonIssue);
    } catch (error) {
      if (error instanceof IssueError && error.code === "gh_failed" && /not found|Could not resolve/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async list(filter: IssueListFilter = {}): Promise<Issue[]> {
    const state = filter.state ?? "all";
    const limit = filter.limit ?? 200;
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--state",
      state,
      "--limit",
      String(limit),
      "--json",
      ISSUE_FIELDS,
    ]);
    return (JSON.parse(out) as GhJsonIssue[]).map((j) => this.toIssue(j));
  }

  async hierarchy(ref: IssueRef): Promise<Issue[]> {
    const chain: Issue[] = [];
    let current: Issue | null = await this.get(ref);
    if (!current) return chain;
    let guard = 0;
    while (current.parent && guard < 10) {
      const parent = await this.get(current.parent);
      if (!parent) break;
      chain.push(parent);
      current = parent;
      guard += 1;
    }
    return chain;
  }

  async children(ref: IssueRef): Promise<Issue[]> {
    const issue = await this.get(ref);
    if (!issue) return [];
    const out: Issue[] = [];
    for (const childRef of issue.children) {
      const child = await this.get(childRef);
      if (child) out.push(child);
    }
    return out;
  }

  async blockers(ref: IssueRef): Promise<IssueRef[]> {
    const issue = await this.get(ref);
    return issue?.blockedBy ?? [];
  }

  /** Hierarchy rule: Features live under Epics; Epics have no parent. */
  private async assertParentRule(kind: IssueKind, parent: IssueRef | undefined): Promise<void> {
    if (kind === "epic") {
      if (parent) {
        throw new IssueError("invalid_parent", "an Epic cannot have a parent");
      }
      return;
    }
    if (!parent) return;
    const parentIssue = await this.get(parent);
    if (!parentIssue) {
      throw new IssueError("parent_not_found", `parent ${parent.repo}#${parent.number} not found`);
    }
    if (parentIssue.kind !== "epic") {
      throw new IssueError(
        "invalid_parent",
        `a Feature's parent must be an Epic (got ${parentIssue.kind} #${parentIssue.ref.number})`,
      );
    }
  }

  async create(input: NewIssue): Promise<Issue> {
    await this.assertParentRule(input.kind, input.parent);
    const args = [
      "issue",
      "create",
      "--repo",
      this.repo,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    const labels = new Set(input.labels ?? []);
    labels.add(`mc:${input.kind}`);
    await this.ensureLabels(labels);
    const types = await this.detectIssueTypes();
    const nativeType = types?.[input.kind];
    if (nativeType) args.push("--type", nativeType);
    for (const label of labels) args.push("--label", label);
    if (input.parent) args.push("--parent", String(input.parent.number));
    for (const blocker of input.blockedBy ?? []) args.push("--blocked-by", String(blocker.number));
    const out = await this.gh(args, 60_000);
    // gh prints the created issue URL; fetch it for the full record.
    const m = out.match(/\/issues\/(\d+)\s*$/m);
    if (!m) throw new IssueError("gh_bad_output", `could not parse created issue from: ${out.trim()}`);
    const created = await this.get(this.ref(Number(m[1])));
    if (!created) throw new IssueError("gh_bad_output", "created issue could not be read back");
    return created;
  }

  async update(ref: IssueRef, patch: IssuePatch): Promise<Issue> {
    if (patch.labels) await this.ensureLabels(patch.labels);
    if (patch.parent) {
      const target = await this.get(ref);
      if (target) await this.assertParentRule(target.kind, patch.parent);
    }
    const args = ["issue", "edit", String(ref.number), "--repo", this.repo];
    if (patch.title !== undefined) args.push("--title", patch.title);
    if (patch.body !== undefined) args.push("--body", patch.body);
    for (const label of patch.labels ?? []) args.push("--add-label", label);
    if (patch.parent === null) args.push("--remove-parent");
    else if (patch.parent) args.push("--parent", String(patch.parent.number));
    for (const blocker of patch.blockedBy ?? []) args.push("--add-blocked-by", String(blocker.number));
    for (const blocker of patch.removeBlockedBy ?? []) args.push("--remove-blocked-by", String(blocker.number));
    await this.gh(args, 60_000);
    const updated = await this.get(ref);
    if (!updated) throw new IssueError("gh_bad_output", "updated issue could not be read back");
    return updated;
  }

  async close(ref: IssueRef, reason?: string): Promise<void> {
    const args = ["issue", "close", String(ref.number), "--repo", this.repo];
    if (reason) args.push("--reason", reason);
    await this.gh(args, 30_000);
  }

  async reopen(ref: IssueRef): Promise<void> {
    await this.gh(["issue", "reopen", String(ref.number), "--repo", this.repo], 30_000);
  }

  async delete(ref: IssueRef): Promise<void> {
    await this.gh(["issue", "delete", String(ref.number), "--repo", this.repo, "--yes"], 60_000);
  }

  async linkParent(child: IssueRef, parent: IssueRef | null): Promise<void> {
    if (parent) {
      const childIssue = await this.get(child);
      if (childIssue) await this.assertParentRule(childIssue.kind, parent);
    }
    const args = ["issue", "edit", String(child.number), "--repo", this.repo];
    if (parent) args.push("--parent", String(parent.number));
    else args.push("--remove-parent");
    await this.gh(args, 30_000);
  }
}
