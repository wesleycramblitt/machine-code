/**
 * machine_code — reference commands (M5).
 *
 * Typed, path-scoped commands for the reference skill: web fetch, PDF
 * extraction, bundle indexing, and (best-effort) web search. The index writer
 * may only touch ~/.machine_code/references/ and references/.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { CommandSpec, CommandContext, CommandRunResult } from "./registry.js";
import type { Layout } from "../paths.js";
import { findReferences, readReference, referenceStore, referenceView, reindexReferences, writeReference } from "../references/store.js";

/** Append a store-relative rel to the run's changed-reference log for reference:verify. */
function recordChangedReference(
  ctx: { runDir?: string },
  absPath: string,
  layout: Layout,
  projectRoot: string,
): void {
  if (!ctx.runDir || !absPath) return;
  const store = referenceStore(layout);
  let rel: string | null = null;
  if (absPath === store || absPath.startsWith(store + "/")) {
    rel = relative(store, absPath);
  } else {
    const view = referenceView(layout, projectRoot);
    if (absPath === view || absPath.startsWith(view + "/")) rel = relative(view, absPath);
  }
  if (!rel) return;
  const file = join(ctx.runDir, "references-changed.json");
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

export function referenceCommands(layout: Layout): Map<string, CommandSpec> {
  const out = new Map<string, CommandSpec>();

  // reference:browser — fetch a URL and return its text (capped).
  out.set("reference:browser", {
    name: "reference:browser",
    description: "Fetch a URL and return its text content (capped at 12 KiB).",
    binary: "node",
    args: () => [],
    schema: { url: { type: "string", required: true, description: "URL to fetch." } },
    readonly: true,
    timeoutMs: 60_000,
    handler: async (args) => {
      const url = typeof args.url === "string" ? args.url : "";
      if (!url) return { text: "reference:fetch requires url", isError: true };
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "machine_code/0.0.0" } });
        if (!r.ok) return { text: `fetch failed: HTTP ${r.status}`, isError: true };
        const text = await r.text();
        const capped = text.length > 12_000 ? text.slice(0, 12_000) + "\n[truncated]" : text;
        return { text: capped, isError: false };
      } catch (e) {
        return { text: `fetch failed: ${(e as Error).message}`, isError: true };
      }
    },
  });

  // reference:pdf-extract — pdftotext on a PDF.
  out.set("reference:pdf-extract", {
    name: "reference:pdf-extract",
    description: "Extract text from a PDF (pdftotext). Returns capped text.",
    binary: "pdftotext",
    args: (a) => ["-layout", String(a.path ?? ""), "-"],
    schema: {
      path: { type: "string", required: true, description: "Path to the PDF (relative to worktree)." },
    },
    readonly: true,
    timeoutMs: 120_000,
    handler: async (args, ctx) => {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) return { text: "reference:pdf-extract requires path", isError: true };
      const abs = resolve(ctx.root, path);
      if (!existsSync(abs)) return { text: `no such file: ${path}`, isError: true };
      const result = spawnSync("pdftotext", ["-layout", abs, "-"], { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      if (result.status !== 0) return { text: `pdftotext failed: ${result.stderr?.trim() || result.error?.message}`, isError: true };
      const text = (result.stdout ?? "").trim();
      const capped = text.length > 12_000 ? text.slice(0, 12_000) + "\n[truncated]" : text;
      return { text: capped || "(no text extracted)", isError: false };
    },
  });

  // reference:index — write a bundle to the scoped reference dir.
  out.set("reference:index", {
    name: "reference:index",
    description: "Write a reference bundle (markdown with front-matter) to the scoped reference directory. Only writes under ~/.machine_code/references/ or references/.",
    binary: "node",
    args: () => [],
    schema: {
      path: { type: "string", required: true, description: "Destination path under the reference dir (e.g. 'topic/bundle.md')." },
      content: { type: "string", required: true, description: "Bundle markdown content." },
    },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const rel = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!rel || !content) return { text: "reference:index requires path and content", isError: true };
      // Determine the reference root: machine-wide or repo.
      const repoRef = join(ctx.root, "references");
      const machineRef = referenceStore(layout);
      // Allow writes only under these two roots.
      const roots = [repoRef, machineRef];
      // Pick the root based on the path prefix.
      let root = repoRef;
      let sub = rel;
      if (rel.startsWith("~") || rel.startsWith("machine:")) {
        root = machineRef;
        sub = rel.replace(/^~\//, "").replace(/^machine:/, "").replace(/^\//, "");
      }
      const target = resolve(root, sub);
      if (!roots.some((r) => target === r || target.startsWith(r + "/"))) {
        return { text: "reference:index: path escapes the reference directory", isError: true };
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      // Update links.yaml if writing to repo refs.
      if (root === repoRef) {
        const linksFile = join(ctx.root, "references", "links.yaml");
        if (!existsSync(linksFile)) {
          mkdirSync(dirname(linksFile), { recursive: true });
          writeFileSync(linksFile, `store: ${referenceStore(layout)}\nlinks: []\n`, "utf8");
        }
      }
      const reindexed = reindexReferences(layout, false, ctx.root);
      return { text: `indexed: ${target}\n${reindexed}`, isError: /failed|not found|required/i.test(reindexed) };
    },
  });

  // reference:find — search the index layer, and on demand bundle content/code.
  out.set("reference:find", {
    name: "reference:find",
    description: "Find reference bundles or exact content/file#anchor citations. Index tier (default): scans api-index.md, index.md, topics.yaml — never content or raw files. Deeper tiers need bundle: ('product' or 'product/version'): content: searches content/** bodies, code: searches non-index bundle files like vendored source repos. raw/ and .git/ are never searched.",
    binary: "node",
    args: () => [],
    schema: {
      query: { type: "string", required: true, description: "Topic, symbol, product, or phrase. Raw regex when regex: is set (content/code tiers)." },
      limit: { type: "number", description: "Max index matches (default 20)." },
      bundle: { type: "string", description: "Scope to one bundle, e.g. 'minecraft-java/26.3'. Required for content:/code:." },
      content: { type: "boolean", description: "Also search content/** bodies in the bundle." },
      code: { type: "boolean", description: "Also search non-index bundle files (source repos, data)." },
      tier: { type: "string", description: "Shorthand for the tiers: 'content', 'code', or 'all'. Equivalent to the content:/code: flags." },
      regex: { type: "boolean", description: "Treat query as a raw regex for the content/code tiers." },
    },
    readonly: true,
    timeoutMs: 60_000,
    handler: async (args, ctx) => {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return { text: "reference:find requires query", isError: true };
      const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit ?? 20))));
      const bundle = typeof args.bundle === "string" && args.bundle.trim() ? args.bundle.trim() : undefined;
      const tier = typeof args.tier === "string" ? args.tier.trim().toLowerCase() : "";
      if (tier && !["content", "code", "all", "both", "index"].includes(tier)) {
        return { text: `reference:find: unknown tier '${args.tier}'. Use tier 'content', 'code', or 'all'.`, isError: true };
      }
      const content = args.content === true || tier === "content" || tier === "all" || tier === "both";
      const code = args.code === true || tier === "code" || tier === "all" || tier === "both";
      return {
        text: findReferences(layout, query, limit, ctx.root, {
          ...(bundle ? { bundle } : {}),
          ...(content ? { content: true } : {}),
          ...(code ? { code: true } : {}),
          ...(args.regex === true ? { regex: true } : {}),
        }),
        isError: false,
      };
    },
  });

  // reference:read — read one cited content file and optional anchor.
  out.set("reference:read", {
    name: "reference:read",
    description: "Read exactly one store citation: pass the full citation reference:find returned as path= (e.g. 'glsl/4.60.8/content/glsl-8-3-common-functions.md#8-3-common-functions'). The bundle:/content:/code: selectors live on reference:find, not here. A bundle or content directory reads as a capped listing (discovery). outline: lists headings+anchors; offset:/lines: page long files. Rejects raw/ and paths outside the store.",
    binary: "node",
    args: () => [],
    schema: {
      path: { type: "string", required: true, description: "Store-relative path, bundle key, or directory, with optional #anchor." },
      query: { type: "string", description: "Alias for path; agents commonly cite with query=." },
      limit: { type: "number", description: "Max bytes returned (default 12 KiB)." },
      offset: { type: "number", description: "1-based first line of the body (file or anchored section)." },
      lines: { type: "number", description: "Max lines from offset. Byte cap still applies." },
      outline: { type: "boolean", description: "List headings with their #anchors instead of body text." },
    },
    readonly: true,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const path = typeof args.query === "string" ? args.query : typeof args.path === "string" ? args.path : "";
      if (!path.trim()) return { text: "reference:read requires path", isError: true };
      const cap = Math.max(1_024, Math.min(64 * 1_024, Math.floor(Number(args.limit ?? 12 * 1_024))));
      const readOpts: { offset?: number; lines?: number; outline?: boolean } = {};
      if (args.offset !== undefined) {
        const offset = Math.floor(Number(args.offset));
        if (!Number.isFinite(offset) || offset < 1) return { text: "reference:read requires offset >= 1", isError: true };
        readOpts.offset = offset;
      }
      if (args.lines !== undefined) {
        const lines = Math.floor(Number(args.lines));
        if (!Number.isFinite(lines) || lines < 1) return { text: "reference:read requires lines >= 1", isError: true };
        readOpts.lines = lines;
      }
      if (args.outline === true) readOpts.outline = true;
      const result = readReference(layout, path, cap, ctx.root, readOpts);
      if (!result.ok) return { text: result.error, isError: true };
      const citation = `${result.path}${result.anchor ? `#${result.anchor}` : ""}`;
      return { text: `${citation}\n\n${result.text}`, isError: false };
    },
  });

  // reference:write — create one bundle file under the store or project view.
  out.set("reference:write", {
    name: "reference:write",
    description: "Write one file under the project view (default, local references/) or the machine reference store. Use for manifest.yaml, content/*.md, index.md, and links.yaml. Regenerates the index afterwards.",
    binary: "node",
    args: () => [],
    schema: {
      path: { type: "string", required: true, description: "Path relative to the store or project view." },
      content: { type: "string", required: true, description: "File content." },
      scope: { type: "string", description: "project (default) or store." },
    },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args, ctx) => {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!path.trim() || !content) return { text: "reference:write requires path and content", isError: true };
      const scope = args.scope === "store" ? "store" : "project";
      const result = writeReference(layout, path, content, scope, ctx.root);
      if (!result.ok) return { text: result.error, isError: true };
      recordChangedReference(ctx, result.path, layout, ctx.root);
      const reindexed = reindexReferences(layout, false, ctx.root);
      return { text: `wrote: ${result.path}\n${reindexed}`, isError: /failed|not found|required/i.test(reindexed) };
    },
  });

  // reference:reindex — regenerate catalog, topics, and api-index files.
  out.set("reference:reindex", {
    name: "reference:reindex",
    description: "Regenerate the store catalog/topics/api-index and any project view from links.yaml. Requires python3 + PyYAML and reference-index.py.",
    binary: "node",
    args: () => [],
    schema: {
      check: { type: "boolean", description: "Check for drift without writing." },
    },
    readonly: false,
    timeoutMs: 120_000,
    handler: async (args, ctx) => {
      const result = reindexReferences(layout, args.check === true, ctx.root);
      return { text: result, isError: /failed|not found|required/i.test(result) };
    },
  });

  return out;
}
