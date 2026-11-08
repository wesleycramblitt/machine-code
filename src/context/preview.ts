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
import { isSecretPath } from "../tools/safety.js";
import { allCommands } from "../commands/profiles.js";
import { artifactPath, listArtifacts, type ArtifactDef } from "../artifacts/registry.js";
import { resolveSkillMode, skillIndexBody, skillMetas, toolIndexBody, type SkillMode } from "./references.js";
import { parseIncludeRange, sliceRangeBody } from "./assemble.js";
import { blockOverhead, sectionForKind } from "./budget.js";
import type { ContextSections } from "./types.js";

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
  /** Kept body chars per section, mirroring the assembled bundle. */
  sections: ContextSections;
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
  /** Explicit repo-relative plan files selected in the composer. */
  plans?: string[];
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

  for (const entry of options.files ?? []) {
    const range = parseIncludeRange(entry);
    if (range) {
      // Range includes measure the assembled snippet body, not the whole
      // file, so the composer shows the real cost. Unresolvable ranges are
      // zero-char warned sources, mirroring assembleContext.
      const root = resolve(layout.repoRoot);
      const abs = resolve(root, range.file);
      const inside = abs === root || abs.startsWith(root + sep);
      const secret = isSecretPath(range.file);
      if (!inside || secret || !existsSync(abs)) {
        sources.push({ kind: "file", ref: entry, origin: "explicit", depth: 0, chars: 0, exists: false });
        warnings.push(`file ${entry} is missing, secret, or outside the repo`);
        continue;
      }
      let size = 0;
      let failed: string | null = null;
      try {
        const sliced = sliceRangeBody(range.file, range.start, range.end, readFileSync(abs, "utf8"));
        if ("body" in sliced) size = sliced.body.length;
        else failed = sliced.warning;
      } catch {
        failed = `file ${entry} is unreadable`;
      }
      if (failed) warnings.push(failed.startsWith("file ") ? failed : `file ${entry}: ${failed}`);
      sources.push({ kind: "file", ref: entry, origin: "explicit", depth: 0, chars: size, exists: size > 0 });
      continue;
    }
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, entry);
    const inside = abs === root || abs.startsWith(root + sep);
    // Mirror assembleContext: secrets never inline, and missing/secret/outside
    // all collapse to a zero-char warned source so the measurement matches.
    const secret = isSecretPath(entry);
    const exists = inside && !secret && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    sources.push({ kind: "file", ref: entry, origin: "explicit", depth: 0, chars: size, exists });
    if (!exists) warnings.push(`file ${entry} is missing, secret, or outside the repo`);
  }

  for (const path of options.plans ?? []) {
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, path);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    sources.push({ kind: "plan", ref: path, origin: "explicit", depth: 0, chars: size, exists });
    if (!exists) warnings.push(`plan ${path} is missing or outside the repo`);
  }

  if (options.packet) {
    const packetPath = join("packets", `${options.packet}.md`);
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, packetPath);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
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
    sources.push({ kind: "skill", ref: name, origin: "explicit", depth: 0, chars: size, exists: true });
  }
  if (options.knowledgeIndex) {
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, options.knowledgeIndex);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    sources.push({ kind: "knowledge", ref: options.knowledgeIndex, origin: "inherited", depth: 3, chars: size, exists });
    if (!exists) warnings.push(`knowledge ${options.knowledgeIndex} is missing`);
  }
  // Skill descriptions are visible on every run. Mirror the single aggregate
  // block assembled at band 8, at its full assembled size so the composer
  // shows the real cost. The block carries one-line descriptions plus the
  // on-demand pull path, never bodies.
  const allSkills = skillMetas(layout);
  if (allSkills.length > 0) {
    const text = skillIndexBody(allSkills);
    const size = text.length;
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
  // Tool/command descriptions are assembled alongside the skill descriptions.
  // Mirror the aggregate block so preview chars match assembled chars: one
  // line per command plus the on-demand pull path, never full schemas.
  try {
    const commands = allCommands(layout);
    if (commands.size > 0) {
      const body = toolIndexBody(commands);
      sources.push({
        kind: "tool",
        ref: `${commands.size} commands`,
        origin: "explicit",
        depth: 0,
        chars: body.length,
        exists: true,
      });
    }
  } catch {
    // profiles unavailable — skip
  }

  const sections: ContextSections = {
    packets: 0,
    plans: 0,
    knowledge: 0,
    skills: 0,
    scripts: 0,
    tools: 0,
    references: 0,
    files: 0,
    parents: 0,
    system: 0,
  };
  for (const source of sources) sections[sectionForKind(source.kind)] += source.chars;
  // Preview chars estimate the assembled bundle: body chars plus the same
  // per-block wrapper the assembler renders, so the composer shows real
  // costs. Warned-missing and empty sources render no block.
  const rendered = sources.filter((source) => source.chars > 0);
  const estimated =
    rendered.reduce(
      (sum, source) => sum + source.chars + blockOverhead(source.kind, source.ref, source.origin, source.depth),
      0,
    ) +
    (rendered.length > 0
      ? "<context>".length +
        "Assembled context for this run. Each block is labelled with its source and origin (explicit, inherited).".length +
        "</context>".length +
        (rendered.length + 2)
      : 0);

  return {
    chars: estimated,
    promptChars: prompt.length,
    sources,
    sections,
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
