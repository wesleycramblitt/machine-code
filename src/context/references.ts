/**
 * machine_code — artifact references (`mc:context`) + skill front matter.
 *
 * Blocks stay concise and point at repository artifacts:
 *
 *   <!-- mc:context
 *   {"files":["src/parser.ts"],
 *    "knowledge":["knowledge/thermal.md"],"skills":["reference"],
 *    "references":["glsl/4.60.8/content/glsl-8-3-common-functions.md#8-3-common-functions"],
 *    "tools":["bench"],"scripts":["release-check"]}
 *   -->
 *
 * `knowledge` remains an alias for repository reference material; `files`
 * names source files that matter; `references` names exact
 * citations in the central `~/.machine_code/references/` store. Unknown keys
 * are ignored; missing paths become manifest warnings.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.js";

export interface ArtifactReferences {
  files: string[];
  knowledge: string[];
  /** Exact central-store citations: `product/version/content/file.md#anchor`. */
  references: string[];
  skills: string[];
  tools: string[];
  scripts: string[];
}

const EMPTY: ArtifactReferences = {
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
 * - include: description sent and the full SKILL.md body inlined.
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
  /** Declared skills (from `mc:context`). */
  declared?: string[];
  /** Composer/explicit per-skill overrides (highest precedence). */
  overrides?: Record<string, SkillMode>;
}

/**
 * Single precedence chain shared by assembly, preview, and the composer:
 * explicit overrides > role presets > declared (include) > on-demand.
 *
 * There is no "defaults include" tier: agent default skills (clean-code,
 * verified-testing) are description-only, listed in the skill index and
 * pulled on demand with the skill tool. Only an explicit composer include,
 * a role preset, or a declaration inlines a body.
 */
export function resolveSkillMode(name: string, input: SkillModeInput = {}): SkillMode {
  const override = input.overrides?.[name];
  if (override !== undefined) return override;
  const preset = input.presets?.[name];
  if (isSkillMode(preset)) return preset;
  if (input.declared?.includes(name)) return "include";
  return "on-demand";
}

export function defaultSkillsFor(args: { agent: string }): string[] {
  if (args.agent === "research") return ["clean-code", "plan-curation"];
  return [];
}

/**
 * Hot/cold tiering: description-only index blocks shared by assembly and
 * preview so measured chars match assembled chars.
 *
 * Tools, skills, and references load description-only by default; bodies
 * load only for explicit includes (composer `include.*`, or a skill mode of
 * include via role presets, declarations, or composer overrides). Each index
 * names its on-demand pull path: the `skill` tool (`show <name>`) for skill
 * bodies, the `command` tool (`describe <name>`) for full command schemas,
 * the `artifact` tool (`show <name>`) for tool/script detail, and the
 * `reference:find` / `reference:read` commands for store citations.
 */
export const SKILL_FETCH_HINT = "On-demand: pull a body with the skill tool (show <name>).";

export const TOOL_FETCH_HINT =
  "On-demand: full schema via the command tool (describe <name>); tool/script detail via the artifact tool (show <name>).";

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/** One-line `- name: description` skill index plus the on-demand pull hint. */
export function skillIndexBody(skills: ReadonlyArray<{ name: string; description: string }>): string {
  if (skills.length === 0) return "";
  return [...skills.map((skill) => `- ${skill.name}: ${skill.description}`), SKILL_FETCH_HINT].join("\n");
}

/** One-line `- name: description` command index plus the on-demand pull hint. */
export function toolIndexBody(commands: ReadonlyMap<string, { description: string }>): string {
  const specs = [...commands.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (specs.length === 0) return "";
  return [...specs.map(([name, spec]) => `- ${name}: ${firstLine(spec.description)}`), TOOL_FETCH_HINT].join("\n");
}
