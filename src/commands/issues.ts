/**
 * machine_code — issue commands: list and show issue files.
 *
 * Gives the agent a simple, typed way to discover and read issues without
 * using inspect or glob. The research workflow already has the active issue
 * in context — these commands are for finding sibling issues, reading the
 * full body of a referenced issue, and discovering what exists.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandSpec } from "./registry.js";

const ISSUE_DIRS = [
  "issues/ideas",
  "issues/ideas/.researched",
  "issues/features/todo",
  "issues/features/blocked",
  "issues/features/done",
  "issues/bugs/todo",
  "issues/bugs/blocked",
  "issues/bugs/done",
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
        status: { type: "string", description: "Filter: todo | blocked | done | researched (default all)." },
      },
      readonly: true,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const kindFilter = (args.kind as string | undefined)?.trim();
        const statusFilter = (args.status as string | undefined)?.trim();
        const lines: string[] = [];

        for (const dir of ISSUE_DIRS) {
          // Derive kind/status from directory path
          const parts = dir.replace("issues/", "").split("/");
          const kind = parts[0]!;
          const status = parts.length > 1 ? parts[1]! : kind === "ideas" ? "needs-research" : "todo";

          if (kindFilter && kind !== kindFilter) continue;
          if (statusFilter && status !== statusFilter) continue;

          const fullDir = join(ctx.root, dir);
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
            const issuePath = join(ctx.root, dir, `${slug}.md`);
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
        path: { type: "string", description: "Explicit repo-relative path (issues/.../slug.md). Overrides slug." },
      },
      readonly: true,
      timeoutMs: 10_000,
      handler: async (args, ctx) => {
        const slug = (args.slug as string | undefined)?.trim();
        const path = (args.path as string | undefined)?.trim();

        let issuePath: string | null = null;
        let issueText: string | null = null;

        if (path) {
          const full = join(ctx.root, path);
          if (!existsSync(full)) return { text: `file not found: ${path}`, isError: true };
          issuePath = path;
          issueText = readFileSync(full, "utf8");
        } else if (slug) {
          const found = findIssueFile(ctx.root, slug);
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
  ];
}