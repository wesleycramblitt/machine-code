/**
 * machine_code — synchronous context preview for the TUI.
 *
 * This is deliberately not `assembleContext`: the draw path must never block
 * on a slow filesystem. It derives the packet contract and configured
 * defaults, which is enough to show what a run will inherit before it starts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";
import { artifactPath, listArtifacts, type ArtifactDef } from "../artifacts/registry.js";
import { resolveSkillMode, skillMetas, type SkillMode } from "./references.js";

export interface PreviewSource {
  kind: "file" | "knowledge" | "reference" | "skill" | "tool" | "script" | "plan" | "project" | "packet";
  ref: string;
  origin: "explicit" | "inherited";
  depth: number;
  chars: number;
  exists: boolean;
  note?: string;
}

export interface ContextPreview {
  chars: number;
  promptChars: number;
  sources: PreviewSource[];
  issueChain: [];
  artifacts: {
    files: string[];
    knowledge: string[];
    references: string[];
    skills: string[];
    tools: ArtifactDef[];
    scripts: ArtifactDef[];
  };
  warnings: string[];
}

function capFor(file: string, cap: number): number {
  try {
    return Math.min(cap, statSync(file).size);
  } catch {
    return 0;
  }
}

function skillPath(layout: Layout, name: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  for (const dir of [join(layout.repoDir, "skills", name), join(layout.home, "skills", name)]) {
    const file = join(dir, "SKILL.md");
    if (existsSync(file)) return file;
  }
  return null;
}

export interface PreviewContextOptions {
  /** Role name; the plan map is inherited only by the planner. */
  agent?: string;
  /** Packet slug attached in the composer; its contract is explicit context. */
  packet?: string;
  planFile?: string;
  knowledgeIndex?: string;
  /** Explicit repo-relative files selected in the composer. */
  files?: string[];
  /** Mode default skills (e.g. from `defaultSkillsFor`); missing ones are skipped silently. */
  defaultSkills?: string[];
  /** Role `[skills]` preset table (from the agent's role TOML). */
  skillPresets?: Record<string, string>;
  /** Composer per-skill mode overrides (highest precedence). */
  skillOverrides?: Record<string, SkillMode>;
}

export function previewContext(
  layout: Layout,
  prompt = "",
  options: PreviewContextOptions = {},
): ContextPreview {
  const sources: PreviewSource[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  const knowledge: string[] = [];
  const references: string[] = [];
  const skills: string[] = [];
  const tools: ArtifactDef[] = [];
  const scripts: ArtifactDef[] = [];
  let chars = 0;

  for (const path of options.files ?? []) {
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, path);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    chars += size;
    sources.push({ kind: "file", ref: path, origin: "explicit", depth: 0, chars: size, exists });
    if (!exists) warnings.push(`file ${path} is missing or outside the repo`);
  }

  if (options.packet) {
    const packetPath = join("packets", `${options.packet}.md`);
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, packetPath);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    chars += size;
    sources.push({ kind: "packet", ref: options.packet, origin: "explicit", depth: 0, chars: size, exists });
    if (!exists) warnings.push(`packet ${options.packet} is missing`);
  }

  if (options.agent === "planner") {
    const planPath = options.planFile ?? "plans/index.md";
    const planRoot = resolve(layout.repoRoot);
    const abs = resolve(planRoot, planPath);
    const inside = abs === planRoot || abs.startsWith(planRoot + sep);
    const exists = inside && existsSync(abs);
    if (exists) {
      const size = capFor(abs, Number.MAX_SAFE_INTEGER);
      chars += size;
      sources.push({ kind: "plan", ref: planPath, origin: "inherited", depth: 3, chars: size, exists: true });
    }
  }
  // Mode default skill bodies plus explicit composer includes. Missing ones
  // are skipped silently. On-demand modes keep the description only; the agent
  // pulls the body with the skill tool.
  const includeOverrides = Object.entries(options.skillOverrides ?? {})
    .filter(([, mode]) => mode === "include")
    .map(([name]) => name);
  for (const name of [...(options.defaultSkills ?? []), ...includeOverrides]) {
    if (skills.includes(name)) continue;
    skills.push(name);
    const path = skillPath(layout, name);
    if (!path) continue;
    const mode = resolveSkillMode(name, {
      presets: options.skillPresets,
      defaults: options.defaultSkills,
      declared: skills,
      overrides: options.skillOverrides,
    });
    if (mode !== "include") continue;
    const size = capFor(path, Number.MAX_SAFE_INTEGER);
    chars += size;
    sources.push({ kind: "skill", ref: name, origin: "explicit", depth: 0, chars: size, exists: true });
  }
  if (options.knowledgeIndex) {
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, options.knowledgeIndex);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    chars += size;
    sources.push({ kind: "knowledge", ref: options.knowledgeIndex, origin: "inherited", depth: 3, chars: size, exists });
    if (!exists) warnings.push(`knowledge ${options.knowledgeIndex} is missing`);
  }
  // Skill descriptions are visible on every run. Mirror the single aggregate
  // block assembled at band 8.
  const allSkills = skillMetas(layout);
  if (allSkills.length > 0) {
    const text = allSkills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    const size = Math.min(1024, text.length);
    chars += size;
    sources.push({
      kind: "skill",
      ref: `${allSkills.length} skills`,
      origin: "explicit",
      depth: 0,
      chars: size,
      exists: true,
      note: allSkills.map((skill) => skill.name).join(", "),
    });
  }

  return {
    chars,
    promptChars: prompt.length,
    sources,
    issueChain: [],
    artifacts: { files, knowledge, references, skills, tools, scripts },
    warnings,
  };
}

/** Knowledge files that can be referenced from a run, repo-relative. */
export function discoverKnowledgeFiles(layout: Layout): string[] {
  const root = resolve(layout.repoRoot);
  const out = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.size >= 50) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.size >= 50) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(root, abs);
        if (!rel.startsWith("..")) out.add(rel);
      }
    }
  };
  for (const dir of ["knowledge", ".machine_code/knowledge"]) {
    walk(join(root, dir), 0);
  }
  return [...out].sort();
}

/** Cheap index for the artifact browser. */
export function artifactPreview(layout: Layout): ArtifactDef[] {
  return listArtifacts(layout);
}

/** Read a small slice only when the user explicitly opens an artifact. */
export function artifactPeek(layout: Layout, artifact: ArtifactDef, cap = 4 * 1024): string {
  const path = artifactPath(layout, artifact);
  if (!path || !existsSync(path)) return "(missing)";
  try {
    return readFileSync(path, "utf8").slice(0, cap);
  } catch {
    return "(unreadable)";
  }
}
