/**
 * machine_code — synchronous context preview for the TUI.
 *
 * This is deliberately not `assembleContext`: the draw path must never block
 * on a slow filesystem. It derives the issue contract and configured
 * defaults, which is enough to show what a run will inherit before it starts.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";
import { packageDataDir } from "../data.js";
import { listIssues, singleLine } from "../plan/issues.js";
import { isSecretPath } from "../tools/safety.js";
import { artifactPath, listArtifacts, type ArtifactDef } from "../artifacts/registry.js";
import { resolveSkillMode, skillIndexBody, skillMetas, type SkillMode } from "./references.js";
import { parseIncludeRange, parentIndexLine, sliceRangeBody } from "./assemble.js";
import { blockOverhead, sectionForKind } from "./budget.js";
import type { ContextSections } from "./types.js";

export interface PreviewSource {
  kind: "file" | "knowledge" | "reference" | "skill" | "tool" | "script" | "issue" | "parent-run";
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
  const dir = join(packageDataDir(), "skills", name);
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  return file;
}

export interface PreviewContextOptions {
  /** Role name. */
  agent?: string;
  knowledgeIndex?: string;
  /** Explicit repo-relative files selected in the composer. */
  files?: string[];
  /** Explicit repo-relative issue files selected in the composer. */
  issues?: string[];
  /** Mode default skills (e.g. from `defaultSkillsFor`); missing ones are skipped silently. */
  defaultSkills?: string[];
  /** Parent run and its ancestors, nearest first (same shape as assembleContext). */
  parentRuns?: Array<{
    id: string;
    request: string;
    status?: string;
    stopReason?: string;
    depth?: number;
  }>;
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

  for (const path of options.issues ?? []) {
    const root = resolve(layout.repoRoot);
    const abs = resolve(root, path);
    const inside = abs === root || abs.startsWith(root + sep);
    const exists = inside && existsSync(abs);
    const size = exists ? capFor(abs, Number.MAX_SAFE_INTEGER) : 0;
    sources.push({ kind: "issue", ref: path, origin: "explicit", depth: 0, chars: size, exists });
    if (!exists) warnings.push(`issue ${path} is missing or outside the repo`);
  }

  if (options.agent === "research") {
    const issues = listIssues(layout);
    if (issues.length > 0) {
      const body = issues.map((issue) => `- [${issue.status}] ${issue.slug} - ${singleLine(issue.prompt).slice(0, 120)}`).join("\n");
      sources.push({ kind: "issue", ref: "issues/", origin: "inherited", depth: 3, chars: body.length, exists: true });
    }
  }
  // Default skills and explicit composer includes are candidates for body
  // inlining; the mode chain decides. Defaults resolve to on-demand
  // (description-only) unless a role preset or composer override says
  // include, so no name is pushed into the declared set before resolution.
  const includeOverrides = Object.entries(options.skillOverrides ?? {})
    .filter(([, mode]) => mode === "include")
    .map(([name]) => name);
  for (const name of [...(options.defaultSkills ?? []), ...includeOverrides]) {
    const path = skillPath(layout, name);
    if (!path) continue;
    const mode = resolveSkillMode(name, {
      presets: options.skillPresets,
      declared: options.defaultSkills ?? [],
      overrides: options.skillOverrides,
    });
    if (mode !== "include") continue;
    if (skills.includes(name)) continue;
    skills.push(name);
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
  // Parent chain renders as the same one-line index the assembler emits
  // (depth cap 4, same bodies so measured chars match assembled chars).
  // Full request/result/error stays on demand via the context tool's parent
  // action. Over-cap ancestors warn by name, mirroring assembleContext.
  const chain = (options.parentRuns ?? []).map((run, index) => ({
    ...run,
    depth: run.depth ?? index + 1,
  }));
  const keptParents = chain.filter((run) => run.depth <= 4);
  const droppedParents = chain.filter((run) => run.depth > 4);
  for (const run of keptParents) {
    const body = parentIndexLine({ ...run, depth: run.depth });
    sources.push({
      kind: "parent-run",
      ref: run.id,
      origin: "inherited",
      depth: run.depth,
      chars: body.length,
      exists: true,
    });
  }
  if (droppedParents.length > 0) {
    warnings.push(
      `parent chain exceeds the depth-4 cap; omitted ancestor run(s): ${droppedParents.map((run) => run.id).join(", ")}`,
    );
  }
  // Only the role's own skill descriptions are in the assembled block.
  const visibleSkills = new Set([...(options.defaultSkills ?? []), ...includeOverrides]);
  const allSkills = skillMetas(layout).filter((skill) => visibleSkills.has(skill.name));
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

  const sections: ContextSections = {
    issues: 0,
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
