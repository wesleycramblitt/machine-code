/**
 * machine_code — packet-file work model.
 *
 * Two file trees: the hand-written plan map under `plans/`, and the
 * machine-built contracts under `packets/`.
 *
 *   plans/index.md   the index — headings are categories, lines are work items
 *   plans/<topic>.md optional per-category handwritten plans
 *   packets/<slug>.md  one packet — the bounded contract for ONE buildable unit
 *
 * Slugs are human-readable (`login-token-refresh`, not `#42`) and derive the
 * branch (`mc/<slug>`) and worktree name, so nothing is stored in two places.
 *
 * A packet file is TOML front-matter plus markdown sections:
 *
 *   ---
 *   status = "todo"      # todo | in-progress | blocked  (done is terminal)
 *   deps = []            # slugs this packet waits on
 *   blocked = ""         # reason, only when status = "blocked"
 *   ---
 *   # <slug>
 *
 *   ## Deliverable
 *   ...
 *   ## Files
 *   - src/...
 *   ## Acceptance
 *   - ...
 *   ## Verify
 *   typescript:test
 *
 * Verification commands must be named commands (or the small npm alias table
 * in packet.ts), because acceptance gates dispatch through the command
 * registry — never shell strings. Parsing is lenient: unknown front-matter keys
 * are ignored, absent sections become empty, and the spec this module writes is
 * canonical so later readers are simpler than the writers people hand-edit.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import type { Layout } from "../paths.js";
import { parseVerificationCommands, type TaskPacket } from "../packet.js";

export const PLANS_DIR = "plans";
export const INDEX_FILE = "index.md";
export const PACKETS_DIR = "packets";

export const PACKET_STATUSES = ["todo", "in-progress", "blocked", "done"] as const;
export type PacketStatus = (typeof PACKET_STATUSES)[number];

/**
 * How a packet is gated before it can be merged.
 * - `gates`  deterministic `## Verify` commands only (default; small work)
 * - `agent`  gates + an independent Review agent verdict (consequential work)
 * - `human`  gates only, but never auto-merged by `batch --auto-approve`
 */
export const PACKET_REVIEWS = ["gates", "agent", "human"] as const;
export type PacketReview = (typeof PACKET_REVIEWS)[number];

export interface PacketFile {
  slug: string;
  status: PacketStatus;
  deps: string[];
  blocked: string;
  /** Merge gate. Absent means `gates`. */
  review?: PacketReview;
  deliverable: string;
  files: string[];
  acceptance: string[];
  verify: string[];
}

/* ---------------------------------------------------------------- slugs */

import { isValidSlug, slugify } from "./slug.js";
import { planItems, PLAN_ITEM_KINDS, PLAN_ITEM_KIND_LABELS } from "./items.js";

export { isValidSlug, slugify };

/** Branch for a packet: `mc/<slug>`. */
export function packetBranch(slug: string): string {
  return `mc/${slug}`;
}

/* ---------------------------------------------------------------- paths */

export function plansDir(layout: Layout): string {
  return join(layout.repoRoot, PLANS_DIR);
}

export function packetsDir(layout: Layout): string {
  return join(layout.repoRoot, PACKETS_DIR);
}

export function indexPath(layout: Layout): string {
  return join(plansDir(layout), INDEX_FILE);
}

export function packetFilePath(layout: Layout, slug: string): string {
  return join(packetsDir(layout), `${slug}.md`);
}

/* ---------------------------------------------------------------- parsing */

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Split the body into `heading` → `lines` (headings lowercased, trimmed). */
function sections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "";
  for (const line of body.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      current = (heading[1] ?? "").trim().toLowerCase();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (current) out.get(current)!.push(line);
  }
  return out;
}

/** Bullet or plain non-empty lines, trimmed; blank and heading lines skipped. */
function itemLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s+/.test(line)) continue;
    const bullet = line.match(/^\s*(?:[-*](\s+\[[ x]\]\s+)?|\d+\.\s+)\s*(.*)$/);
    out.push(bullet ? (bullet[2] ?? "").trim() : line);
  }
  return out.filter(Boolean);
}

function firstNonEmpty(lines: string[]): string {
  return lines.find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** `## Verify` commands, mapped to named commands via packet.ts. */
function verifyCommands(lines: string[]): string[] {
  const synthetic = ["## Verification", ...lines].join("\n");
  return parseVerificationCommands(synthetic);
}

export interface ParsePacketResult {
  packet?: PacketFile;
  error?: string;
}

/**
 * Parse a packet document (`packets/<slug>.md`). A missing front-matter block is
 * treated as all defaults; invalid TOML is a hard parse error.
 */
export function parsePacketDoc(slug: string, text: string): ParsePacketResult {
  let front: Record<string, unknown> = {};
  let body = text;
  const fm = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  if (fm) {
    try {
      const parsed = parse(fm[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
    } catch (error) {
      return { error: `${slug}: front-matter is not valid TOML: ${(error as Error).message}` };
    }
    body = text.slice(fm[0].length);
  }

  const status = oneOf(front.status, PACKET_STATUSES) ?? "todo";
  const review = oneOf(front.review, PACKET_REVIEWS) ?? "gates";
  const sec = sections(body);
  const deliverable = firstNonEmpty(sec.get("deliverable") ?? []);
  const files = itemLines(sec.get("files") ?? []);
  const acceptance = itemLines(sec.get("acceptance") ?? []);
  const verify = verifyCommands(sec.get("verify") ?? sec.get("verification") ?? []);

  return {
    packet: {
      slug,
      status,
      deps: stringList(front.deps).filter(isValidSlug),
      blocked: typeof front.blocked === "string" ? front.blocked.trim() : "",
      review,
      deliverable,
      files,
      acceptance,
      verify,
    },
  };
}

/** A packet declares itself: TOML front-matter or a `## Deliverable` section. */
function hasPacketShape(text: string): boolean {
  if (/^---\s*\n/.test(text)) return true;
  return /^#{1,6}\s+deliverable\s*$/im.test(text);
}

export function readPacketFile(layout: Layout, slug: string): PacketFile | null {
  const file = packetFilePath(layout, slug);
  if (!existsSync(file)) return null;
  const parsed = parsePacketDoc(slug, readFileSync(file, "utf8"));
  return parsed.packet ?? null;
}

export function listPacketFiles(layout: Layout): PacketFile[] {
  const dir = packetsDir(layout);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PacketFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -".md".length);
    if (!isValidSlug(slug)) continue;
    const file = join(dir, name);
    try {
      if (!hasPacketShape(readFileSync(file, "utf8"))) continue;
    } catch {
      continue;
    }
    const packet = readPacketFile(layout, slug);
    if (packet) out.push(packet);
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/* ---------------------------------------------------------------- writing */

/** Canonical packet-file body from a PacketFile. */
export function renderPacketFile(packet: PacketFile): string {
  const front: Record<string, unknown> = { status: packet.status, deps: packet.deps, review: packet.review ?? "gates" };
  if (packet.blocked) front.blocked = packet.blocked;
  const sectionsText: string[] = [
    `# ${packet.slug}`,
    "",
    "## Deliverable",
    packet.deliverable || "",
  ];
  if (packet.files.length > 0) {
    sectionsText.push("", "## Files", ...packet.files.map((file) => `- ${file}`));
  }
  if (packet.acceptance.length > 0) {
    sectionsText.push("", "## Acceptance", ...packet.acceptance.map((entry) => `- ${entry}`));
  }
  sectionsText.push("", "## Verify", ...(packet.verify.length > 0 ? packet.verify : [""]));
  return `---\n${stringify(front)}\n---\n\n${sectionsText.join("\n")}\n`;
}

/** Write a packet file atomically-ish; returns the path. */
export function writePacketFile(layout: Layout, packet: PacketFile): string {
  const file = packetFilePath(layout, packet.slug);
  if (packet.slug !== packet.slug.trim() || !isValidSlug(packet.slug)) {
    throw new Error(`invalid packet slug: ${JSON.stringify(packet.slug)}`);
  }
  mkdirSync(packetsDir(layout), { recursive: true });
  writeFileSync(file, renderPacketFile(packet), "utf8");
  return file;
}

/** Whether a packet supplies the minimum to dispatch a build. */
export function isBuildable(packet: Pick<PacketFile, "status" | "deliverable" | "verify">): boolean {
  return packet.status !== "done" && packet.status !== "blocked" && packet.deliverable.trim().length > 0 && packet.verify.length > 0;
}

/* ------------------------------------------------------------- index */

const DEFAULT_HEADINGS = ["Features", "Bugs", "Ideas"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHeadingLine(line: string): boolean {
  return /^\s*#{1,6}(\s|$)/.test(line);
}

/** `- [ ] slug — title` / `- [x] slug — title` / optional `→ packets/<slug>.md` link. */
export function indexLine(slug: string, title: string, opts: { done?: boolean; link?: boolean } = {}): string {
  const box = opts.done ? "[x]" : "[ ]";
  const label = title.trim() ? ` — ${title.trim()}` : "";
  const link = opts.link === false ? "" : ` → ${PACKETS_DIR}/${slug}.md`;
  return `- ${box} ${slug}${label}${link}`;
}

/** Ensure `plans/index.md` exists with the standard category headings. */
export function ensureIndex(layout: Layout): string {
  const file = indexPath(layout);
  if (!existsSync(file)) {
    mkdirSync(plansDir(layout), { recursive: true });
    writeFileSync(file, `# Plan\n\n${DEFAULT_HEADINGS.map((heading) => `## ${heading}\n\n`).join("")}`, "utf8");
  }
  return file;
}

/** Ensure a plan file exists (repo-relative), creating it with a title. */
function ensurePlanFile(layout: Layout, planPath: string): string {
  const base = resolve(layout.repoRoot);
  const abs = resolve(base, planPath);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`plan file is outside the repo: ${planPath}`);
  }
  if (!abs.endsWith(".md")) throw new Error(`plan file must be Markdown: ${planPath}`);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    const title = (abs.split(sep).pop() ?? "Plan").replace(/\.md$/, "");
    writeFileSync(abs, `# ${title}\n`, "utf8");
  }
  return abs;
}

function slugReference(line: string, slug: string): boolean {
  return line.includes(`${PACKETS_DIR}/${slug}.md`) || new RegExp(`(^|\\W)${escapeRegExp(slug)}(\\.|\\s|$)`).test(line);
}

/**
 * Insert or replace a work-item line under a heading. Missing headings are
 * created at the end; an existing line for the slug is replaced in place.
 * `opts.plan` writes into that plan file instead of `plans/index.md`, so
 * items live next to the plan they belong to.
 */
export function addIndexEntry(
  layout: Layout,
  heading: string,
  slug: string,
  title: string,
  opts: { done?: boolean; link?: boolean; plan?: string } = {},
): void {
  const file = opts.plan ? ensurePlanFile(layout, opts.plan) : ensureIndex(layout);
  const line = indexLine(slug, title, { done: opts.done, link: opts.link });
  const lines = readFileSync(file, "utf8").split("\n");
  const headingTitle = heading.trim();
  let headingIndex = lines.findIndex(
    (entry) => isHeadingLine(entry) && entry.replace(/^\s*#{1,6}\s*/, "").trim().toLowerCase() === headingTitle.toLowerCase(),
  );
  if (headingIndex < 0) {
    lines.push("", `## ${headingTitle}`, line, "");
    writeFileSync(file, lines.join("\n").replace(/\n{3,}$/, "\n\n"), "utf8");
    return;
  }
  // Find the section bounds [headingIndex, sectionEnd).
  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (isHeadingLine(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }
  // Replace an existing bullet for this slug, else insert after the last item.
  for (let i = headingIndex + 1; i < sectionEnd; i++) {
    if (/^\s*-\s+\[[ x]\]\s/.test(lines[i] ?? "") && slugReference(lines[i]!, slug)) {
      lines[i] = line;
      writeFileSync(file, lines.join("\n"), "utf8");
      return;
    }
  }
  let insertAt = headingIndex + 1;
  for (let i = headingIndex + 1; i < sectionEnd; i++) {
    if (/^\s*-\s+\[[ x]\]\s/.test(lines[i] ?? "")) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, line);
  writeFileSync(file, lines.join("\n"), "utf8");
}

/* -------------------------------------------------------------- render */

function statusGlyph(status: PacketStatus): string {
  switch (status) {
    case "todo":
      return "○";
    case "in-progress":
      return "●";
    case "blocked":
      return "⏸";
    case "done":
      return "✓";
  }
}

export interface PlanItem {
  heading: string;
  done: boolean;
  /** Slug when the line keys a packet (or links to one). */
  slug?: string;
  title: string;
  hasPacket: boolean;
  status?: PacketStatus;
  blocked?: string;
}

export interface PlanView {
  items: PlanItem[];
  text: string;
}

/**
 * Render the plan tree: every plan file, its item types, and each item's
 * status/blocker annotations from its linked packet. Items come from every
 * plan file, not just `plans/index.md`.
 */
export function renderPlan(layout: Layout): PlanView {
  const packets = new Map(listPacketFiles(layout).map((packet) => [packet.slug, packet]));
  const workItems = planItems(layout);
  const items: PlanItem[] = [];
  const rendered: string[] = ["# Plans"];
  const byPlan = new Map<string, { title: string; items: typeof workItems }>();
  for (const item of workItems) {
    const entry = byPlan.get(item.plan) ?? { title: item.planTitle, items: [] };
    entry.items.push(item);
    byPlan.set(item.plan, entry);
  }
  for (const [plan, entry] of [...byPlan.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title))) {
    rendered.push("", `## ${entry.title}`, `_${plan}_`);
    for (const kind of PLAN_ITEM_KINDS) {
      const list = entry.items.filter((item) => item.kind === kind);
      if (list.length === 0) continue;
      rendered.push("", `### ${PLAN_ITEM_KIND_LABELS[kind]}`);
      for (const item of [...list].sort((a, b) => a.line - b.line)) {
        const packet =
          item.kind === "idea"
            ? undefined
            : (item.packet ? packets.get(item.packet) : undefined) ?? packets.get(item.slug);
        const status = item.done ? "done" : packet?.status;
        const glyph = status ? `${statusGlyph(status)} ${status}` : "";
        const branchTag = packet && status && status !== "done" ? `  ⤳ ${packetBranch(packet.slug)}` : "";
        const box = item.done ? "x" : " ";
        rendered.push(`- [${box}] ${item.slug}${item.title ? ` — ${item.title}` : ""}  ${glyph}${branchTag}`.trimEnd());
        if (packet?.blocked) rendered.push(`      blocked: ${packet.blocked}`);
        if (packet && packet.deps.length > 0) rendered.push(`      deps: ${packet.deps.join(", ")}`);
        items.push({
          heading: `${entry.title} / ${PLAN_ITEM_KIND_LABELS[kind]}`,
          done: item.done,
          slug: item.slug,
          title: item.title,
          hasPacket: Boolean(packet),
          ...(status ? { status: status as PacketStatus } : {}),
          ...(packet?.blocked ? { blocked: packet.blocked } : {}),
        });
      }
    }
  }
  return { items, text: rendered.join("\n") };
}

/* ------------------------------------------------------- packet → Task */
/** Convert a packet file into the canonical `TaskPacket` the loop executes. */
export function toTaskPacket(packet: PacketFile): TaskPacket {
  const constraints: string[] = [];
  if (packet.acceptance.length > 0) constraints.push(packet.acceptance.map((entry) => `- ${entry}`).join("\n"));
  return {
    id: packet.slug,
    goal: packet.deliverable.trim() || packet.slug,
    context: [...packet.files],
    constraints,
    acceptance: packet.verify.map((command) => ({ command })),
  };
}
