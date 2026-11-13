/**
 * Named code blocks — a JSON-free escape hatch for tool call arguments.
 *
 * The model writes code with backslashes/backticks/quotes as plain fenced
 * blocks in its response text, then tools reference those blocks by name.
 * The harness extracts the blocks and writes them to scratch files before
 * any tool executes.
 *
 * Syntax:
 *   ```block-name
 *   ...code (no escaping needed)...
 *   ```
 *
 *   ```json
 *   {"action": "edit", "newString_named_block": "block-name"}
 *   ```
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** A named block extracted from assistant text. */
export interface NamedBlock {
  name: string;
  content: string;
}

/**
 * Extract all named fenced code blocks from assistant response text.
 * Matches ```<name> ... ``` where <name> is a non-empty word that is not
 * a known language identifier (json, typescript, javascript, ts, js, bash, sh,
 * diff, text, md, markdown, yaml, toml, css, html, xml, svg, python, py, go,
 * rust, rs, cpp, c, h, hpp, java, kt, sql, graphql, dockerfile, makefile,
 * elixir, ex, exs, ruby, rb).
 */
export function extractNamedBlocks(text: string): NamedBlock[] {
  const blocks: NamedBlock[] = [];
  // Matches ```<name> ... ``` where <name> is a non-empty word on the fence line
  const fenceRe = /^```(\S+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const name = match[1]!.trim();
    if (!name) continue;
    // Skip known language identifiers — those are syntax highlighting, not named blocks
    if (LANGUAGE_IDS.has(name)) continue;
    const start = match.index;
    const afterFence = match.index + match[0].length;
    // Find the closing fence
    const closeRe = /^```\s*$/gm;
    closeRe.lastIndex = afterFence;
    const close = closeRe.exec(text);
    if (!close) break; // Unterminated fence — stop looking
    const content = text.slice(afterFence, close.index).replace(/\n$/, "");
    blocks.push({ name, content });
    // Continue after the closing fence
    fenceRe.lastIndex = close.index + close[0].length;
  }
  return blocks;
}

/**
 * Write extracted named blocks to scratch files in the given directory.
 * Returns a map of block name → file path.
 */
export function writeNamedBlocks(
  blocks: NamedBlock[],
  blocksDir: string,
): Map<string, string> {
  const paths = new Map<string, string>();
  if (blocks.length === 0) return paths;
  mkdirSync(blocksDir, { recursive: true });
  for (const block of blocks) {
    const filePath = join(blocksDir, sanitizeName(block.name));
    writeFileSync(filePath, block.content, "utf8");
    paths.set(block.name, filePath);
  }
  return paths;
}

/** Sanitize a block name for use as a filename — alphanumeric, dash, underscore only. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Set of known language identifiers that are used for syntax highlighting, not named blocks. */
const LANGUAGE_IDS = new Set([
  "json",
  "typescript",
  "javascript",
  "ts",
  "js",
  "bash",
  "sh",
  "diff",
  "text",
  "md",
  "markdown",
  "yaml",
  "toml",
  "css",
  "html",
  "xml",
  "svg",
  "python",
  "py",
  "go",
  "rust",
  "rs",
  "cpp",
  "c",
  "h",
  "hpp",
  "java",
  "kt",
  "sql",
  "graphql",
  "dockerfile",
  "makefile",
  "elixir",
  "ex",
  "exs",
  "ruby",
  "rb",
  "php",
  "scala",
  "swift",
  "zig",
  "nim",
  "lua",
  "r",
  "dart",
  "gradle",
  "properties",
  "env",
  "ignore",
  "gitignore",
  "prettierrc",
  "eslintrc",
]);
