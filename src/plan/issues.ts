/**
 * machine_code — issues: the single work tree.
 *
 * Status is the directory:
 *
 *   issues/
 *     ideas/
 *       <slug>.md              needs research
 *       .researched/<slug>.md  researched
 *     features/{todo,blocked,done}/<slug>.md
 *     bugs/{todo,blocked,done}/<slug>.md
 *
 * Each file is YAML front-matter (`priority`, `prompt`, `depends`, `tags`,
 * `review`, `verify`) plus markdown. There is no "archived": delete an issue
 * when it is no longer wanted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import type { Layout } from "../paths.js";
import { slugify } from "./slug.js";

export const ISSUES_DIR = "issues";
export const ISSUE_KINDS = ["ideas", "features", "bugs"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Ideas live at the root (needs research) or under `.researched/`. */
export const IDEA_STATUSES = ["needs-research", "researched"] as const;
/** Features and bugs use three directories. */
export const ENGINEER_STATUSES = ["todo", "blocked", "done"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type EngineerStatus = (typeof ENGINEER_STATUSES)[number];
export type IssueStatus = IdeaStatus | EngineerStatus;
/** Display-only status for a todo item with a live run. */
export type DisplayStatus = IssueStatus | "in-progress";

export const ISSUE_KIND_LABELS: Record<IssueKind, string> = {
  ideas: "Ideas",
  features: "Features",
  bugs: "Bugs",
};

export const ISSUE_STATUS_LABELS: Record<DisplayStatus, string> = {
  "needs-research": "Needs Research",
  researched: "Researched",
  todo: "Todo",
  blocked: "Blocked",
  "in-progress": "In Progress",
  done: "Done",
};

export type ReviewMode = "none" | "agent" | "human";

export interface Issue {
  kind: IssueKind;
  status: IssueStatus;
  slug: string;
  /** Absolute path of the issue file. */
  path: string;
  /** Repo-relative path. */
  rel: string;
  priority: string;
  /** The `#Prompt` (what the agent should do). */
  prompt: string;
  /** Full body text. */
  body: string;
  /** Other issue slugs this one depends on. */
  depends: string[];
  tags: string[];
  review: ReviewMode;
  /** Named gate commands; empty means the runner's defaults. */
  acceptance: string[];
  /** Legacy alias for acceptance. */
  verify: string[];
  title: string;
}

/** The hidden directory that marks a researched idea. */
export const RESEARCHED_DIR = ".researched";

const KIND_ALIASES: Record<string, IssueKind> = {
  ideas: "ideas",
  idea: "ideas",
  features: "features",
  feature: "features",
  bugs: "bugs",
  bug: "bugs",
};

export function parseKind(value: string): IssueKind | undefined {
  return KIND_ALIASES[value.toLowerCase()];
}

export function statusesForKind(kind: IssueKind): readonly IssueStatus[] {
  return kind === "ideas" ? IDEA_STATUSES : ENGINEER_STATUSES;
}

function issuesRoot(layout: Layout): string {
  return join(layout.repoRoot, ISSUES_DIR);
}

/** Directory holding an issue of `kind` in `status`. */
export function issueDir(layout: Layout, kind: IssueKind, status: IssueStatus): string {
  if (kind === "ideas") {
    return status === "researched"
      ? join(issuesRoot(layout), "ideas", RESEARCHED_DIR)
      : join(issuesRoot(layout), "ideas");
  }
  return join(issuesRoot(layout), kind, status);
}

export function ensureIssueDirs(layout: Layout): void {
  for (const kind of ISSUE_KINDS) {
    for (const status of statusesForKind(kind)) {
      mkdirSync(issueDir(layout, kind, status), { recursive: true });
    }
  }
}

/** Within-repo path guard. */
export function safeIssuePath(layout: Layout, rel: string): string | null {
  if (rel.startsWith("/") || rel.split("/").includes("..")) return null;
  const base = resolve(layout.repoRoot);
  const abs = resolve(base, rel);
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

export function parseIssueFile(text: string): { front: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { front: {}, body: text.trim() };
  let front: Record<string, unknown> = {};
  try {
    front = parse(match[1] ?? "") as Record<string, unknown>;
  } catch {
    front = {};
  }
  return { front, body: (match[2] ?? "").trim() };
}

function toSlugs(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((entry) => slugify(entry)).filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").map((entry) => slugify(entry)).filter(Boolean);
  }
  return [];
}

function toReview(value: unknown): ReviewMode {
  return value === "agent" || value === "human" ? value : "none";
}

function toAcceptance(front: Record<string, unknown>): string[] {
  if (typeof front.acceptance === "string") return front.acceptance.split(",").map((e) => e.trim()).filter(Boolean);
  if (Array.isArray(front.acceptance)) return front.acceptance.filter((e): e is string => typeof e === "string");
  if (typeof front.verify === "string") return front.verify.split(",").map((e) => e.trim()).filter(Boolean);
  if (Array.isArray(front.verify)) return front.verify.filter((e): e is string => typeof e === "string");
  return [];
}

function titleOf(slug: string, body: string): string {
  const heading = body.split("\n").find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#+\s+/, "").trim() : slug;
}

export function readIssue(layout: Layout, kind: IssueKind, status: IssueStatus, slug: string): Issue | null {
  const abs = join(issueDir(layout, kind, status), `${slug}.md`);
  if (!existsSync(abs)) return null;
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const { front, body } = parseIssueFile(text);
  return {
    kind,
    status,
    slug,
    path: abs,
    rel: `${ISSUES_DIR}/${kind}/${status === "needs-research" ? "" : status === "researched" ? `${RESEARCHED_DIR}/` : `${status}/`}${slug}.md`.replace("//", "/"),
    priority: typeof front.priority === "string" ? front.priority : "medium",
    prompt: typeof front.prompt === "string" ? front.prompt : body.split("\n\n")[0]?.trim() ?? "",
    body,
    depends: toSlugs(front.depends),
    tags:
      typeof front.tags === "string"
        ? front.tags.split(",").map((entry) => entry.trim()).filter(Boolean)
        : Array.isArray(front.tags)
          ? front.tags.filter((entry): entry is string => typeof entry === "string")
          : [],
    review: toReview(front.review),
    verify: toAcceptance(front),
    acceptance: toAcceptance(front),
    title: titleOf(slug, body),
  };
}

/** Every issue in every status directory. */
export function listIssues(layout: Layout): Issue[] {
  const out: Issue[] = [];
  if (!existsSync(issuesRoot(layout))) return out;
  for (const kind of ISSUE_KINDS) {
    for (const status of statusesForKind(kind)) {
      const dir = issueDir(layout, kind, status);
      if (!existsSync(dir)) continue;
      let names: string[] = [];
      try {
        names = readdirSync(dir)
          .filter((name) => name.endsWith(".md"))
          .sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const issue = readIssue(layout, kind, status, name.replace(/\.md$/, ""));
        if (issue) out.push(issue);
      }
    }
  }
  return out;
}

/** Find an issue by slug across all kinds and statuses. */
export function findIssue(layout: Layout, slug: string): Issue | null {
  return listIssues(layout).find((entry) => entry.slug === slug) ?? null;
}

export interface NewIssueInput {
  kind: IssueKind;
  status?: IssueStatus;
  slug: string;
  title?: string;
  prompt: string;
  priority?: string;
  depends?: string[];
  tags?: string[];
  review?: ReviewMode;
  acceptance?: string[];
  verify?: string[];
  body?: string;
}

export function writeIssue(layout: Layout, input: NewIssueInput): Issue {
  const status = input.status ?? (input.kind === "ideas" ? "needs-research" : "todo");
  if (!legalStatus(input.kind, status)) {
    throw new Error(`invalid status ${JSON.stringify(status)} for ${input.kind}`);
  }
  const slug = slugify(input.slug) || "untitled";
  const front: Record<string, unknown> = {
    priority: input.priority ?? "medium",
    prompt: input.prompt,
    ...(input.depends && input.depends.length > 0 ? { depends: input.depends } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.acceptance && input.acceptance.length > 0 ? { acceptance: input.acceptance } : {}),
    ...(input.verify && input.verify.length > 0 ? { verify: input.verify } : {}),
    review: input.review ?? "none",
  };
  const title = input.title?.trim() ? `# ${input.title.trim()}` : `# ${slug}`;
  const body = input.body?.trim() ? `${title}\n\n${input.body.trim()}\n` : `${title}\n`;
  const dir = issueDir(layout, input.kind, status);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${slug}.md`);
  writeFileSync(abs, `---\n${stringify(front)}---\n\n${body}`, "utf8");
  const issue = readIssue(layout, input.kind, status, slug);
  if (!issue) throw new Error(`failed to write issue ${slug}`);
  return issue;
}

/** Update just the review gate, preserving front-matter and body. */
export function updateIssueReview(layout: Layout, slug: string, review: ReviewMode): Issue | null {
  const issue = findIssue(layout, slug);
  if (!issue) return null;
  const text = readFileSync(issue.path, "utf8");
  const { front, body } = parseIssueFile(text);
  front.review = review;
  writeFileSync(issue.path, `---\n${stringify(front)}---\n\n${body}`, "utf8");
  return readIssue(layout, issue.kind, issue.status, slug);
}

/** Move work to another status by moving its file. */
export function moveIssue(layout: Layout, slug: string, to: IssueStatus): Issue | null {
  const issue = findIssue(layout, slug);
  if (!issue || issue.status === to) return issue;
  if (!legalStatus(issue.kind, to)) {
    throw new Error(`invalid status ${JSON.stringify(to)} for ${issue.kind} issue ${slug}`);
  }
  const dir = issueDir(layout, issue.kind, to);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${slug}.md`);
  writeFileSync(dest, readFileSync(issue.path, "utf8"), "utf8");
  rmSync(issue.path, { force: true });
  return readIssue(layout, issue.kind, to, slug);
}

/** Whether `to` is a legal status for the item's kind. */
export function legalStatus(kind: IssueKind, to: string): to is IssueStatus {
  return (statusesForKind(kind) as readonly string[]).includes(to);
}
