/**
 * machine_code — reference verification gate.
 *
 * A deterministic gate for reference runs: checks that the run wrote at
 * least one bundle file to the central store, that each touched bundle has
 * a manifest, that content files carry front-matter and stable anchors, and
 * that the store index has no drift. Reference writes are tracked in the run
 * dir (the store lives outside git, so no git check can see them).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CommandSpec } from "./registry.js";
import { layout } from "../paths.js";
import { referenceStore, reindexReferences } from "../references/store.js";

export interface ReferenceValidation {
  ok: boolean;
  errors: string[];
  bundles: string[];
}

/** Bundle-level files live at the bundle root (flat) or version root. */
const BUNDLE_FILES = new Set(["index.md", "manifest.yaml", "api-index.md", "topics.yaml"]);

/** Bundle key for a store-relative path: product/version or flat product. */
export function bundleOf(rel: string): string | null {
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) return null;
  if (parts.length === 1) return parts[0]!;
  // `<product>/index.md` is the flat bundle's topic map, not a version dir.
  if (parts.length === 2 && BUNDLE_FILES.has(parts[1]!)) return parts[0]!;
  return `${parts[0]}/${parts[1]}`;
}

/** Pure store-shape validation, independent of runs or git. Testable. */
export function validateReferenceFiles(storeRoot: string, rels: string[]): ReferenceValidation {
  const errors: string[] = [];
  const bundles = new Set<string>();
  const seen = new Set<string>();
  for (const rel of rels) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolve(storeRoot, rel);
    if (abs !== storeRoot && !abs.startsWith(storeRoot + sep)) {
      errors.push(`${rel}: path escapes the reference store`);
      continue;
    }
    if (!existsSync(abs)) {
      errors.push(`${rel}: not found in the store (moved or deleted mid-run?)`);
      continue;
    }
    const bundle = bundleOf(rel);
    if (!bundle) {
      errors.push(`${rel}: cannot determine a bundle`);
      continue;
    }
    bundles.add(bundle);
    if (rel.endsWith(".md") && rel.includes("/content/")) {
      let text = "";
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        errors.push(`${rel}: unreadable`);
        continue;
      }
      if (!text.startsWith("---")) {
        errors.push(`${rel}: missing front-matter (topics, symbols, tokens)`);
      }
      if (!/\{#([A-Za-z0-9._-]+)\}/.test(text)) {
        errors.push(`${rel}: no stable {#anchor} heading`);
      }
    }
  }
  for (const bundle of bundles) {
    if (!existsSync(join(storeRoot, bundle, "manifest.yaml"))) {
      errors.push(`${bundle}: missing manifest.yaml (provenance + status required)`);
    }
  }
  return { ok: errors.length === 0, errors, bundles: [...bundles].sort() };
}

export const referenceVerifyCommand: CommandSpec = {
  name: "reference:verify",
  description:
    "Verify that a reference run wrote at least one bundle file to the central store, " +
    "that each touched bundle has a manifest, that content files carry front-matter and " +
    "stable anchors, and that the store index has no drift.",
  binary: "node",
  args: () => [],
  schema: {},
  readonly: true,
  timeoutMs: 120_000,
  handler: async (_args, ctx) => {
    try {
      const store = referenceStore(layout(ctx.repoRoot ?? ctx.root));
      let tracked: string[] = [];
      if (ctx.runDir) {
        const log = join(ctx.runDir, "references-changed.json");
        if (existsSync(log)) {
          try {
            const parsed: unknown = JSON.parse(readFileSync(log, "utf8"));
            if (Array.isArray(parsed)) {
              tracked = parsed.filter((e): e is string => typeof e === "string");
            }
          } catch {
            tracked = [];
          }
        }
      }
      if (tracked.length === 0) {
        return {
          text: "reference:verify failed — no reference:write calls logged this run (write via reference:write, never raw paths)",
          isError: true,
        };
      }
      const validation = validateReferenceFiles(store, tracked);
      if (!validation.ok) {
        return {
          text: `reference:verify failed — store shape problems (fix with reference:write, never raw paths):\n${validation.errors.join("\n")}`,
          isError: true,
        };
      }
      const reindexed = reindexReferences(layout(ctx.repoRoot ?? ctx.root), true);
      if (/failed|not found|required/i.test(reindexed)) {
        return {
          text: `reference:verify failed — index drift (run reference:reindex, fix, re-verify):\n${reindexed}`,
          isError: true,
        };
      }
      return {
        text: `reference:verify passed — bundle(s) ${validation.bundles.join(", ")}:\n${tracked.join("\n")}`,
        isError: false,
      };
    } catch (error) {
      return {
        text: `reference:verify error: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
