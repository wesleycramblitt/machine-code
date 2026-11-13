/**
 * machine_code — reference commands (M5).
 *
 * Typed, path-scoped commands for the reference skill: web fetch, PDF
 * extraction, bundle indexing, and (best-effort) web search. The index writer
 * may only touch ~/.machine_code/references/ and .machine_code/references/links.toml.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CommandSpec, CommandContext, CommandRunResult } from "./registry.js";
import type { Layout } from "../paths.js";
import { findReferences, readReference, referenceStore, reindexReferences, writeReference } from "../references/store.js";

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
    description: "Write a reference bundle (markdown with front-matter) to the scoped reference directory. Only writes under ~/.machine_code/references/ or .machine_code/references/.",
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
      const repoRef = join(ctx.root, ".machine_code", "references");
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
      // Update links.toml if writing to repo refs.
      if (root === repoRef) {
        const linksFile = join(ctx.root, ".machine_code", "references", "links.toml");
        if (!existsSync(linksFile)) {
          mkdirSync(dirname(linksFile), { recursive: true });
          writeFileSync(linksFile, "# machine_code reference links\n", "utf8");
        }
      }
      return { text: `indexed: ${target}`, isError: false };
    },
  });

  // reference:find — search the cheap index layer (catalog/topics/api-index).
  out.set("reference:find", {
    name: "reference:find",
    description: "Find reference bundles or exact content/file#anchor citations from the store's index.md, topics.yaml, and api-index.md. Never searches content or raw files.",
    binary: "node",
    args: () => [],
    schema: {
      query: { type: "string", required: true, description: "Topic, symbol, product, or phrase." },
      limit: { type: "number", description: "Max index matches (default 20)." },
    },
    readonly: true,
    timeoutMs: 30_000,
    handler: async (args) => {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return { text: "reference:find requires query", isError: true };
      const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit ?? 20))));
      return { text: findReferences(layout, query, limit), isError: false };
    },
  });

  // reference:read — read one cited content file and optional anchor.
  out.set("reference:read", {
    name: "reference:read",
    description: "Read exactly one store citation, e.g. 'glsl/4.60.8/content/glsl-8-3-common-functions.md#8-3-common-functions'. Rejects raw/ and paths outside the store.",
    binary: "node",
    args: () => [],
    schema: {
      path: { type: "string", required: true, description: "Store-relative path or bundle key, with optional #anchor." },
      limit: { type: "number", description: "Max bytes returned (default 12 KiB)." },
    },
    readonly: true,
    timeoutMs: 30_000,
    handler: async (args) => {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path.trim()) return { text: "reference:read requires path", isError: true };
      const cap = Math.max(1_024, Math.min(64 * 1_024, Math.floor(Number(args.limit ?? 12 * 1_024))));
      const result = readReference(layout, path, cap);
      if (!result.ok) return { text: result.error, isError: true };
      const citation = `${result.path}${result.anchor ? `#${result.anchor}` : ""}`;
      return { text: `${citation}\n\n${result.text}`, isError: false };
    },
  });

  // reference:write — create one bundle file under the store or project view.
  out.set("reference:write", {
    name: "reference:write",
    description: "Write one file under the reference store (default) or project view. Use for manifest.yaml, content/*.md, index.md, and links.yaml. Run reference:reindex afterwards.",
    binary: "node",
    args: () => [],
    schema: {
      path: { type: "string", required: true, description: "Path relative to the store or project view." },
      content: { type: "string", required: true, description: "File content." },
      scope: { type: "string", description: "store (default) or project." },
    },
    readonly: false,
    timeoutMs: 30_000,
    handler: async (args) => {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!path.trim() || !content) return { text: "reference:write requires path and content", isError: true };
      const scope = args.scope === "project" ? "project" : "store";
      const result = writeReference(layout, path, content, scope);
      if (!result.ok) return { text: result.error, isError: true };
      return { text: `wrote: ${result.path}\nNext: run reference:reindex.`, isError: false };
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
    handler: async (args) => {
      const result = reindexReferences(layout, args.check === true);
      return { text: result, isError: /failed|not found|required/i.test(result) };
    },
  });

  return out;
}
