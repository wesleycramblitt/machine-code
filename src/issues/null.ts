/**
 * machine_code — null issue provider for untracked execution.
 *
 * Used when issue tracking is disabled, when the repo has no GitHub remote,
 * or when gh is missing/unauthenticated. Reads return empty; writes fail with
 * a typed error so the harness can decide whether tracking was required.
 */
import { IssueError, type Issue, type IssueListFilter, type IssuePatch, type IssueProvider, type IssueRef, type NewIssue } from "./provider.js";

export class NullIssueProvider implements IssueProvider {
  readonly kind: string;
  constructor(readonly reason: string = "issue tracking disabled") {
    this.kind = "none";
  }

  async available(): Promise<boolean> {
    return false;
  }

  async get(_ref: IssueRef): Promise<Issue | null> {
    return null;
  }

  async list(_filter?: IssueListFilter): Promise<Issue[]> {
    return [];
  }

  async hierarchy(_ref: IssueRef): Promise<Issue[]> {
    return [];
  }

  async children(_ref: IssueRef): Promise<Issue[]> {
    return [];
  }

  async blockers(_ref: IssueRef): Promise<IssueRef[]> {
    return [];
  }

  async create(_input: NewIssue): Promise<Issue> {
    throw new IssueError("provider_unavailable", `issue tracking unavailable: ${this.reason}`);
  }

  async update(_ref: IssueRef, _patch: IssuePatch): Promise<Issue> {
    throw new IssueError("provider_unavailable", `issue tracking unavailable: ${this.reason}`);
  }

  async close(_ref: IssueRef, _reason?: string): Promise<void> {
    throw new IssueError("provider_unavailable", `issue tracking unavailable: ${this.reason}`);
  }

  async reopen(_ref: IssueRef): Promise<void> {
    throw new IssueError("provider_unavailable", `issue tracking unavailable: ${this.reason}`);
  }

  async linkParent(_child: IssueRef, _parent: IssueRef | null): Promise<void> {
    throw new IssueError("provider_unavailable", `issue tracking unavailable: ${this.reason}`);
  }
}
