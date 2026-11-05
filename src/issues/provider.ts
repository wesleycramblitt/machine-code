/**
 * machine_code — issue provider abstraction.
 *
 * GitHub is authoritative for project structure, but the harness talks to it
 * through this interface so the rest of the code (context, TUI, workflows)
 * never depends on `gh` or on GitHub-specific shapes. A null provider covers
 * untracked runs and missing authentication.
 */
import type { PlanMarker } from "../plan/schema.js";

export interface IssueRef {
  provider: string; // "github" | "none"
  repo: string; // "owner/name"
  number: number;
}

export type IssueKind = "epic" | "feature" | "task";
export type IssueState = "open" | "closed";
export type ReservedKind = "epic-pr" | "feature-pr";

export interface ReservedInfo {
  /** The Epic/Feature that owns this reserved issue. */
  for: IssueRef;
  kind: ReservedKind;
}

export interface Issue {
  ref: IssueRef;
  title: string;
  body: string;
  state: IssueState;
  kind: IssueKind;
  issueType?: string;
  labels: string[];
  parent?: IssueRef;
  children: IssueRef[];
  blockedBy: IssueRef[];
  blocking: IssueRef[];
  reserved?: ReservedInfo;
  /** Parsed `## Acceptance criteria` bullets. */
  acceptance: string[];
  /** Parsed `mc:approval` marker: human (default) or agent. */
  approval?: "human" | "agent";
  /** Parsed `mc:plan` marker when present and valid. */
  plan?: PlanMarker;
  /** Error text when an mc:plan marker is present but invalid. */
  planError?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NewIssue {
  title: string;
  body: string;
  kind: IssueKind;
  parent?: IssueRef;
  labels?: string[];
  blockedBy?: IssueRef[];
}

export interface IssuePatch {
  title?: string;
  body?: string;
  labels?: string[];
  /** null removes the parent. */
  parent?: IssueRef | null;
  blockedBy?: IssueRef[];
}

export interface IssueListFilter {
  state?: "open" | "closed" | "all";
  limit?: number;
}

export interface IssueProvider {
  readonly kind: string;
  /** Provider id used in IssueRef (e.g. "github"). */
  available(): Promise<boolean>;
  get(ref: IssueRef): Promise<Issue | null>;
  list(filter?: IssueListFilter): Promise<Issue[]>;
  /** Ancestor chain, nearest parent first (excludes the issue itself). */
  hierarchy(ref: IssueRef): Promise<Issue[]>;
  children(ref: IssueRef): Promise<Issue[]>;
  blockers(ref: IssueRef): Promise<IssueRef[]>;
  create(input: NewIssue): Promise<Issue>;
  update(ref: IssueRef, patch: IssuePatch): Promise<Issue>;
  close(ref: IssueRef, reason?: string): Promise<void>;
  reopen(ref: IssueRef): Promise<void>;
  linkParent(child: IssueRef, parent: IssueRef | null): Promise<void>;
  /** Permanently delete the issue. Not all providers support this. */
  delete?(ref: IssueRef): Promise<void>;
}

export class IssueError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function refKey(ref: IssueRef): string {
  return `${ref.provider}:${ref.repo}#${ref.number}`;
}

/** Parse "owner/repo#123", "123", or a full URL into an IssueRef. */
export function parseIssueRef(value: string, defaultRepo?: string, provider = "github"): IssueRef {
  const trimmed = value.trim();
  const url = trimmed.match(/github\.com\/([^/]+)\/([^/#]+)\/(?:issues|pull)\/(\d+)/);
  if (url) return { provider, repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  const full = trimmed.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (full) return { provider, repo: `${full[1]}/${full[2]}`, number: Number(full[3]) };
  const bare = trimmed.match(/^#?(\d+)$/);
  if (bare) {
    if (!defaultRepo) throw new IssueError("repo_required", `issue "${value}" needs an owner/repo (no git remote found)`);
    return { provider, repo: defaultRepo, number: Number(bare[1]) };
  }
  throw new IssueError("invalid_issue_ref", `cannot parse issue reference: "${value}"`);
}

export interface ParsedReserved {
  for: string;
  kind: ReservedKind;
}

/** Read the invisible mc:reserved marker from an issue body. */
export function parseReservedMarker(body: string): ParsedReserved | null {
  const m = body.match(/<!--\s*mc:reserved\s*([\s\S]*?)-->/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]!.trim()) as { for?: unknown; kind?: unknown };
    if (typeof raw.for !== "string" || (raw.kind !== "epic-pr" && raw.kind !== "feature-pr")) return null;
    return { for: raw.for, kind: raw.kind };
  } catch {
    return null;
  }
}

/** Read the mc:approval marker (default is human when absent). */
export function parseApprovalMarker(body: string): "human" | "agent" | undefined {
  const m = body.match(/<!--\s*mc:approval\s*([\s\S]*?)-->/);
  if (!m) return undefined;
  try {
    const raw = JSON.parse(m[1]!.trim()) as { mode?: unknown };
    return raw.mode === "agent" ? "agent" : raw.mode === "human" ? "human" : undefined;
  } catch {
    return undefined;
  }
}

/** Parse acceptance criteria from a heading or a plain `Acceptance criteria:` label. */
export function parseAcceptance(body: string): string[] {
  const lines = body.split("\n");
  let inSection = false;
  const out: string[] = [];
  const otherSections = new Set([
    "scope",
    "context",
    "problem",
    "outcome",
    "success",
    "success measures",
    "verification",
    "dependencies",
    "out of scope",
    "notes",
    "background",
    "goal",
    "why now",
    "risks",
    "deliverables",
  ]);
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /acceptance/i.test(heading[1] ?? "");
      continue;
    }
    // Planners often write `Acceptance criteria:` without a markdown heading.
    if (/^\s*(?:\*\*)?acceptance(?: criteria)?(?:\*\*)?\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    const label = line.match(/^\s*(?:\*\*)?([A-Za-z][A-Za-z /-]{2,40})(?:\*\*)?:\s*(.*)$/);
    if (label) {
      const name = (label[1] ?? "").trim().toLowerCase();
      if (/acceptance/i.test(name)) {
        inSection = true;
        continue;
      }
      if (otherSections.has(name)) {
        inSection = false;
        continue;
      }
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet && bullet[1]) out.push(bullet[1].trim());
  }
  return out;
}

/** Reserved title conventions (the `0` is a logical ordinal, not a number). */
export const RESERVED_TITLES = {
  "epic-pr": "Feature 0: Planning & Review",
  "feature-pr": "Task 0: Planning & Review",
} as const;

export const RESERVED_LABELS = {
  "epic-pr": "mc:reserved:epic-pr",
  "feature-pr": "mc:reserved:feature-pr",
} as const;

export function reservedMarker(forRef: IssueRef, kind: ReservedKind, reason = "coordination anchor"): string {
  return `<!-- mc:reserved\n${JSON.stringify({ for: `${forRef.repo}#${forRef.number}`, kind, reason })}\n-->`;
}
