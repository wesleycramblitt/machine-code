/**
 * machine_code — issue artifact references (`mc:context`) + skill front matter.
 *
 * Issues stay concise and point at repository artifacts:
 *
 *   <!-- mc:context
 *   {"packets":["20261031-thermal"],"files":["src/parser.ts"],
 *    "knowledge":["knowledge/thermal.md"],"skills":["reference"],
 *    "tools":["bench"],"scripts":["release-check"]}
 *   -->
 *
 * `knowledge` remains an alias for reference material; `files` names source
 * files that matter to the issue. Unknown keys are ignored; missing paths
 * become manifest warnings.
 */
export interface ArtifactReferences {
  packets: string[];
  files: string[];
  knowledge: string[];
  skills: string[];
  tools: string[];
  scripts: string[];
}

const EMPTY: ArtifactReferences = {
  packets: [],
  files: [],
  knowledge: [],
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
