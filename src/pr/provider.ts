/**
 * machine_code — pull-request provider abstraction.
 *
 * Branches belong to issues, PRs carry the review/merge lifecycle, and the
 * runner owns creation/merge. The harness talks to GitHub through this
 * interface so nothing outside src/pr depends on gh shapes.
 */
export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  mergeable?: boolean;
  head: string;
  base: string;
  title: string;
  createdAt?: string;
  mergedAt?: string;
}

export interface NewPullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestProvider {
  readonly kind: string;
  available(): Promise<boolean>;
  create(input: NewPullRequest): Promise<PullRequest>;
  status(number: number): Promise<PullRequest | null>;
  merge(number: number, method?: "squash" | "merge" | "rebase"): Promise<void>;
  list(filter?: { head?: string; base?: string; state?: "open" | "closed" | "all" }): Promise<PullRequest[]>;
}

export class PrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
