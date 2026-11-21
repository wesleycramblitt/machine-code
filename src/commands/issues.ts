/**
 * machine_code — issue commands: list, show, create, update (delete is human-only).
 *
 * Agents create and change issues only through issue:create and issue:update
 * (issue:delete is human-only). The handlers reuse the plan layer (writeIssue,
 * updateIssueContents, updateIssueMeta, moveIssue) and accept only legal
 * directories computed by issueDir. Raw write/edit tools must not target
 * .machine_code/issues/ paths directly. Issues are local-only and never
 * committed.
 *
 * Roles: research may call issue:create and issue:update. Engineer must not
 * call issue:create, issue:update, or issue:delete.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { layout } from "../paths.js";
import {
  findIssue,
  issueDir,
  legalStatus,
  listIssues,
  moveIssue,
  parseKind,
  safeIssuePath,
  statusesForKind,
  updateIssueContents,
  updateIssueMeta,
  writeIssue,
  ISSUE_KINDS,
  type IssueStatus,
} from "../plan/issues.js";
import { slugify } from "../plan/slug.js";
import type { CommandSpec } from "./registry.js";

const ISSUE_DIRS = [
  ".machine_code/issues/ideas",
  ".machine_code/issues/ideas/.researched",
  ".machine_code/issues/features/todo",
  ".machine_code/issues/features/needs-human-review",
  ".machine_code/issues/features/failed-gates",
  ".machine_code/issues/features/failed-human-review",
  ".machine_code/issues/features/blocked",
  ".machine_code/issues/features/done",
  ".machine_code/issues/bugs/todo",
  ".machine_code/issues/bugs/needs-human-review",
  ".machine_code/issues/bugs/failed-gates",
  ".machine_code/issues/bugs/failed-human-review",
  ".machine_code/issues/bugs/blocked",
  ".machine_code/issues/bugs/done",
];

/** Extract header fields from an issue file (plain `key: value` lines at the top). */
function frontMatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim() === "") break; // blank line separates headers from body
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key && value && !key.startsWith("#")) out[key] = value;
    }
  }
  return out;
}

/** Find an issue file by slug across all possible paths. */
function findIssueFile(root: string, slug: string): { path: string; text: string } | null {
  // Try direct path first
  for (const dir of ISSUE_DIRS) {
    const full = join(root, dir, `${slug}.md`);
    if (existsSync(full)) return { path: join(dir, `${slug}.md`), text: readFileSync(full, "utf8") };
  }
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const out = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    return out;
  }
  if (typeof value === "string") {
    const out = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    return out;
  }
  return undefined;
}

function normalizeRel(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function expectedRelFor(repoRoot: string, kind: "ideas" | "features" | "bugs", status: IssueStatus, slug: string): string {
  const abs = join(issueDir(layout(repoRoot), kind, status), `${slug}.md`);
  return relative(repoRoot, abs).split(sep).join("/");
}

function legalIssueDirs(repoRoot: string): Set<string> {
  const out = new Set<string>();
  for (const kind of ISSUE_KINDS) {
    for (const status of statusesForKind(kind)) {
      const abs = issueDir(layout(repoRoot), kind, status);
      out.add(relative(repoRoot, abs).split(sep).join("/"));
    }
  }
  return out;
}

/** Append an issue rel to the run's changed-issue log for research:verify. */
function recordChangedIssue(ctx: { runDir?: string }, rel: string): void {
  if (!ctx.runDir || !rel) return;
  const file = join(ctx.runDir, "issues-changed.json");
  let list: string[] = [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    list = [];
  }
  if (!list.includes(rel)) list.push(rel);
  try {
    writeFileSync(file, JSON.stringify(list), "utf8");
  } catch {
    // Tracking is best-effort; the gate reports an empty change set clearly.
  }
}

export function issueCommands(root: string): CommandSpec[] {
  return [
    {
      name: "issue:list",
      description:
        "List all issues grouped by kind and status. Shows slug, title, priority, acceptance, and tags for each.",
      binary: "fs",
      args: () => [],
      schema: {
        kind: { type: "string", description: "Filter: ideas | features | bugs (default all)." },
        status: { type: "string", description: "Filter: todo | needs-human-review | failed-gates | failed-human-review | blocked | done | researched (default all)." },
      },
      readonly: true,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const kindFilter = (args.kind as string | undefined)?.trim();
        const statusFilter = (args.status as string | undefined)?.trim();
        const lines: string[] = [];

        for (const dir of ISSUE_DIRS) {
          // Derive kind/status from directory path
          const parts = dir.replace(".machine_code/issues/", "").split("/");
          const kind = parts[0]!;
          const rawStatus = parts.length > 1 ? parts[1]! : kind === "ideas" ? "needs-research" : "todo";
          const status = rawStatus === ".researched" ? "researched" : rawStatus;

          if (kindFilter && kind !== kindFilter) continue;
          if (statusFilter && status !== statusFilter) continue;

          const fullDir = join((ctx.repoRoot ?? ctx.root), dir);
          if (!existsSync(fullDir)) continue;

          let names: string[] = [];
          try {
            names = readdirSync(fullDir)
              .filter((f) => f.endsWith(".md") && f !== "_template.md")
              .map((f) => f.replace(/\.md$/, ""))
              .sort();
          } catch { names = []; }

          if (names.length === 0) continue;

          for (const slug of names) {
            const issuePath = join((ctx.repoRoot ?? ctx.root), dir, `${slug}.md`);
            const text = existsSync(issuePath) ? readFileSync(issuePath, "utf8") : "";
            const meta = frontMatter(text);
            const firstLine = text.split("\n").find((l) => l.startsWith("# "));
            const title = firstLine?.replace(/^#\s*/, "").trim() ?? slug;
            const tags = [meta.priority, meta.acceptance, meta.tags].filter(Boolean).join(" · ");
            lines.push(`${status}:${slug} — ${title}${tags ? ` (${tags})` : ""}`);
          }
        }

        if (lines.length === 0) return { text: "no issues found", isError: false };
        return { text: lines.join("\n"), isError: false };
      },
    },
    {
      name: "issue:show",
      description:
        "Read the full body of one issue by slug or path. Use issue:list to find slugs.",
      binary: "fs",
      args: () => [],
      schema: {
        slug: { type: "string", description: "Issue slug (the filename without .md). Use issue:list to discover slugs." },
        path: { type: "string", description: "Explicit repo-relative path (.machine_code/issues/.../slug.md). Overrides slug." },
      },
      readonly: true,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const slug = (args.slug as string | undefined)?.trim();
        const path = (args.path as string | undefined)?.trim();

        let issuePath: string | null = null;
        let issueText: string | null = null;

        if (path) {
          const full = join((ctx.repoRoot ?? ctx.root), path);
          if (!existsSync(full)) return { text: `file not found: ${path}`, isError: true };
          issuePath = path;
          issueText = readFileSync(full, "utf8");
        } else if (slug) {
          const found = findIssueFile((ctx.repoRoot ?? ctx.root), slug);
          if (!found) return { text: `issue not found: ${slug}. Use issue:list to find slugs.`, isError: true };
          issuePath = found.path;
          issueText = found.text;
        } else {
          return { text: "issue:show requires slug or path", isError: true };
        }

        const meta = frontMatter(issueText!);
        const header = [`path: ${issuePath}`];
        for (const [k, v] of Object.entries(meta)) header.push(`${k}: ${v}`);
        return { text: `${header.join("\n")}\n\n${issueText!}`, isError: false };
      },
    },
    {
      name: "issue:create",
      description:
        "Create one issue via the plan layer. Research role may call this; engineer role must not. Rejects bad kinds, bad statuses, and bad paths. Only legal dirs from issueDir are accepted.",
      binary: "fs",
      args: () => [],
      schema: {
        kind: { type: "string", required: true, description: "ideas | features | bugs." },
        slug: { type: "string", description: "Issue slug (filename without .md). Defaults from path or to untitled." },
        prompt: { type: "string", description: "Issue prompt (the body). Defaults to the slug." },
        status: { type: "string", description: "Status dir (default needs-research for ideas, todo otherwise)." },
        title: { type: "string", description: "Optional heading above the prompt." },
        priority: { type: "string", description: "low | medium | high." },
        depends: { type: "string", description: "Comma-separated dependency slugs." },
        files: { type: "string", description: "Comma-separated repo paths or globs." },
        tags: { type: "string", description: "Comma-separated tags." },
        acceptance: { type: "string", description: "Comma-separated gate commands." },
        verify: { type: "string", description: "Legacy alias for acceptance." },
        verification: { type: "string", description: "direct | verified." },
        review: { type: "string", description: "none | human." },
        keywords: { type: "string", description: "Comma-separated search phrases." },
        references: { type: "string", description: "Comma-separated exact store citations." },
        path: { type: "string", description: "Optional explicit repo-relative path. Must equal the legal issueDir path." },
      },
      readonly: false,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const kindRaw = asString(args.kind);
        if (!kindRaw) return { text: "issue:create requires kind (ideas | features | bugs)", isError: true };
        const kind = parseKind(kindRaw);
        if (!kind) return { text: `bad kind ${JSON.stringify(kindRaw)}; use ideas | features | bugs`, isError: true };
        const statusRaw = asString(args.status) ?? (kind === "ideas" ? "needs-research" : "todo");
        if (!legalStatus(kind, statusRaw)) {
          return { text: `bad status ${JSON.stringify(statusRaw)} for ${kind}`, isError: true };
        }
        const status = statusRaw as IssueStatus;
        const pathRaw = asString(args.path);
        const slug = slugify(asString(args.slug) ?? (pathRaw ? basename(normalizeRel(pathRaw), ".md") : "untitled")) || "untitled";
        if (!slug) return { text: "bad slug: slug becomes empty", isError: true };
        const l = layout((ctx.repoRoot ?? ctx.root));
        if (findIssue(l, slug)) return { text: `issue ${slug} already exists`, isError: true };
        if (pathRaw) {
          const norm = normalizeRel(pathRaw);
          if (!safeIssuePath(l, norm)) return { text: `bad path ${JSON.stringify(pathRaw)}: escapes the worktree`, isError: true };
          if (!norm.startsWith(".machine_code/issues/") || !norm.endsWith(".md")) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: only legal .machine_code/issues/ dirs from issueDir`, isError: true };
          }
          const expected = expectedRelFor((ctx.repoRoot ?? ctx.root), kind, status, slug);
          if (norm !== expected) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: expected ${expected} (legal dirs come from issueDir)`, isError: true };
          }
        }
        const prompt = asString(args.prompt) ?? slug;
        const reviewRaw = asString(args.review) ?? "none";
        if (reviewRaw !== "none" && reviewRaw !== "human") return { text: "--review must be none|human", isError: true };
        const verificationRaw = asString(args.verification) ?? "direct";
        if (verificationRaw !== "direct" && verificationRaw !== "verified") {
          return { text: "--verification must be direct|verified", isError: true };
        }
        try {
          const created = writeIssue(l, {
            kind,
            status,
            slug,
            prompt,
            ...(asString(args.title) ? { title: asString(args.title)! } : {}),
            ...(asString(args.priority) ? { priority: asString(args.priority)! } : {}),
            ...(asList(args.depends) ? { depends: asList(args.depends)! } : {}),
            ...(asList(args.files) ? { files: asList(args.files)! } : {}),
            ...(asList(args.tags) ? { tags: asList(args.tags)! } : {}),
            ...(asList(args.acceptance) ? { acceptance: asList(args.acceptance)! } : {}),
            ...(asList(args.verify) ? { verify: asList(args.verify)! } : {}),
            ...(asList(args.keywords) ? { keywords: asList(args.keywords)! } : {}),
            ...(asList(args.references) ? { references: asList(args.references)! } : {}),
            verification: verificationRaw as "direct" | "verified",
            review: reviewRaw as "none" | "human",
          });
          recordChangedIssue(ctx, created.rel);
          return { text: `created ${created.rel}`, isError: false };
        } catch (error) {
          return { text: (error as Error).message, isError: true };
        }
      },
    },
    {
      name: "issue:update",
      description:
        "Update one issue via the plan layer. Research role may call this; engineer role must not. Rejects bad statuses and bad paths.",
      binary: "fs",
      args: () => [],
      schema: {
        slug: { type: "string", description: "Issue slug." },
        path: { type: "string", description: "Explicit repo-relative issue path. Must be a legal issueDir path." },
        prompt: { type: "string", description: "New prompt body." },
        status: { type: "string", description: "Move the issue to this status." },
        priority: { type: "string", description: "low | medium | high." },
        depends: { type: "string", description: "Comma-separated dependency slugs." },
        files: { type: "string", description: "Comma-separated repo paths or globs." },
        tags: { type: "string", description: "Comma-separated tags." },
        acceptance: { type: "string", description: "Comma-separated gate commands." },
        verification: { type: "string", description: "direct | verified." },
        review: { type: "string", description: "none | human." },
        keywords: { type: "string", description: "Comma-separated search phrases." },
        commit: { type: "string", description: "Landing commit reference." },
        branch: { type: "string", description: "Feature branch name." },
      },
      readonly: false,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const l = layout((ctx.repoRoot ?? ctx.root));
        const slugRaw = asString(args.slug);
        const pathRaw = asString(args.path);
        if (!slugRaw && !pathRaw) return { text: "issue:update requires slug or path", isError: true };
        let slug = slugRaw ? slugify(slugRaw) : "";
        if (pathRaw) {
          const norm = normalizeRel(pathRaw);
          if (!safeIssuePath(l, norm)) return { text: `bad path ${JSON.stringify(pathRaw)}: escapes the worktree`, isError: true };
          if (!norm.startsWith(".machine_code/issues/") || !norm.endsWith(".md")) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: only legal .machine_code/issues/ dirs from issueDir`, isError: true };
          }
          const dir = dirname(norm);
          if (!legalIssueDirs((ctx.repoRoot ?? ctx.root)).has(dir)) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: ${dir} is not a legal issueDir`, isError: true };
          }
          const byPath = listIssues(l).find((entry) => entry.rel === norm);
          if (!byPath) return { text: `issue not found: ${pathRaw}`, isError: true };
          if (slug && byPath.slug !== slug) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: does not match slug ${slug}`, isError: true };
          }
          slug = byPath.slug;
        }
        const issue = findIssue(l, slug);
        if (!issue) return { text: `issue not found: ${slug}`, isError: true };
        if (ctx.issuePath && issue.rel === ctx.issuePath) {
          return { text: `refusing to update the run's own issue (${issue.rel}); the harness owns its status`, isError: true };
        }
        const statusRaw = asString(args.status);
        if (statusRaw && !legalStatus(issue.kind, statusRaw)) {
          return { text: `bad status ${JSON.stringify(statusRaw)} for ${issue.kind}`, isError: true };
        }
        const verificationRaw = asString(args.verification);
        if (verificationRaw && verificationRaw !== "direct" && verificationRaw !== "verified") {
          return { text: "--verification must be direct|verified", isError: true };
        }
        const reviewRaw = asString(args.review);
        if (reviewRaw && reviewRaw !== "none" && reviewRaw !== "human") {
          return { text: "--review must be none|human", isError: true };
        }
        try {
          let current = issue.slug;
          const hasContents =
            args.prompt !== undefined ||
            args.priority !== undefined ||
            args.tags !== undefined ||
            args.depends !== undefined ||
            args.files !== undefined ||
            args.acceptance !== undefined ||
            args.keywords !== undefined ||
            verificationRaw !== undefined ||
            reviewRaw !== undefined;
          if (hasContents) {
            const updated = updateIssueContents(l, current, {
              prompt: asString(args.prompt) ?? issue.body,
              ...(args.priority !== undefined ? { priority: asString(args.priority) ?? "" } : {}),
              ...(args.tags !== undefined ? { tags: asList(args.tags) ?? [] } : {}),
              ...(args.depends !== undefined ? { depends: asList(args.depends) ?? [] } : {}),
              ...(args.files !== undefined ? { files: asList(args.files) ?? [] } : {}),
              ...(args.acceptance !== undefined ? { acceptance: asList(args.acceptance) ?? [] } : {}),
              ...(args.keywords !== undefined ? { keywords: asList(args.keywords) ?? [] } : {}),
              ...(verificationRaw ? { verification: verificationRaw as "direct" | "verified" } : {}),
              ...(reviewRaw ? { review: reviewRaw as "none" | "human" } : {}),
            });
            if (!updated) return { text: `issue not found: ${slug}`, isError: true };
          }
          const commitRaw = asString(args.commit);
          const branchRaw = asString(args.branch);
          if (commitRaw !== undefined || branchRaw !== undefined) {
            const updated = updateIssueMeta(l, current, {
              ...(commitRaw !== undefined ? { commit: commitRaw } : {}),
              ...(branchRaw !== undefined ? { branch: branchRaw } : {}),
            });
            if (!updated) return { text: `issue not found: ${slug}`, isError: true };
          }
          if (statusRaw && statusRaw !== issue.status) {
            const moved = moveIssue(l, current, statusRaw as IssueStatus);
            if (!moved) return { text: `issue not found: ${slug}`, isError: true };
            recordChangedIssue(ctx, moved.rel);
            return { text: `updated ${moved.rel}`, isError: false };
          }
          const refreshed = findIssue(l, current);
          if (refreshed) recordChangedIssue(ctx, refreshed.rel);
          return { text: `updated ${refreshed ? refreshed.rel : current}`, isError: false };
        } catch (error) {
          return { text: (error as Error).message, isError: true };
        }
      },
    },
    {
      name: "issue:delete",
      description:
        "Delete one issue file. Neither research nor engineer roles may call this in normal work. Rejects bad paths.",
      binary: "fs",
      args: () => [],
      schema: {
        slug: { type: "string", description: "Issue slug." },
        path: { type: "string", description: "Explicit repo-relative issue path. Must be a legal issueDir path." },
      },
      readonly: false,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const l = layout((ctx.repoRoot ?? ctx.root));
        const slugRaw = asString(args.slug);
        const pathRaw = asString(args.path);
        if (!slugRaw && !pathRaw) return { text: "issue:delete requires slug or path", isError: true };
        let slug = slugRaw ? slugify(slugRaw) : "";
        if (pathRaw) {
          const norm = normalizeRel(pathRaw);
          if (!safeIssuePath(l, norm)) return { text: `bad path ${JSON.stringify(pathRaw)}: escapes the worktree`, isError: true };
          if (!norm.startsWith(".machine_code/issues/") || !norm.endsWith(".md")) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: only legal .machine_code/issues/ dirs from issueDir`, isError: true };
          }
          const dir = dirname(norm);
          if (!legalIssueDirs((ctx.repoRoot ?? ctx.root)).has(dir)) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: ${dir} is not a legal issueDir`, isError: true };
          }
          const byPath = listIssues(l).find((entry) => entry.rel === norm);
          if (!byPath) return { text: `issue not found: ${pathRaw}`, isError: true };
          if (slug && byPath.slug !== slug) {
            return { text: `bad path ${JSON.stringify(pathRaw)}: does not match slug ${slug}`, isError: true };
          }
          slug = byPath.slug;
        }
        const issue = findIssue(l, slug);
        if (!issue) return { text: `issue not found: ${slug}`, isError: true };
        if (ctx.issuePath && issue.rel === ctx.issuePath) {
          return { text: `refusing to delete the run's own issue (${issue.rel})`, isError: true };
        }
        rmSync(issue.path, { force: true });
        recordChangedIssue(ctx, issue.rel);
        return { text: `deleted ${issue.rel}`, isError: false };
      },
    },
  ];
}
