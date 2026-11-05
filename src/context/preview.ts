/**
 * machine_code — synchronous context preview for the TUI.
 *
 * This is deliberately not `assembleContext`: the draw path must never block
 * on gh or a slow filesystem. It derives the same cascade from the cached
 * issue hierarchy and caps file reads, which is enough to show what a run will
 * inherit before it starts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";
import type { Issue, IssueRef } from "../issues/provider.js";
import { artifactExists, artifactPath, listArtifacts, resolveArtifact, type ArtifactDef } from "../artifacts/registry.js";
import { parseArtifactReferences, resolveSkillMode, skillMetas, type SkillMode } from "./references.js";
import { readReference, referenceFileSize } from "../references/store.js";
import { discoverPlanFiles } from "./plans.js";

export interface PreviewSource {
  kind: "issue" | "file" | "knowledge" | "reference" | "skill" | "tool" | "script" | "plan" | "project";
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
  issueChain: Issue[];
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

function keyOf(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
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

/** Build the exact hierarchy chain (nearest first) from a cached issue list. */
export function issueChain(issues: readonly Issue[], ref?: IssueRef): Issue[] {
  if (!ref) return [];
  const map = new Map(issues.map((issue) => [keyOf(issue.ref), issue]));
  const chain: Issue[] = [];
  let current = map.get(keyOf(ref));
  const seen = new Set<string>();
  while (current && !seen.has(keyOf(current.ref)) && chain.length < 5) {
    chain.push(current);
    seen.add(keyOf(current.ref));
    current = current.parent ? map.get(keyOf(current.parent)) : undefined;
  }
  return chain;
}

export interface PreviewContextOptions {
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
  issues: readonly Issue[],
  ref?: IssueRef,
  prompt = "",
  options: PreviewContextOptions = {},
): ContextPreview {
  const chain = issueChain(issues, ref);
  const sources: PreviewSource[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  const knowledge: string[] = [];
  const references: string[] = [];
  const skills: string[] = [];
  const tools: ArtifactDef[] = [];
  const scripts: ArtifactDef[] = [];
  let chars = 0;

  for (let depth = 0; depth < chain.length; depth++) {
    const issue = chain[depth]!;
    const origin = depth === 0 ? "explicit" : "inherited";
    const bodyChars = Math.min(6 * 1024, issue.body.length + issue.title.length + issue.acceptance.join(" ").length);
    chars += bodyChars;
    sources.push({ kind: "issue", ref: `#${issue.ref.number} ${issue.title}`, origin, depth, chars: bodyChars, exists: true });
    const refs = parseArtifactReferences(issue.body);
    for (const path of refs.files) {
      if (files.includes(path)) continue;
      files.push(path);
      const root = resolve(layout.repoRoot);
      const abs = resolve(root, path);
      const inside = abs === root || abs.startsWith(root + sep);
      const exists = inside && existsSync(abs);
      const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
      chars += size;
      sources.push({ kind: "file", ref: path, origin, depth, chars: size, exists });
      if (!exists) warnings.push(`file ${path} is missing`);
    }
    for (const path of refs.knowledge) {
      if (knowledge.includes(path)) continue;
      knowledge.push(path);
      const root = resolve(layout.repoRoot);
      const abs = resolve(root, path);
      const inside = abs === root || abs.startsWith(root + sep);
      const exists = inside && existsSync(abs);
      const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
      chars += size;
      sources.push({ kind: "knowledge", ref: path, origin, depth, chars: size, exists });
      if (!exists) warnings.push(`knowledge ${path} is missing`);
    }
    for (const citation of refs.references) {
      if (references.includes(citation)) continue;
      references.push(citation);
      const read = readReference(layout, citation, 8 * 1024);
      const size = read.ok ? read.text.length : 0;
      chars += size;
      sources.push({
        kind: "reference",
        ref: read.ok ? `${read.path}${read.anchor ? `#${read.anchor}` : ""}` : citation,
        origin,
        depth,
        chars: size,
        exists: read.ok,
      });
      if (!read.ok) warnings.push(`reference ${citation} is missing`);
      else if (referenceFileSize(layout, citation) > 8 * 1024) warnings.push(`reference ${citation} is truncated`);
    }
    for (const name of refs.skills) {
      if (skills.includes(name)) continue;
      skills.push(name);
      const path = skillPath(layout, name);
      const mode = resolveSkillMode(name, {
        presets: options.skillPresets,
        defaults: options.defaultSkills,
        declared: refs.skills,
        overrides: options.skillOverrides,
      });
      const size = mode === "include" && path ? capFor(path, Number.MAX_SAFE_INTEGER) : 0;
      chars += size;
      sources.push({ kind: "skill", ref: name, origin, depth, chars: size, exists: Boolean(path) });
      if (!path) warnings.push(`skill ${name} is missing`);
    }
    for (const [list, target, kind] of [
      [refs.tools, tools, "tool"],
      [refs.scripts, scripts, "script"],
    ] as const) {
      for (const name of list) {
        if (target.some((artifact) => artifact.name === name)) continue;
        const artifact = resolveArtifact(layout, name);
        if (!artifact) {
          warnings.push(`${kind} ${name} is missing`);
          sources.push({ kind, ref: name, origin, depth, chars: 0, exists: false });
          continue;
        }
        target.push(artifact);
        const path = artifactPath(layout, artifact);
        const size = path ? (artifactExists(layout, artifact) && path ? capFor(path, Number.MAX_SAFE_INTEGER) : artifact.description.length + 160) : 0;
        chars += size;
        sources.push({
          kind,
          ref: artifact.name,
          origin,
          depth,
          chars: size,
          exists: artifactExists(layout, artifact),
          note: artifact.description || undefined,
        });
      }
    }
  }

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

  for (const planPath of discoverPlanFiles(layout, options.planFile)) {
    // Report the real size. The run's global model budget decides what fits;
    // preview must not hide a plan by pretending it is 2 KiB long.
    const size = capFor(join(layout.repoRoot, planPath), Number.MAX_SAFE_INTEGER);
    chars += size;
    sources.push({ kind: "plan", ref: planPath, origin: "inherited", depth: 3, chars: size, exists: true });
  }
  // Mode default skill bodies plus explicit composer includes (clean-code,
  // verified-testing). Declared issue skills win ties; missing ones are
  // skipped silently. On-demand modes keep the description only; the agent
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

  // Skill descriptions are visible on every run even when no issue references
  // a skill body. Mirror the single aggregate block assembled at band 8.
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
    issueChain: chain,
    artifacts: { files, knowledge, references, skills, tools, scripts },
    warnings,
  };
}

/** Knowledge files that can be referenced from an issue, repo-relative. */
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
