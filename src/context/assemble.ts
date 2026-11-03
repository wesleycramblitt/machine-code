/**
 * machine_code — context assembly.
 *
 * Resolves, in priority order, then dedupes and budgets:
 *   1 explicit packet            (8 KiB)
 *   2 current Task               (6 KiB)
 *   3 parent Feature             (4 KiB)
 *   4 parent Epic                (3 KiB)
 *   5 explicit knowledge files   (6 KiB total)
 *   6 parent run + ancestor summaries (2 KiB each)
 *   7 plan files / knowledge index (2 KiB each)
 *   8 skill descriptions / tools (1 KiB)
 *
 * Every block is labelled with its source and origin; context.json records the
 * manifest (hash, bytes, truncation, warnings) so the model's context is
 * traceable. Nothing is preloaded that was not asked for by the run or an
 * ancestor.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Layout } from "../paths.js";
import type { MachineConfig } from "../config.js";
import type { Issue, IssueProvider, IssueRef } from "../issues/provider.js";
import { readPacket } from "../packet.js";
import { allCommands } from "../commands/profiles.js";
import { artifactExists, artifactPath, artifactSummary, resolveArtifact } from "../artifacts/registry.js";
import { parseArtifactReferences, skillMetas } from "./references.js";
import { discoverPlanFiles } from "./plans.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBundle,
  type ContextKind,
  type ContextOrigin,
  type ContextSource,
} from "./types.js";

const KIB = 1024;

interface Pending {
  kind: ContextKind;
  origin: ContextOrigin;
  ref: string;
  depth?: number;
  body: string;
  cap: number;
  band: number;
  warning?: string;
}

export interface ContextExclusion {
  /** Whole composer sections: issues, files, knowledge, skills, tools, scripts, plans. */
  sections?: string[];
  /** Per-source keys shaped as `kind:ref` (for issues, `task:repo#n`). */
  items?: string[];
}

export interface ContextInclude {
  /** Repo-relative knowledge files to add explicitly from the composer. */
  knowledge?: string[];
}

export interface AssembleInput {
  layout: Layout;
  machine: MachineConfig;
  provider?: IssueProvider;
  issue?: IssueRef;
  packetId?: string;
  /** Parent run and its ancestors, nearest first, for selected context inheritance. */
  parentRuns?: Array<{ id: string; request: string; finalText?: string; depth?: number }>;
  /** Parent run, for selected context inheritance (summary only). */
  parentRun?: { id: string; request: string; finalText?: string };
  /** Override the configured character budget. */
  budgetChars?: number;
  /** Drop whole sections or individual sources selected in the composer. */
  exclude?: ContextExclusion;
  /** Add files selected in the composer that no issue references. */
  include?: ContextInclude;
}

const SECTION_KINDS: Record<string, readonly ContextKind[]> = {
  issues: ["task", "feature", "epic"],
  files: ["file"],
  knowledge: ["knowledge"],
  skills: ["skill"],
  tools: ["tool"],
  scripts: ["script"],
  plans: ["plan", "project"],
};

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function clip(text: string, cap: number): { body: string; truncated: boolean } {
  if (text.length <= cap) return { body: text, truncated: false };
  return { body: text.slice(0, cap).replace(/\s+$/, "") + "\n…[truncated]", truncated: true };
}

function withinRepo(root: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const abs = resolve(root, path);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

function renderIssue(issue: Issue): string {
  const lines = [
    `title: ${issue.title}`,
    `state: ${issue.state}  kind: ${issue.kind}  ref: ${issue.ref.repo}#${issue.ref.number}`,
  ];
  if (issue.labels.length > 0) lines.push(`labels: ${issue.labels.join(", ")}`);
  if (issue.acceptance.length > 0) lines.push("acceptance:", ...issue.acceptance.map((a) => `- ${a}`));
  if (issue.body.trim()) lines.push("", issue.body.trim());
  return lines.join("\n");
}

function readFileCapped(file: string, cap: number): { text: string; warning?: string } | null {
  try {
    const raw = readFileSync(file, "utf8");
    return { text: raw.slice(0, cap) };
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

  // Explicit packet (runner-provided or issue-referenced).
  const packetIds = new Set<string>();
  if (input.packetId) packetIds.add(input.packetId);

  // Composer selections are known before pending items are built so they can
  // filter aggregate blocks (skill descriptions) as well as complete items.
  const excludedSections = new Set(input.exclude?.sections ?? []);
  const excludedItems = new Set(input.exclude?.items ?? []);

  // Issue hierarchy + explicit references. Artifacts cascade Task → Feature →
  // Epic; nearest declarations win, and every block keeps its true origin.
  let current: Issue | undefined;
  const ancestors: Issue[] = [];
  if (input.provider && input.issue) {
    current = (await input.provider.get(input.issue)) ?? undefined;
    if (current) {
      ancestors.push(...(await input.provider.hierarchy(current.ref)));

      const chain = [current, ...ancestors].slice(0, 3);
      const seenRefs = new Set<string>();
      for (let depth = 0; depth < chain.length; depth++) {
        const issue = chain[depth]!;
        const origin: ContextOrigin = depth === 0 ? "explicit" : "inherited";
        const band = 2 + depth;
        const refs = parseArtifactReferences(issue.body);
        for (const id of refs.packets) {
          const key = `packet:${id}`;
          if (!seenRefs.has(key)) {
            seenRefs.add(key);
            packetIds.add(id);
          }
        }

        const addFile = (path: string, kind: "file" | "knowledge"): void => {
          const key = `${kind}:${path}`;
          if (seenRefs.has(key)) return;
          seenRefs.add(key);
          const abs = withinRepo(layout.repoRoot, path);
          if (!abs || !existsSync(abs)) {
            pending.push({
              kind,
              origin,
              ref: path,
              depth,
              body: "",
              cap: 0,
              band,
              warning: `referenced ${kind} is missing or outside the repo`,
            });
            return;
          }
          const read = readFileCapped(abs, 8 * KIB);
          if (read) pending.push({ kind, origin, ref: path, depth, body: read.text, cap: 8 * KIB, band });
        };

        for (const path of refs.files) addFile(path, "file");
        for (const path of refs.knowledge) addFile(path, "knowledge");

        for (const name of refs.skills) {
          const key = `skill:${name}`;
          if (seenRefs.has(key)) continue;
          seenRefs.add(key);
          const skill = skillBody(layout, name);
          if (!skill) {
            pending.push({
              kind: "skill",
              origin,
              ref: name,
              depth,
              body: "",
              cap: 0,
              band,
              warning: `referenced skill "${name}" was not found`,
            });
            continue;
          }
          pending.push({
            kind: "skill",
            origin,
            ref: name,
            depth,
            body: skill.text,
            cap: 4 * KIB,
            band,
          });
        }

        for (const [list, kind] of [
          [refs.tools, "tool"],
          [refs.scripts, "script"],
        ] as const) {
          for (const ref of list) {
            const key = `${kind}:${ref}`;
            if (seenRefs.has(key)) continue;
            seenRefs.add(key);
            const artifact = resolveArtifact(layout, ref);
            if (!artifact || !artifactExists(layout, artifact)) {
              pending.push({
                kind,
                origin,
                ref,
                depth,
                body: "",
                cap: 0,
                band,
                warning: `referenced ${kind} "${ref}" was not found`,
              });
              continue;
            }
            const path = artifactPath(layout, artifact);
            const content = path ? readFileCapped(path, 2 * KIB) : null;
            const body = [
              artifactSummary(artifact),
              path ? `path: ${path}` : "",
              content?.text ? `\n${content.text}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            pending.push({ kind, origin, ref: artifact.name, depth, body, cap: 3 * KIB, band });
          }
        }
      }
    }
  }

  // Explicit composer includes. These are user-selected knowledge files that
  // no issue or configured index references; they are still ordinary
  // provenance-tracked context blocks.
  for (const path of input.include?.knowledge ?? []) {
    const abs = withinRepo(layout.repoRoot, path);
    if (!abs || !existsSync(abs)) {
      pending.push({
        kind: "knowledge",
        origin: "explicit",
        ref: path,
        body: "",
        cap: 0,
        band: 1,
        warning: "included knowledge is missing or outside the repo",
      });
      continue;
    }
    const read = readFileCapped(abs, 8 * KIB);
    if (read) {
      pending.push({ kind: "knowledge", origin: "explicit", ref: path, body: read.text, cap: 8 * KIB, band: 1 });
    }
  }

  // Task / Feature / Epic blocks (task first, then nearest ancestor).
  if (current) {
    pending.push({
      kind: "task",
      origin: "explicit",
      ref: `${current.ref.repo}#${current.ref.number}`,
      depth: 0,
      body: renderIssue(current),
      cap: 6 * KIB,
      band: 2,
    });
    let depth = 1;
    for (const ancestor of ancestors) {
      const kind: ContextKind = depth === 1 ? "feature" : "epic";
      pending.push({
        kind,
        origin: "inherited",
        ref: `${ancestor.ref.repo}#${ancestor.ref.number}`,
        depth,
        body: renderIssue(ancestor),
        cap: kind === "feature" ? 4 * KIB : 3 * KIB,
        band: kind === "feature" ? 3 : 4,
      });
      depth += 1;
      if (depth > 2) break;
    }
  }

  // Packets.
  for (const id of packetIds) {
    const packet = readPacket(layout, id);
    if (!packet) {
      pending.push({ kind: "packet", origin: "explicit", ref: id, body: "", cap: 0, band: 1, warning: "packet not found" });
      continue;
    }
    pending.push({
      kind: "packet",
      origin: "explicit",
      ref: packet.id,
      body: JSON.stringify(packet, null, 2),
      cap: 8 * KIB,
      band: 1,
    });
  }

  // Parent run + ancestors. A fork inherits the immediate parent's objective and
  // result, then the chain above it (grandparent, …) so a fork of a fork does
  // not lose the original task.
  const chain: Array<{ id: string; request: string; finalText?: string; depth: number }> =
    input.parentRuns && input.parentRuns.length > 0
      ? input.parentRuns.map((run, index) => ({ ...run, depth: run.depth ?? index + 1 }))
      : input.parentRun
        ? [{ ...input.parentRun, depth: 1 }]
        : [];
  for (const run of chain) {
    if (run.depth > 4) break;
    const label =
      run.depth <= 1 ? "parent run" : run.depth === 2 ? "grandparent run" : `ancestor run (depth ${run.depth})`;
    const text = [
      `${label}: ${run.id}`,
      `objective: ${run.request.slice(0, 800)}`,
      run.finalText ? `result: ${run.finalText.slice(0, 1200)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    pending.push({
      kind: "parent-run",
      origin: "inherited",
      ref: run.id,
      depth: run.depth,
      body: text,
      cap: 2 * KIB,
      band: 6,
    });
  }

  // Plan files + knowledge index.
  for (const planPath of discoverPlanFiles(layout, machine.context.planFile)) {
    const abs = withinRepo(layout.repoRoot, planPath)!;
    const read = readFileCapped(abs, 2 * KIB);
    if (read) pending.push({ kind: "plan", origin: "inherited", ref: planPath, body: read.text, cap: 2 * KIB, band: 7 });
  }
  if (machine.context.knowledgeIndex) {
    const abs = withinRepo(layout.repoRoot, machine.context.knowledgeIndex);
    if (abs && existsSync(abs)) {
      const read = readFileCapped(abs, 2 * KIB);
      if (read) {
        pending.push({
          kind: "knowledge",
          origin: "inherited",
          ref: machine.context.knowledgeIndex,
          body: read.text,
          cap: 2 * KIB,
          band: 7,
        });
      }
    }
  }

  // Skills (descriptions only) + tool/command names. Individual skill
  // exclusions remove that skill's description; body items are filtered below.
  const excludedSkillNames = new Set(
    [...excludedItems]
      .filter((key) => key.startsWith("skill:"))
      .map((key) => key.slice("skill:".length)),
  );
  const skills = skillMetas(layout).filter((skill) => !excludedSkillNames.has(skill.name));
  if (skills.length > 0) {
    const text = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    pending.push({ kind: "skill", origin: "explicit", ref: `${skills.length} skills`, body: text, cap: 1 * KIB, band: 8 });
  }
  try {
    const commands = [...allCommands(layout).keys()].sort();
    if (commands.length > 0) {
      pending.push({
        kind: "tool",
        origin: "explicit",
        ref: `${commands.length} commands`,
        body: commands.join(", "),
        cap: 1 * KIB,
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

  // Budget + render.
  const sources: ContextSource[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const item of selected) {
    if (item.warning && item.body === "") {
      sources.push({ kind: item.kind, origin: item.origin, ref: item.ref, depth: item.depth, bytes: 0, hash: "", truncated: false, warning: item.warning });
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) break;
    const allowed = Math.min(item.cap, remaining);
    const clipped = clip(item.body, allowed);
    if (clipped.body.trim().length === 0) continue;
    used += clipped.body.length;
    const attrs = [
      `kind="${item.kind}"`,
      `source="${item.ref.replace(/"/g, "'")}"`,
      `origin="${item.origin}"`,
      ...(item.depth !== undefined ? [`depth="${item.depth}"`] : []),
    ];
    blocks.push(`<context-block ${attrs.join(" ")}>\n${clipped.body}\n</context-block>`);
    sources.push({
      kind: item.kind,
      origin: item.origin,
      ref: item.ref,
      depth: item.depth,
      bytes: clipped.body.length,
      hash: sha1(clipped.body),
      truncated: clipped.truncated,
    });
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

  return { text, sources, chars: text.length };
}
