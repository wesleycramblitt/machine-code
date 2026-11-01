/**
 * machine_code — null PR provider (no GitHub remote, or gh unavailable).
 */
import { PrError, type NewPullRequest, type PullRequest, type PullRequestProvider } from "./provider.js";

export class NullPrProvider implements PullRequestProvider {
  readonly kind = "none";
  constructor(readonly reason: string = "PR provider unavailable") {}

  async available(): Promise<boolean> {
    return false;
  }

  async create(_input: NewPullRequest): Promise<PullRequest> {
    throw new PrError("pr_unavailable", `pull requests unavailable: ${this.reason}`);
  }

  async status(_number: number): Promise<PullRequest | null> {
    return null;
  }

  async merge(_number: number, _method?: "squash" | "merge" | "rebase"): Promise<void> {
    throw new PrError("pr_unavailable", `pull requests unavailable: ${this.reason}`);
  }

  async list(): Promise<PullRequest[]> {
    return [];
  }
}
