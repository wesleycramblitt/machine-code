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

  // reference:search — DuckDuckGo HTML search (no API key).
  out.set("reference:search", {
    name: "reference:search",
    description: "Web search via DuckDuckGo (no API key). Returns top result titles/URLs.",
    binary: "node",
    args: () => [],
    schema: { query: { type: "string", required: true, description: "Search query." } },
    readonly: true,
    timeoutMs: 30_000,
    handler: async (args) => {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query) return { text: "reference:search requires query", isError: true };
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "machine_code/0.0.0" } });
        if (!r.ok) return { text: `search failed: HTTP ${r.status}`, isError: true };
        const html = await r.text();
        // Extract result links: <a class="result__a" href="...">title</a>
        const results: string[] = [];
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null && results.length < 10) {
          const href = (m[1] ?? "").replace(/.*uddg=/, "").split("&")[0] ?? "";
          const title = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
          try { results.push(`${title}\n  ${decodeURIComponent(href)}`); } catch { results.push(`${title}\n  ${href}`); }
        }
        if (results.length === 0) return { text: "no results (or blocked)", isError: false };
        return { text: results.join("\n\n"), isError: false };
      } catch (e) {
        return { text: `search failed: ${(e as Error).message}`, isError: true };
      }
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
      const home = process.env.MACHINE_CODE_HOME ?? join(process.env.HOME ?? "", ".machine_code");
      const repoRef = join(ctx.root, ".machine_code", "references");
      const machineRef = join(home, "references");
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

  return out;
}
