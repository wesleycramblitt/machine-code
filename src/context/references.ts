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
