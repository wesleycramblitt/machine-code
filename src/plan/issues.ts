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
 * An issue file is plain markdown whose text IS the prompt — nothing else is
 * required. Optional `key: value` header lines at the very top set metadata
 * (`priority`, `review`, `tags`, `depends`, `acceptance`, `verify`,
 * `verification`), followed by a blank line:
 *
 *   priority: high
 *   tags: tui, perf
 *   acceptance: script:build
 *
 *   # Make lookups fast
 *
 *   Swap the linear scan for an index.
 *
 * Legacy `---` TOML front-matter files still read; they are rewritten in the
 * new form on the next touch. There is no "archived": delete an issue when it
 * is no longer wanted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import type { Layout } from "../paths.js";
import { slugify } from "./slug.js";

export const ISSUES_DIR = "issues";
export const ISSUE_KINDS = ["ideas", "features", "bugs"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Ideas live at the root (needs research) or under `.researched/`. */
export const IDEA_STATUSES = ["needs-research", "researched"] as const;
/** Features and bugs use explicit work and failure directories. */
export const ENGINEER_STATUSES = [
  "todo",
  "needs-human-review",
  "failed-gates",
  "failed-human-review",
  "blocked",
  "done",
] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type EngineerStatus = (typeof ENGINEER_STATUSES)[number];
export type IssueStatus = IdeaStatus | EngineerStatus;
/** Statuses a new engineer attempt may start from. */
export const ENGINEER_WORK_STATUSES: readonly EngineerStatus[] = [
  "todo",
  "failed-gates",
  "failed-human-review",
  "blocked",
];
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
  "needs-human-review": "Needs Human Review",
  "failed-gates": "Failed Gates",
  "failed-human-review": "Failed Human Review",
  blocked: "Blocked",
  "in-progress": "In Progress",
  done: "Done",
};

export type ReviewMode = "none" | "human";

/** Stable short id for an issue. New issues get random bytes; legacy issues
 * get a deterministic id derived from kind+slug so their branch name never
 * changes between reads. */
export function newIssueId(): string {
  return randomBytes(3).toString("hex");
}

export function issueId(kind: IssueKind, slug: string, existing?: string): string {
  if (existing && /^[a-z0-9]{4,12}$/i.test(existing)) return existing.toLowerCase();
  return legacyIssueId(kind, slug);
}

export function legacyIssueId(kind: IssueKind, slug: string): string {
  return createHash("sha1").update(`${kind}:${slug}`).digest("hex").slice(0, 6);
}

/** The one feature branch for an issue. */
export function issueBranchName(slug: string, id: string): string {
  return `mc/${slug}-${id}`;
}

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
  /** Repo-relative files or globs this issue expects to touch. Used to
   * serialize overlapping work before it can conflict at merge time. */
  files: string[];
  /** Stable short id appended to the human slug, so branch/worktree names
   * never collide across two issues that slugify to the same text. */
  id: string;
  /** Feature branch for this issue. Generated once and reused by every run. */
  branch: string;
  /** Commit that landed the issue's work (merge commit on main). Survives
   * branch/worktree pruning and is the only reference a later run needs. */
  commit?: string;
  tags: string[];
  /** Human-provided search terms (comma-separated phrases); an exact-match override for the ranker. */
  keywords: string[];
  review: ReviewMode;
  /** direct: code only; verified: code + tests. */
  verification: "direct" | "verified";
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

/** Metadata keys allowed in the condensed `key: value` header. Anything else
 * (e.g. `Fix: the parser`) is body text, so a bare prompt never misparses. */
const META_KEYS = new Set(["id", "branch", "commit", "priority", "review", "tags", "keywords", "depends", "files", "acceptance", "verify", "verification"]);

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) return value.slice(1, -1);
  }
  return value;
}

export function parseIssueFile(text: string): { front: Record<string, unknown>; body: string } {
  // Legacy `---` TOML front-matter: still reads, never written.
  const legacy = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (legacy) {
    let front: Record<string, unknown> = {};
    try {
      front = parse(legacy[1] ?? "") as Record<string, unknown>;
    } catch {
      front = {};
    }
    return { front, body: (legacy[2] ?? "").trim() };
  }
  // Condensed header: leading `key: value` lines for known keys, then the
  // body. No header, no blank line, no heading required.
  const lines = text.split("\n");
  const front: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    const match = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!match || !META_KEYS.has(match[1]!.toLowerCase())) break;
    const key = match[1]!.toLowerCase();
    front[key] = stripQuotes((match[2] ?? "").trim());
    i += 1;
  }
  let body = lines.slice(i).join("\n").trim();
  return { front, body: body || text.trim() };
}

function toSlugs(value: unknown): string[] {
  // Filter empty entries BEFORE slugify: slugify("") is "untitled", so an
  // empty `depends:` line used to become a phantom dependency on an issue
  // named "untitled" and block every run that touched the file. A literal
  // `undefined`/`null` (written by a template or a bad tool call) is also
  // noise, not a slug.
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
  return raw
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !/^(undefined|null)$/i.test(entry))
    .map((entry) => slugify(entry))
    .filter(Boolean);
}

/** File footprints are paths/globs, not slugs: preserve their spelling. */
function toFiles(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
  return raw
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !/^(undefined|null)$/i.test(entry));
}

function toReview(value: unknown): ReviewMode {
  return value === "human" ? "human" : "none";
}

function toAcceptance(front: Record<string, unknown>): string[] {
  if (typeof front.acceptance === "string") return front.acceptance.split(",").map((e) => e.trim()).filter(Boolean);
  if (Array.isArray(front.acceptance)) return front.acceptance.filter((e): e is string => typeof e === "string");
  if (typeof front.verify === "string") return front.verify.split(",").map((e) => e.trim()).filter(Boolean);
  if (Array.isArray(front.verify)) return front.verify.filter((e): e is string => typeof e === "string");
  return [];
}

/** Drop a legacy `## Todo` section from a body so the prompt stays clean. */
function stripTodoSection(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^## Todo\b/.test(line));
  if (start < 0) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One-line rendering of a prompt for picker rows and summary lists.
 * Bodies routinely span lines now (a `# heading` plus detail paragraphs);
 * collapsing keeps every row on one terminal line and every `- ` summary
 * item valid markdown. A leading `# ` marker is decoration, not content. */
export function singleLine(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(slug: string, body: string): string {
  const heading = body.split("\n").find((line) => /^#\s+/.test(line));
  if (heading) return heading.replace(/^#+\s+/, "").trim() || slug;
  const first = body.split("\n").find((line) => line.trim().length > 0);
  if (first) return first.trim().slice(0, 80) || slug;
  return slug;
}

/** The condensed writer: `key: value` header lines only for non-defaults,
 * then the body, which is the whole prompt. No `---`, no `prompt = `. */
function serializeIssueFile(front: Record<string, unknown>, body: string): string {
  const list = (value: unknown): string =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").join(", ")
      : typeof value === "string"
        ? value
        : "";
  const lines: string[] = [];
  for (const key of ["id", "branch", "commit"] as const) {
    if (typeof front[key] === "string" && front[key]) lines.push(`${key}: ${front[key]}`);
  }
  if (typeof front.priority === "string" && front.priority && front.priority !== "medium") {
    lines.push(`priority: ${front.priority}`);
  }
  if (typeof front.review === "string" && front.review && front.review !== "none") {
    lines.push(`review: ${front.review}`);
  }
  if (front.verification === "verified") lines.push("verification: verified");
  for (const key of ["depends", "files", "tags", "acceptance"] as const) {
    const value = list(front[key]);
    if (value) lines.push(`${key}: ${value}`);
  }
  if (Array.isArray(front.keywords)) {
    const kept = front.keywords.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    if (kept.length > 0) lines.push(`keywords: ${kept.join(", ")}`);
  } else if (typeof front.keywords === "string" && front.keywords.trim()) {
    lines.push(`keywords: ${front.keywords.trim()}`);
  }
  // `verify` is the legacy alias for `acceptance`; normalize on write unless
  // `acceptance` is already set.
  if (!list(front.acceptance) && list(front.verify)) lines.push(`acceptance: ${list(front.verify)}`);
  const text = body.trim();
  return lines.length > 0 ? `${lines.join("\n")}\n\n${text}\n` : `${text}\n`;
}

/** How many gate-failure repair attempts the issue has already recorded. */
export function gateFailureAttempts(body: string): number {
  const match = /## Gate failure\s*\nAttempt:\s*(\d+)/i.exec(body);
  return match ? Number(match[1]) || 0 : 0;
}

/** Replace the issue's gate-failure section with the latest capped log. */
export function appendIssueGateFailure(abs: string, failure: string, attempt: number): void {
  const text = readFileSync(abs, "utf8");
  const { front, body } = parseIssueFile(text);
  const section = `## Gate failure\nAttempt: ${attempt}\n\n${failure.trim().slice(0, 4_000)}`;
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^## Gate failure\b/.test(line));
  if (start < 0) {
    writeFileSync(abs, serializeIssueFile(front, `${body.trimEnd()}\n\n${section}`), "utf8");
    return;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...section.split("\n"));
  writeFileSync(abs, serializeIssueFile(front, lines.join("\n")), "utf8");
}

/** Verified requires a test script; downgrade a stale verified marker. */
export function ensureIssueVerification(layout: Layout, slug: string): void {
  const issue = findIssue(layout, slug);
  if (!issue || issue.verification !== "verified" || hasRepoScript(layout, "test")) return;
  const text = readFileSync(issue.path, "utf8");
  const { front, body } = parseIssueFile(text);
  delete front.verification;
  writeFileSync(issue.path, serializeIssueFile(front, body), "utf8");
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
  const storedId = typeof front.id === "string" && front.id.trim() ? front.id.trim() : undefined;
  const id = issueId(kind, slug, storedId);
  return {
    kind,
    status,
    slug,
    path: abs,
    rel: `${ISSUES_DIR}/${kind}/${status === "needs-research" ? "" : status === "researched" ? `${RESEARCHED_DIR}/` : `${status}/`}${slug}.md`.replace("//", "/"),
    priority: typeof front.priority === "string" ? front.priority : "medium",
    // The body is the prompt. `front.prompt` only exists in legacy `---` TOML
    // files, where the body is just a title.
    prompt: typeof front.prompt === "string" && front.prompt.trim() ? front.prompt : body,
    body,
    depends: toSlugs(front.depends),
    files: toFiles(front.files),
    id,
    // Legacy issues (no stored id) keep their historical `mc/<slug>` branch;
    // new issues get the collision-free `mc/<slug>-<id>` name.
    branch:
      typeof front.branch === "string" && front.branch.trim()
        ? front.branch.trim()
        : storedId
          ? issueBranchName(slug, id)
          : `mc/${slug}`,
    ...(typeof front.commit === "string" && front.commit.trim() ? { commit: front.commit.trim() } : {}),
    tags:
      typeof front.tags === "string"
        ? front.tags.split(",").map((entry) => entry.trim()).filter(Boolean)
        : Array.isArray(front.tags)
          ? front.tags.filter((entry): entry is string => typeof entry === "string")
          : [],
    // Keywords are phrases, not slugs: split on commas only, never on
    // spaces, so "Run Details" stays one term.
    keywords:
      typeof front.keywords === "string"
        ? front.keywords.split(",").map((entry) => entry.trim()).filter(Boolean)
        : Array.isArray(front.keywords)
          ? front.keywords.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
          : [],
    review: toReview(front.review),
    verification: front.verification === "verified" ? "verified" : "direct",
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
  id?: string;
  branch?: string;
  depends?: string[];
  files?: string[];
  tags?: string[];
  review?: ReviewMode;
  verification?: "direct" | "verified";
  acceptance?: string[];
  verify?: string[];
  keywords?: string[];
  body?: string;
}

const SCRIPT_EXTS = [".sh", ".bash", ".py", ".js", ".mjs", ".cjs"];

/** Repo scripts are `scripts/<name>.sh` (or similar); `script:test` gates verified runs. */
export function hasRepoScript(layout: Layout, name: string): boolean {
  for (const dir of [join(layout.repoRoot, "scripts"), join(layout.repoDir, "scripts")]) {
    for (const ext of SCRIPT_EXTS) {
      if (existsSync(join(dir, `${name}${ext}`))) return true;
    }
  }
  return false;
}

export function writeIssue(layout: Layout, input: NewIssueInput): Issue {
  const status = input.status ?? (input.kind === "ideas" ? "needs-research" : "todo");
  if (!legalStatus(input.kind, status)) {
    throw new Error(`invalid status ${JSON.stringify(status)} for ${input.kind}`);
  }
  const slug = slugify(input.slug) || "untitled";
  const id = input.id ?? newIssueId();
  const branch = input.branch ?? issueBranchName(slug, id);
  let verification = input.verification ?? "direct";
  if (verification === "verified" && !hasRepoScript(layout, "test")) verification = "direct";
  // Features and bugs carry an acceptance gate. Explicit acceptance wins;
  // otherwise use the repository's script gates. Ideas run research:verify
  // to confirm the run produced at least one artifact.
  let acceptance =
    input.acceptance && input.acceptance.length > 0
      ? input.acceptance
      : input.verify && input.verify.length > 0
        ? input.verify
        : input.kind === "ideas"
          ? ["research:verify"]
          : hasRepoScript(layout, "build")
            ? ["script:build"]
            : [];
  if (verification === "verified" && hasRepoScript(layout, "test") && !acceptance.includes("script:test")) {
    acceptance = [...acceptance, "script:test"];
  }
  const front: Record<string, unknown> = {
    id,
    branch,
    ...(input.priority && input.priority !== "medium" ? { priority: input.priority } : {}),
    ...(input.depends && input.depends.length > 0 ? { depends: input.depends } : {}),
    ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.keywords && input.keywords.length > 0 ? { keywords: input.keywords } : {}),
    ...(acceptance.length > 0 ? { acceptance } : {}),
    ...(verification === "verified" ? { verification } : {}),
    ...(input.review && input.review !== "none" ? { review: input.review } : {}),
  };
  // The file is the prompt. A bare prompt needs nothing else; a title only
  // adds a heading above it. An explicit body is used as-is.
  const prompt = input.prompt.trim();
  const body = input.body?.trim()
    ? input.body.trim()
    : input.title?.trim()
      ? `# ${input.title.trim()}\n\n${prompt}`
      : prompt;
  const dir = issueDir(layout, input.kind, status);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${slug}.md`);
  writeFileSync(abs, serializeIssueFile(front, body || slug), "utf8");
  const issue = readIssue(layout, input.kind, status, slug);
  if (!issue) throw new Error(`failed to write issue ${slug}`);
  return issue;
}

/** Update just the review gate, preserving the header and body. Legacy `---`
 * files are rewritten in the condensed form on the way through. */
export function updateIssueReview(layout: Layout, slug: string, review: ReviewMode): Issue | null {
  const issue = findIssue(layout, slug);
  if (!issue) return null;
  const text = readFileSync(issue.path, "utf8");
  const { front, body } = parseIssueFile(text);
  // Migrate legacy files: their prompt lives in `front.prompt` while the body
  // is just a title. Fold the prompt back under the title once.
  let nextBody = body;
  if (typeof front.prompt === "string" && front.prompt.trim() && !nextBody.includes(front.prompt.trim())) {
    nextBody = nextBody ? `${nextBody}\n\n${front.prompt.trim()}` : front.prompt.trim();
  }
  delete front.prompt;
  front.review = review;
  writeFileSync(issue.path, serializeIssueFile(front, nextBody), "utf8");
  return readIssue(layout, issue.kind, issue.status, slug);
}

/** Update durable issue metadata (commit reference, branch) without touching
 * the prompt body. Used when work lands and the branch/worktree are pruned. */
export function updateIssueMeta(
  layout: Layout,
  slug: string,
  patch: { commit?: string; branch?: string },
): Issue | null {
  const issue = findIssue(layout, slug);
  if (!issue) return null;
  const text = readFileSync(issue.path, "utf8");
  const { front, body } = parseIssueFile(text);
  if (patch.commit !== undefined) front.commit = patch.commit;
  if (patch.branch !== undefined) front.branch = patch.branch;
  writeFileSync(issue.path, serializeIssueFile(front, body), "utf8");
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

/** Upper-case tag for an issue kind, e.g. "IDEA", "FEATURE", "BUG". */
export function kindTag(kind: IssueKind): string {
  return kind === "ideas" ? "IDEA" : kind === "features" ? "FEATURE" : "BUG";
}

/** Normalize a status string into a commit-message tag: "failed-gates" → "FAILED GATES". */
export function statusTag(status: string): string {
  return status.replace(/-/g, " ").toUpperCase();
}
