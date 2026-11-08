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
import type { MachineConfig } from "../config.js";
import { readPacket } from "../packet.js";
import { allCommands } from "../commands/profiles.js";
import { artifactExists, artifactPath, artifactSummary, resolveArtifact } from "../artifacts/registry.js";
import { resolveSkillMode, skillMetas, type SkillMode } from "./references.js";
import { readReference } from "../references/store.js";
import { isSecretPath } from "../tools/safety.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBundle,
  type ContextKind,
  type ContextOrigin,
  type ContextSection,
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
  /** Whole composer sections: files, knowledge, skills, tools, scripts, plans. */
  sections?: string[];
  /** Per-source keys shaped as `kind:ref`. */
  items?: string[];
}

export interface ContextInclude {
  /** Repo-relative source files to add explicitly from the composer. */
  files?: string[];
  /** Repo-relative knowledge files to add explicitly from the composer. */
  knowledge?: string[];
  /** Repo-relative plan files to add explicitly from the composer. */
  plans?: string[];
  /** Reference citations to add explicitly from the composer. */
  references?: string[];
}

export interface AssembleInput {
  layout: Layout;
  machine: MachineConfig;
  packetId?: string;
  /** Role name; the plan map is inherited only by the planner. */
  agent?: string;
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
}

const SECTION_KINDS: Record<string, readonly ContextKind[]> = {
  packets: ["packet"],
  files: ["file"],
  knowledge: ["knowledge"],
  references: ["reference"],
  skills: ["skill"],
  tools: ["tool"],
  scripts: ["script"],
  plans: ["plan", "project"],
};

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
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

  // Explicit packet (runner-provided).
  const packetIds = new Set<string>();
  if (input.packetId) packetIds.add(input.packetId);

  // Composer selections are known before pending items are built so they can
  // filter aggregate blocks (skill descriptions) as well as complete items.
  const excludedSections = new Set(input.exclude?.sections ?? []);
  const excludedItems = new Set(input.exclude?.items ?? []);

  // Mode default skills (clean-code on coding/planning runs, verified-testing
  // on verified+). Missing defaults are skipped silently.
  // Defaults plus explicit composer includes. Overrides alone do not
  // enumerate skills, so include-overrides join the candidate list here.
  const includeOverrides = Object.entries(input.skillOverrides ?? {})
    .filter(([, mode]) => mode === "include")
    .map(([name]) => name);
  for (const name of [...(input.defaultSkills ?? []), ...includeOverrides]) {
    const mode = resolveSkillMode(name, {
      presets: input.skillPresets,
      defaults: input.defaultSkills,
      declared: [],
      overrides: input.skillOverrides,
    });
    if (mode !== "include") continue;
    const skill = skillBody(layout, name);
    if (!skill) continue;
    pending.push({ kind: "skill", origin: "explicit", ref: name, depth: 0, body: skill.text, band: 2 });
  }

  // Explicit composer includes. These are user-selected knowledge files that
  // no composer file or configured index references; they are still ordinary
  // provenance-tracked context blocks.
  for (const path of input.include?.files ?? []) {
    const abs = withinRepo(layout.repoRoot, path);
    if (!abs || !existsSync(abs) || isSecretPath(path)) {
      pending.push({
        kind: "file",
        origin: "explicit",
        ref: path,
        body: "",
        band: 1,
        warning: "included file is missing, secret, or outside the repo",
      });
      continue;
    }
    const read = readFileText(abs);
    if (read) pending.push({ kind: "file", origin: "explicit", ref: path, depth: 0, body: read.text, band: 1 });
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
  for (const path of input.include?.plans ?? []) {
    const abs = withinRepo(layout.repoRoot, path);
    if (!abs || !existsSync(abs)) {
      pending.push({
        kind: "plan",
        origin: "explicit",
        ref: path,
        body: "",
        band: 1,
        warning: "included plan is missing or outside the repo",
      });
      continue;
    }
    const read = readFileText(abs);
    if (read) {
      pending.push({ kind: "plan", origin: "explicit", ref: path, depth: 0, body: read.text, band: 1 });
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

  // Packets.
  for (const id of packetIds) {
    const packet = readPacket(layout, id);
    if (!packet) {
      pending.push({ kind: "packet", origin: "explicit", ref: id, body: "", band: 1, warning: "packet not found" });
      continue;
    }
    pending.push({
      kind: "packet",
      origin: "explicit",
      ref: packet.id,
      depth: 0,
      body: JSON.stringify(packet, null, 2),
      band: 1,
    });
  }

  // Parent run + ancestors. A fork inherits the immediate parent's objective,
  // then the chain above it (grandparent, …) so a fork of a fork does not lose
  // the original task. A blocked/failed parent's closing summary is not
  // authoritative: it often claims the task is undefined. Keep its status and
  // error, but do not replay that summary as evidence.
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
  for (const run of chain) {
    if (run.depth > 4) break;
    const label =
      run.depth <= 1 ? "parent run" : run.depth === 2 ? "grandparent run" : `ancestor run (depth ${run.depth})`;
    const stopped = run.status !== undefined && run.status !== "completed" && run.status !== "running";
    const state = run.status
      ? `status: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""}`
      : "";
    const text = [
      `${label}: ${run.id}`,
      `objective: ${run.request.slice(0, 800)}`,
      state,
      run.error ? `error: ${run.error.slice(0, 400)}` : "",
      stopped ? "note: previous attempt stopped early; do not treat its conclusion as authoritative." : "",
      run.finalText && !stopped ? `result: ${run.finalText.slice(0, 1200)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    pending.push({
      kind: "parent-run",
      origin: "inherited",
      ref: run.id,
      depth: run.depth,
      body: text,
      band: 6,
    });
  }

  // The plan map is context only for the planner: include plans/index.md (or
  // the configured plan file), never the topic files, and never for other roles.
  if (input.agent === "planner") {
    const planPath = machine.context.planFile ?? "plans/index.md";
    const abs = withinRepo(layout.repoRoot, planPath);
    if (abs && existsSync(abs)) {
      const read = readFileText(abs);
      if (read) pending.push({ kind: "plan", origin: "inherited", ref: planPath, depth: 3, body: read.text, band: 7 });
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

  // Skills (descriptions only) + tool/command names. Individual skill
  // exclusions remove that skill's description; body items are filtered below.
  // Excluded means excluded everywhere: composer items, composer mode
  // overrides, and role presets all hide the description.
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
  const skills = skillMetas(layout).filter((skill) => !excludedSkillNames.has(skill.name));
  if (skills.length > 0) {
    const text = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    pending.push({ kind: "skill", origin: "explicit", ref: `${skills.length} skills`, depth: 0, body: text, band: 8 });
  }
  try {
    const commands = [...allCommands(layout).keys()].sort();
    if (commands.length > 0) {
      pending.push({
        kind: "tool",
        origin: "explicit",
        ref: `${commands.length} commands`,
        depth: 0,
        body: commands.join(", "),
        band: 8,
      });
    }
  } catch {
    // profiles unavailable — skip
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
  const seen = new Set<string>();
  const selected: Pending[] = [];
  for (const item of keptPending.sort((a, b) => a.band - b.band || (a.depth ?? 0) - (b.depth ?? 0))) {
    const key = `${item.kind}:${item.ref}`;
    const hash = sha1(item.body);
    if (seen.has(key) || seen.has(`h:${hash}`)) continue;
    seen.add(key);
    seen.add(`h:${hash}`);
    selected.push(item);
  }

  // Explicit per-section budgets: the usable input budget (limit minus the
  // caller's response reserve) is split into caps per section
  // (system/plan/files/tools/skills/parents). Over budget, whole sources are
  // dropped lowest-priority-first with a named omission; a kept block is
  // never sliced mid-content. Packets and plans are never dropped while
  // anything else remains, so the planner index and the explicit packet
  // survive file trimming.
  const { budget: usable, caps } = sectionBudgets(budget);
  const sectionOf = (item: Pending): ContextSection => sectionForKind(item.kind);

  // Drop rank: higher is dropped first. Aggregates (tool index, skill
  // descriptions) go first, then the parent chain, skill bodies, and
  // working-set files; packets and plans go last.
  const dropRank = (item: Pending): number => {
    if (item.kind === "tool") return 60;
    if (item.kind === "skill" && /^\d+ skills$/.test(item.ref)) return 60;
    if (item.kind === "parent-run") return 50;
    if (item.kind === "skill" || item.kind === "script") return 40;
    if (item.kind === "file" || item.kind === "knowledge" || item.kind === "reference") return 30;
    if (item.kind === "plan" || item.kind === "project") return item.origin === "explicit" ? 15 : 20;
    if (item.kind === "packet") return 10;
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
  for (const item of selected) {
    if (item.warning && item.body === "") {
      sources.push({ kind: item.kind, origin: item.origin, ref: item.ref, depth: item.depth, bytes: 0, hash: "", truncated: false, warning: item.warning });
      continue;
    }
    if (item.body.trim().length === 0) continue;
    entries.push({ ...item, len: item.body.length });
  }

  const sectionTotals = (): Record<ContextSection, number> => {
    const totals: Record<ContextSection, number> = { system: 0, plan: 0, files: 0, tools: 0, skills: 0, parents: 0 };
    for (const entry of entries) totals[sectionOf(entry)] += entry.len;
    return totals;
  };
  const totalLen = (): number => entries.reduce((sum, entry) => sum + entry.len, 0);

  let guard = entries.length + 1;
  while (totalLen() > usable && guard-- > 0) {
    // A lone droppable source that alone exceeds the budget is trimmed
    // below, not dropped, so the run keeps working context.
    if (entries.length <= 1) break;
    const totals = sectionTotals();
    let pool = entries.filter((entry) => dropRank(entry) > PROTECTED_RANK);
    if (pool.length === 0) break;
    // Sections over their cap yield first.
    const overCap = pool.filter((entry) => totals[sectionOf(entry)]! > caps[sectionOf(entry)]!);
    if (overCap.length > 0) pool = overCap;
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

  // Render every kept source. The runner may trim the prompt to the
  // selected model's input window, but that is a model limit, not a per-file
  // rule. Report the overage instead of silently changing a source.
  const blocks: string[] = [];
  for (const item of entries) {
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
  const used = totalLen();
  if (used > usable) {
    warnings.push(`curated context is ${used.toLocaleString()} chars; model input budget is ${budget.toLocaleString()} chars; the runner will trim to fit`);
  }

  const sections: ContextSections = { system: 0, plan: 0, files: 0, tools: 0, skills: 0, parents: 0 };
  for (const entry of entries) sections[sectionOf(entry)] += entry.len;

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
