/**
 * machine_code — context assembly.
 *
 * Resolves in priority order, dedupes, and emits the full curated context.
 * The only ceiling is the caller's model input budget. There are no per-file
 * size rules; a source either fits or is reported as truncated/omitted.
 *
 * Every block is labelled with its source and origin; context.json records the
 * manifest (hash, bytes, truncation, warnings) so the model's context is
 * traceable. Nothing is preloaded that was not asked for by the run, an
 * ancestor, or the composer.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";
import { listIssues, singleLine } from "../plan/issues.js";
import type { MachineConfig } from "../config.js";
import { artifactExists, artifactPath, artifactSummary, resolveArtifact } from "../artifacts/registry.js";
import { defaultSkillsFor, resolveSkillMode, skillIndexBody, skillMetas, type SkillMode } from "./references.js";
import { readReference } from "../references/store.js";
import { isSecretPath } from "../tools/safety.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBundle,
  type ContextKind,
  type ContextOrigin,
  type ContextSections,
  type ContextSource,
} from "./types.js";
import { blockOverhead, sectionBudgets, sectionForKind } from "./budget.js";

interface Pending {
  kind: ContextKind;
  origin: ContextOrigin;
  ref: string;
  /** 0 = explicit current-task source, 3 = inherited config, N = parent-run chain. Mirrors previewContext. */
  depth?: number;
  body: string;
  band: number;
  warning?: string;
}

export interface ContextExclusion {
  /** Whole composer sections: files, issues, knowledge, skills, tools, scripts. */
  sections?: string[];
  /** Per-source keys shaped as `kind:ref`. */
  items?: string[];
}

export interface ContextInclude {
  /** Repo-relative source files to add explicitly from the composer. */
  files?: string[];
  /** Repo-relative knowledge files to add explicitly from the composer. */
  knowledge?: string[];
  /** Repo-relative issue files to add explicitly from the composer. */
  issues?: string[];
  /** Reference citations to add explicitly from the composer. */
  references?: string[];
}

export interface AssembleInput {
  layout: Layout;
  machine: MachineConfig;
  /** Role name. */
  agent?: string;
  /** direct: code only; verified: code + tests. */
  verification?: "direct" | "verified";
  /** Parent run and its ancestors, nearest first, for selected context inheritance. */
  parentRuns?: Array<{
    id: string;
    request: string;
    finalText?: string;
    status?: string;
    stopReason?: string;
    error?: string;
    depth?: number;
  }>;
  /** Parent run, for selected context inheritance (summary only). */
  parentRun?: {
    id: string;
    request: string;
    finalText?: string;
    status?: string;
    stopReason?: string;
    error?: string;
  };
  /** Model input budget in characters; used to report over-budget context. */
  budgetChars?: number;
  /** Drop whole sections or individual sources selected in the composer. */
  exclude?: ContextExclusion;
  /** Add files selected in the composer. */
  include?: ContextInclude;
  /**
   * Mode default skills (e.g. from `defaultSkillsFor`): bodies load at the
   * same priority and honor the `section:skills` / `skill:name` exclusions.
   * Missing defaults are skipped silently. A per-skill mode of on-demand
   * (role preset or composer override) keeps the description but skips the
   * body.
   */
  defaultSkills?: string[];
  /** Role `[skills]` preset table (from the agent's role TOML). */
  skillPresets?: Record<string, string>;
  /** Composer per-skill mode overrides (highest precedence). */
  skillOverrides?: Record<string, SkillMode>;
  /** Skills required at minimum "on-demand" (cannot be excluded by user). */
  requiredSkills?: readonly string[];
}

const SECTION_KINDS: Record<string, readonly ContextKind[]> = {
  files: ["file"],
  knowledge: ["knowledge"],
  references: ["reference"],
  skills: ["skill"],
  tools: ["tool"],
  scripts: ["script"],
  issues: ["issue"],
};

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Fixed render order for assembled context blocks (lost-in-the-middle
 * layout, prompt-cache stable).
 *
 * Section order is fixed and documented: the issue first (highest
 * relevance), then retrieved files by relevance (file, knowledge,
 * reference), then tools/skills/scripts aggregates, then the parent-run
 * chain last (most volatile). Within a section, band/depth priority order
 * (relevance) is preserved. Volatile per-turn content (working context,
 * run state, transcript) is render-side and always renders after this block
 * in renderPromptMessages, so reordering the volatile tail never shifts this
 * stable prefix.
 */
export const CONTEXT_RENDER_ORDER: Record<string, number> = {
  issue: 1,
  file: 2,
  knowledge: 3,
  reference: 4,
  skill: 5,
  script: 6,
  tool: 7,
  "parent-run": 8,
};

/**
 * Whitespace-normalized form used for near-duplicate dedupe. Exact sha1
 * misses copies that differ only in indentation, trailing whitespace, or
 * line wrapping, so blocks are also compared by the hash of this form.
 * Bodies are kept verbatim; normalization only affects the dedupe key.
 */
export function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function withinRepo(root: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const abs = resolve(root, path);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

function readFileText(file: string): { text: string; warning?: string } | null {
  try {
    return { text: readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

/** Repo-relative parent file plus 1-based inclusive line bounds. */
export interface IncludeRange {
  file: string;
  start: number;
  end: number;
}

/**
 * Snippet include: `path:START-END` (1-based, inclusive) or `path:LINE` for a
 * single line. Returns null for whole-file entries, which keep working as
 * today. Shared with previewContext so measured chars match assembled chars.
 */
export function parseIncludeRange(entry: string): IncludeRange | null {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(entry.trim());
  if (!match) return null;
  const file = (match[1] ?? "").trim();
  if (!file) return null;
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start < 1 || end < start) return null;
  return { file, start, end };
}

/**
 * Slice 1-based inclusive lines out of a file body. A start past EOF is an
 * out-of-range warning (never a silent empty body); a past-EOF end clamps to
 * the last line and the header names the lines actually included. The body
 * carries the parent file so the agent can expand via the read tool.
 */
export function sliceRangeBody(
  file: string,
  start: number,
  end: number,
  text: string,
): { body: string } | { warning: string } {
  // Line numbers match editor/sed semantics: a trailing newline terminates
  // the last line instead of starting a phantom empty one.
  const raw = text.split("\n");
  const lines = raw.length > 0 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
  if (start > lines.length) {
    return { warning: `included range ${file}:${start}-${end} is out of range (${lines.length} lines)` };
  }
  const clamped = Math.min(end, lines.length);
  const snippet = lines.slice(start - 1, clamped).join("\n");
  return { body: `[source: ${file}:${start}-${clamped}]\n${snippet}\n[parent: ${file}; expand with the read tool]` };
}

/** Depth label for a parent-chain entry: parent, grandparent, then depth. */
export function parentDepthLabel(depth: number): string {
  if (depth <= 1) return "parent run";
  if (depth === 2) return "grandparent run";
  return `ancestor run (depth ${depth})`;
}

/** First line of the request, whitespace-collapsed and truncated to one line. */
export function parentObjectiveOneLiner(request: string, cap = 120): string {
  const oneLine = request.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? `${oneLine.slice(0, cap).trimEnd()}…` : oneLine;
}

/**
 * One-line index entry for a parent run: depth label, run id, objective
 * one-liner, status, and the named pull path for the full detail. Never
 * carries result text — not even for completed parents — so a blocked or
 * failed parent's closing summary cannot leak in as evidence. The agent
 * pulls the full request/result/error with the context tool.
 */
export function parentIndexLine(run: {
  id: string;
  request: string;
  status?: string;
  stopReason?: string;
  depth: number;
}): string {
  const label = parentDepthLabel(run.depth);
  const state = run.status
    ? `status: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""}`
    : "status: unknown";
  return (
    `${label}: ${run.id} | objective: ${parentObjectiveOneLiner(run.request)} | ${state} | ` +
    `pull full detail with the context tool: {"action": "parent", "id": "${run.id}"}`
  );
}

/** A stopped (neither completed nor running) parent's result is not evidence. */
export function isParentStopped(status?: string): boolean {
  return status !== undefined && status !== "completed" && status !== "running";
}

function skillBody(layout: Layout, name: string): { path: string; text: string } | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  for (const dir of [join(layout.repoDir, "skills", name), join(layout.home, "skills", name)]) {
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    return { path: file, text: readFileSync(file, "utf8") };
  }
  return null;
}

export async function assembleContext(input: AssembleInput): Promise<ContextBundle> {
  const { layout, machine } = input;
  const budget = Math.max(1024, input.budgetChars ?? machine.context.maxChars ?? DEFAULT_CONTEXT_BUDGET);
  const pending: Pending[] = [];

  // Composer selections are known before pending items are built so they can
  // filter aggregate blocks (skill descriptions) as well as complete items.
  const excludedSections = new Set(input.exclude?.sections ?? []);
  const excludedItems = new Set(input.exclude?.items ?? []);

  // Role default skills. Missing defaults are skipped silently.
  // Default skills plus explicit composer includes are candidates for body
  // inlining; the mode chain decides. Defaults resolve to on-demand
  // (description-only) unless a role preset or override says include.
  const includeOverrides = Object.entries(input.skillOverrides ?? {})
    .filter(([, mode]) => mode === "include")
    .map(([name]) => name);
  for (const name of [...(input.defaultSkills ?? []), ...includeOverrides]) {
    const mode = resolveSkillMode(name, {
      presets: input.skillPresets,
      declared: input.defaultSkills ?? [],
      overrides: input.skillOverrides,
      required: input.requiredSkills,
    });
    if (mode !== "include") continue;
    const skill = skillBody(layout, name);
    if (!skill) continue;
    pending.push({ kind: "skill", origin: "explicit", ref: name, depth: 0, body: skill.text, band: 2 });
  }

  // Explicit composer includes. These are user-selected knowledge files that
  // no composer file or configured index references; they are still ordinary
  // provenance-tracked context blocks.
  for (const path of input.include?.issues ?? []) {
    const abs = withinRepo(layout.repoRoot, path);
    if (!abs || !existsSync(abs) || isSecretPath(path)) {
      pending.push({
        kind: "issue",
        origin: "explicit",
        ref: path,
        body: "",
        band: 1,
        warning: "included issue is missing, secret, or outside the repo",
      });
      continue;
    }
    const read = readFileText(abs);
    if (read) pending.push({ kind: "issue", origin: "explicit", ref: path, depth: 0, body: read.text, band: 1 });
  }
  for (const entry of input.include?.files ?? []) {
    const range = parseIncludeRange(entry);
    if (range) {
      const abs = withinRepo(layout.repoRoot, range.file);
      if (!abs || !existsSync(abs) || isSecretPath(range.file)) {
        pending.push({
          kind: "file",
          origin: "explicit",
          ref: entry,
          body: "",
          band: 1,
          warning: "included file is missing, secret, or outside the repo",
        });
        continue;
      }
      const read = readFileText(abs);
      const sliced = read ? sliceRangeBody(range.file, range.start, range.end, read.text) : null;
      if (!sliced || "warning" in sliced) {
        pending.push({
          kind: "file",
          origin: "explicit",
          ref: entry,
          body: "",
          band: 1,
          warning: sliced && "warning" in sliced ? sliced.warning : "included file is unreadable",
        });
        continue;
      }
      pending.push({ kind: "file", origin: "explicit", ref: entry, depth: 0, body: sliced.body, band: 1 });
      continue;
    }
    const abs = withinRepo(layout.repoRoot, entry);
    if (!abs || !existsSync(abs) || isSecretPath(entry)) {
      pending.push({
        kind: "file",
        origin: "explicit",
        ref: entry,
        body: "",
        band: 1,
        warning: "included file is missing, secret, or outside the repo",
      });
      continue;
    }
    const read = readFileText(abs);
    if (read) pending.push({ kind: "file", origin: "explicit", ref: entry, depth: 0, body: read.text, band: 1 });
  }
  for (const path of input.include?.knowledge ?? []) {
    const abs = withinRepo(layout.repoRoot, path);
    if (!abs || !existsSync(abs)) {
      pending.push({
        kind: "knowledge",
        origin: "explicit",
        ref: path,
        body: "",
        band: 1,
        warning: "included knowledge is missing or outside the repo",
      });
      continue;
    }
    const read = readFileText(abs);
    if (read) {
      pending.push({ kind: "knowledge", origin: "explicit", ref: path, depth: 0, body: read.text, band: 1 });
    }
  }
  for (const citation of input.include?.references ?? []) {
    const read = readReference(layout, citation, Number.MAX_SAFE_INTEGER);
    if (!read.ok) {
      pending.push({
        kind: "reference",
        origin: "explicit",
        ref: citation,
        body: "",
        band: 1,
        warning: `included reference ${citation} is missing or outside the store`,
      });
      continue;
    }
    const label = `${read.path}${read.anchor ? `#${read.anchor}` : ""}`;
    pending.push({
      kind: "reference",
      origin: "explicit",
      ref: citation,
      depth: 0,
      body: `${label}\n\n${read.text}`,
      band: 1,
    });
  }

  // Parent run + ancestors. Each parent contributes one index line (depth
  // label, run id, objective one-liner, status) plus a named pull path; the
  // agent pulls the full request/result/error on demand through the context
  // tool (`{"action":"parent","id":"<run>"}`) instead of inheriting a
  // transcript it may never need. A blocked/failed parent's closing summary
  // is not authoritative: it often claims the task is undefined. Its result
  // is suppressed both here and in the pulled detail; only its status and
  // error are kept.
  type ParentRun = {
    id: string;
    request: string;
    finalText?: string;
    status?: string;
    stopReason?: string;
    error?: string;
    depth: number;
  };
  const chain: ParentRun[] =
    input.parentRuns && input.parentRuns.length > 0
      ? input.parentRuns.map((run, index) => ({ ...run, depth: run.depth ?? index + 1 }))
      : input.parentRun
        ? [{ ...input.parentRun, depth: 1 }]
        : [];
  const droppedAncestors: string[] = [];
  for (const run of chain) {
    if (run.depth > 4) {
      droppedAncestors.push(run.id);
      continue;
    }
    pending.push({
      kind: "parent-run",
      origin: "inherited",
      ref: run.id,
      depth: run.depth,
      body: parentIndexLine({ ...run, depth: run.depth }),
      band: 6,
    });
  }

  // The issues tree is context for research (avoid duplicate items); an
  // engineer/review run already carries the one issue it works on.
  if (input.agent === "research") {
    const list = listIssues(layout);
    if (list.length > 0) {
      const body = list.map((issue) => `- [${issue.status}] ${issue.slug} - ${singleLine(issue.prompt).slice(0, 120)}`).join("\n");
      pending.push({ kind: "issue", origin: "inherited", ref: "issues/", depth: 3, body, band: 7 });
    }
  }
  if (machine.context.knowledgeIndex) {
    const abs = withinRepo(layout.repoRoot, machine.context.knowledgeIndex);
    if (abs && existsSync(abs)) {
      const read = readFileText(abs);
      if (read) {
        pending.push({
          kind: "knowledge",
          origin: "inherited",
          ref: machine.context.knowledgeIndex,
          depth: 3,
          body: read.text,
          band: 7,
        });
      }
    }
  }

  // Skills (descriptions only) + tool/command index (descriptions only).
  // Individual skill exclusions remove that skill's description; body
  // items are filtered below. Excluded means excluded everywhere: composer
  // items, composer mode overrides, and role presets all hide the
  // description. Bodies stay cold unless a skill mode resolves to include;
  // the index names the on-demand pull path (skill tool show).
  const excludedSkillNames = new Set(
    [...excludedItems]
      .filter((key) => key.startsWith("skill:"))
      .map((key) => key.slice("skill:".length)),
  );
  for (const [name, mode] of Object.entries(input.skillPresets ?? {})) {
    if (mode === "exclude") excludedSkillNames.add(name);
  }
  for (const [name, mode] of Object.entries(input.skillOverrides ?? {})) {
    if (mode === "exclude") excludedSkillNames.add(name);
    else excludedSkillNames.delete(name);
  }
  // Skill descriptions: only the role's own skills plus explicit includes.
  // Listing every installed skill spends context on procedures this run will
  // never use. Bodies stay cold unless a mode resolves to include.
  const roleSkills = new Set(defaultSkillsFor({ agent: input.agent ?? "", verification: input.verification }));
  const skillIncludes = new Set(
    [...Object.entries(input.skillPresets ?? {}), ...Object.entries(input.skillOverrides ?? {})]
      .filter(([, mode]) => mode === "include")
      .map(([name]) => name),
  );
  const skills = skillMetas(layout).filter(
    (skill) => (roleSkills.has(skill.name) || skillIncludes.has(skill.name)) && !excludedSkillNames.has(skill.name),
  );
  if (skills.length > 0) {
    const text = skillIndexBody(skills);
    pending.push({ kind: "skill", origin: "explicit", ref: `${skills.length} skills`, depth: 0, body: text, band: 8 });
  }

  // Apply composer exclusions before dedupe so removed sources never consume
  // budget or collide with a kept source.
  const excludedKinds = new Set<ContextKind>();
  for (const [section, kinds] of Object.entries(SECTION_KINDS)) {
    if (!excludedSections.has(section)) continue;
    for (const kind of kinds) excludedKinds.add(kind);
  }
  const keptPending = pending.filter(
    (item) => !excludedKinds.has(item.kind) && !excludedItems.has(`${item.kind}:${item.ref}`),
  );

  // Dedupe by (kind, ref) and content hash; keep the earliest (highest priority).
  // Content-hash dedupe is normalized: exact bytes plus a whitespace-folded
  // hash, so near-duplicate blocks (reindented, rewrapped, trailing-space
  // copies) collapse instead of consuming budget twice.
  const seen = new Set<string>();
  const selected: Pending[] = [];
  for (const item of keptPending.sort((a, b) => a.band - b.band || (a.depth ?? 0) - (b.depth ?? 0))) {
    const key = `${item.kind}:${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Content-hash dedupe is for real bodies only: every warning-only source
    // has an empty body, and collapsing them would silently drop distinct
    // warnings (e.g. two out-of-range snippet includes).
    if (item.body !== "") {
      const hash = sha1(item.body);
      const folded = sha1(normalizeForDedupe(item.body));
      if (seen.has(`h:${hash}`) || seen.has(`n:${folded}`)) continue;
      seen.add(`h:${hash}`);
      seen.add(`n:${folded}`);
    }
    selected.push(item);
  }

  // Priority budget: the usable input budget (limit minus the caller's
  // response reserve) with no per-section caps. Over budget, whole sources
  // are dropped lowest-priority-first with a named omission; a kept block is
  // never sliced mid-content. Priority is role-aware: engineer/review keep
  // the issue first and working files above docs; research keeps
  // knowledge/references above files. The issue is never dropped while
  // anything else remains.
  const { budget: usable } = sectionBudgets(budget);

  // Drop rank: higher is dropped first. Aggregates (tool index, skill
  // descriptions) go first, then the parent chain, skill bodies, and the
  // working set; the issue goes last on every role.
  const dropRank = (item: Pending): number => {
    const role = input.agent;
    if (item.kind === "tool") return 60;
    if (item.kind === "skill" && /^\d+ skills$/.test(item.ref)) return 60;
    if (item.kind === "parent-run") return 50;
    if (item.kind === "skill" || item.kind === "script") return 40;
    if (item.kind === "issue") return item.origin === "explicit" ? 8 : 22;
    if (item.kind === "knowledge") {
      if (role === "research") return 20;
      return role === "research" ? 25 : 30;
    }
    if (item.kind === "reference") return role === "research" ? 22 : 32;
    if (item.kind === "file") return role === "engineer" || role === "review" ? 25 : 30;
    return 30;
  };
  const PROTECTED_RANK = 20;

  interface Kept extends Pending {
    len: number;
    trimmed?: boolean;
  }
  const entries: Kept[] = [];
  const sources: ContextSource[] = [];
  const warnings: string[] = [];
  if (droppedAncestors.length > 0) {
    warnings.push(
      `parent chain exceeds the depth-4 cap; omitted ancestor run(s): ${droppedAncestors.join(", ")}; ` +
        `pull any of them with the context tool if needed ({"action": "parent", "id": "<run>"})`,
    );
  }
  for (const item of selected) {
    if (item.warning && item.body === "") {
      sources.push({ kind: item.kind, origin: item.origin, ref: item.ref, depth: item.depth, bytes: 0, hash: "", truncated: false, warning: item.warning });
      continue;
    }
    if (item.body.trim().length === 0) continue;
    entries.push({ ...item, len: item.body.length });
  }

  // File bodies render with the same `N: ` line numbers the read tool
  // returns, so anchors and issue-cited lines lift straight out of context
  // with zero reads. Number before budgeting so lengths, hashes, and trims
  // all account the numbered text; trims cut at newlines so numbers stay
  // 1-based. Numbers are current as assembled; after an edit, read requotes
  // the region (or the edit miss re-anchors).
  for (const entry of entries) {
    if (entry.kind === "file") {
      entry.body = entry.body
        .split("\n")
        .map((line, index) => `${index + 1}: ${line}`)
        .join("\n");
      entry.len = entry.body.length;
    }
  }

  const totalLen = (): number => entries.reduce((sum, entry) => sum + entry.len, 0);

  let guard = entries.length + 1;
  while (totalLen() > usable && guard-- > 0) {
    // A lone droppable source that alone exceeds the budget is trimmed
    // below, not dropped, so the run keeps working context.
    if (entries.length <= 1) break;
    const pool = entries.filter((entry) => dropRank(entry) > PROTECTED_RANK);
    if (pool.length === 0) break;
    pool.sort((a, b) => dropRank(b) - dropRank(a) || b.len - a.len);
    const victim = pool[0]!;
    entries.splice(entries.indexOf(victim), 1);
    warnings.push(
      `omitted ${victim.kind}:${victim.ref} (${victim.len.toLocaleString()} chars) to fit the ${usable.toLocaleString()} char input budget`,
    );
  }
  if (entries.length === 1 && totalLen() > usable) {
    const only = entries[0]!;
    if (dropRank(only) > PROTECTED_RANK) {
      const fixedOverhead =
        "<context>".length +
        "Assembled context for this run. Each block is labelled with its source and origin (explicit, inherited).".length +
        "</context>".length +
        3 +
        blockOverhead(only.kind, only.ref, only.origin, only.depth);
      // Shrink to an exact fit: the marker carries final numbers, so the
      // room accounts for its own length.
      let room = Math.max(0, usable - fixedOverhead);
      let candidate = only.body;
      for (;;) {
        const newline = only.body.lastIndexOf("\n", room);
        const cut = newline > room / 2 ? newline : room;
        const marker = `…[trimmed ${only.kind}:${only.ref} to fit the ${usable.toLocaleString()} char input budget: kept ${cut.toLocaleString()} of ${only.len.toLocaleString()} chars]`;
        candidate = `${only.body.slice(0, cut).replace(/\s+$/, "")}\n${marker}`;
        if (fixedOverhead + candidate.length <= usable || room <= 0) break;
        room = Math.max(0, room - (fixedOverhead + candidate.length - usable) - 16);
      }
      only.body = candidate;
      only.len = only.body.length;
      only.trimmed = true;
      warnings.push(
        `trimmed ${only.kind}:${only.ref} to ${only.len.toLocaleString()} chars to fit the ${usable.toLocaleString()} char input budget`,
      );
    }
  }

  // Render every kept source in fixed section order (CONTEXT_RENDER_ORDER):
  // issue first, retrieved files by relevance, tools/skills, parents
  // last. Array.prototype.sort is stable, so relevance (band/depth) order is
  // preserved within a section. The runner may trim the prompt to the
  // selected model's input window, but that is a model limit, not a per-file
  // rule. Report the overage instead of silently changing a source.
  const ordered = [...entries].sort(
    (a, b) => (CONTEXT_RENDER_ORDER[a.kind] ?? 99) - (CONTEXT_RENDER_ORDER[b.kind] ?? 99),
  );
  const blocks: string[] = [];
  for (const item of ordered) {
    const attrs = [
      `kind="${item.kind}"`,
      `source="${item.ref.replace(/"/g, "'")}"`,
      `origin="${item.origin}"`,
      ...(item.depth !== undefined ? [`depth="${item.depth}"`] : []),
    ];
    blocks.push(`<context-block ${attrs.join(" ")}>\n${item.body}\n</context-block>`);
    sources.push({
      kind: item.kind,
      origin: item.origin,
      ref: item.ref,
      depth: item.depth,
      bytes: item.len,
      hash: sha1(item.body),
      truncated: item.trimmed === true,
      ...(item.trimmed === true
        ? { warning: `trimmed to ${item.len.toLocaleString()} chars to fit the ${usable.toLocaleString()} char input budget` }
        : {}),
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
  for (const entry of entries) sections[sectionForKind(entry.kind)] += entry.len;

  // Lost-in-the-middle recap: when issue sources exist, restate the critical
  // objective last (highest-relevance first AND last) so the tail of the
  // stable prefix re-anchors the run before the volatile per-turn content
  // (working context, transcript) follows in render.ts.
  const issueSources = ordered.filter((entry) => entry.kind === "issue");
  let recap = "";
  if (issueSources.length > 0) {
    const points = issueSources.slice(0, 4).map((entry) => {
      const first = entry.body.split("\n").find((line) => line.trim() !== "") ?? entry.ref;
      return `issue ${entry.ref}: ${first.trim().slice(0, 120)}`;
    });
    recap = `<context-recap>\nRecap (authoritative — act on this): ${points.join("; ")}. The issue blocks above outrank the working files in between.\n</context-recap>`;
    blocks.push(recap);
    sections.issues += recap.length;
  }

  const used = totalLen() + recap.length;
  if (used > usable) {
    warnings.push(`curated context is ${used.toLocaleString()} chars; model input budget is ${budget.toLocaleString()} chars; the runner will trim to fit`);
  }

  const text =
    blocks.length === 0
      ? ""
      : [
          "<context>",
          "Assembled context for this run. Each block is labelled with its source and origin (explicit, inherited).",
          ...blocks,
          "</context>",
        ].join("\n");

  return { text, sources, chars: text.length, warnings, sections };
}
