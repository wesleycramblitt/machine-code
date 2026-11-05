/**
 * machine_code — issue artifact references (`mc:context`) + skill front matter.
 *
 * Issues stay concise and point at repository artifacts:
 *
 *   <!-- mc:context
 *   {"packets":["20261031-thermal"],"files":["src/parser.ts"],
 *    "knowledge":["knowledge/thermal.md"],"skills":["reference"],
 *    "references":["glsl/4.60.8/content/glsl-8-3-common-functions.md#8-3-common-functions"],
 *    "tools":["bench"],"scripts":["release-check"]}
 *   -->
 *
 * `knowledge` remains an alias for repository reference material; `files`
 * names source files that matter to the issue; `references` names exact
 * citations in the central `~/.machine_code/references/` store. Unknown keys
 * are ignored; missing paths become manifest warnings.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";

export interface ArtifactReferences {
  packets: string[];
  files: string[];
  knowledge: string[];
  /** Exact central-store citations: `product/version/content/file.md#anchor`. */
  references: string[];
  skills: string[];
  tools: string[];
  scripts: string[];
}

const EMPTY: ArtifactReferences = {
  packets: [],
  files: [],
  knowledge: [],
  references: [],
  skills: [],
  tools: [],
  scripts: [],
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseArtifactReferences(body: string): ArtifactReferences {
  const match = body.match(/<!--\s*mc:context\s*([\s\S]*?)-->/);
  if (!match) return { ...EMPTY };
  try {
    const raw = JSON.parse(match[1]!.trim()) as Record<string, unknown>;
    return {
      packets: strings(raw.packets),
      files: strings(raw.files),
      knowledge: strings(raw.knowledge),
      references: strings(raw.references ?? raw.reference),
      skills: strings(raw.skills),
      tools: strings(raw.tools),
      scripts: strings(raw.scripts),
    };
  } catch {
    return { ...EMPTY };
  }
}

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/** Parse the simple YAML front matter used by SKILL.md files. */
export function parseSkillFrontMatter(text: string, path: string): SkillMeta | null {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (!meta.name) return null;
  return { name: meta.name, description: meta.description ?? "", path };
}

/** Skill descriptions that are visible on every run (body loading is separate). */
export function skillMetas(layout: Layout): Array<{ name: string; description: string }> {
  const out = new Map<string, { name: string; description: string }>();
  for (const dir of [join(layout.home, "skills"), join(layout.repoDir, "skills")]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const meta = parseSkillFrontMatter(readFileSync(file, "utf8"), file);
      if (meta && !out.has(meta.name)) out.set(meta.name, { name: meta.name, description: meta.description });
    }
  }
  return [...out.values()];
}

/**
 * Per-skill context mode:
 * - include: description sent and the full SKILL.md body inlined (up to 8 KiB).
 * - on-demand: description sent; the agent pulls the body with the skill tool.
 * - exclude: skill is completely hidden (no description, no body, no pull).
 */
export type SkillMode = "include" | "on-demand" | "exclude";

export function isSkillMode(value: unknown): value is SkillMode {
  return value === "include" || value === "on-demand" || value === "exclude";
}

export interface SkillModeInput {
  /** Role preset table (`[skills]` in the role TOML), if any. */
  presets?: Record<string, string>;
  /** Agent mode defaults that inline bodies (from `defaultSkillsFor`). */
  defaults?: string[];
  /** Issue-declared skills (from `mc:context`). */
  declared?: string[];
  /** Composer/explicit per-skill overrides (highest precedence). */
  overrides?: Record<string, SkillMode>;
}

/**
 * Single precedence chain shared by assembly, preview, and the composer:
 * explicit overrides > role presets > issue-declared (include) >
 * agent defaults (include) > on-demand.
 */
export function resolveSkillMode(name: string, input: SkillModeInput = {}): SkillMode {
  const override = input.overrides?.[name];
  if (override !== undefined) return override;
  const preset = input.presets?.[name];
  if (isSkillMode(preset)) return preset;
  if (input.declared?.includes(name)) return "include";
  if (input.defaults?.includes(name)) return "include";
  return "on-demand";
}

/**
 * Mode default skills for a run, before issue-declared skills.
 *
 * `clean-code` rides every coding/planning run (build, planner, general,
 * sudo); `verified-testing` joins it when verification is verified or
 * higher. `safe-refactor` stays opt-in via `mc:context` on refactor issues.
 * Review is harness-owned (independent Review run), not a skill.
 */
export function defaultSkillsFor(args: { agent: string; verification?: string }): string[] {
  if (!["build", "planner", "general", "sudo"].includes(args.agent)) return [];
  const skills = ["clean-code"];
  if (args.verification === "verified" || args.verification === "redundant") {
    skills.push("verified-testing");
  }
  return skills;
}
