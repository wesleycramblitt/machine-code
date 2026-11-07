/**
 * machine_code — packet-file work model.
 *
 * Ground truth for "what needs doing" lives as files under `plans/`:
 *
 *   plans/plan.md    the index — headings are categories, lines are work items
 *   plans/<slug>.md  one packet — the bounded contract for ONE buildable unit
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
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { Layout } from "../paths.js";
import { parseVerificationCommands, type TaskPacket } from "../packet.js";

export const PLANS_DIR = "plans";
export const INDEX_FILE = "plan.md";

export const PACKET_STATUSES = ["todo", "in-progress", "blocked", "done"] as const;
export type PacketStatus = (typeof PACKET_STATUSES)[number];

export interface PacketFile {
  slug: string;
  status: PacketStatus;
  deps: string[];
  blocked: string;
  deliverable: string;
  files: string[];
  acceptance: string[];
  verify: string[];
}

/* ---------------------------------------------------------------- slugs */

/** Lowercase, hyphen-separated, trimmed slug from free text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** True when the string is already a safe packet slug. */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 48 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);
}

/** Branch for a packet: `mc/<slug>`. */
export function packetBranch(slug: string): string {
  return `mc/${slug}`;
}

/* ---------------------------------------------------------------- paths */

export function plansDir(layout: Layout): string {
  return join(layout.repoRoot, PLANS_DIR);
}

export function indexPath(layout: Layout): string {
  return join(plansDir(layout), INDEX_FILE);
}

export function packetFilePath(layout: Layout, slug: string): string {
  return join(plansDir(layout), `${slug}.md`);
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
 * Parse a packet document (`plans/<slug>.md`). A missing front-matter block is
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
  const dir = plansDir(layout);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PacketFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === INDEX_FILE) continue;
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
  const front: Record<string, unknown> = { status: packet.status, deps: packet.deps };
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
  mkdirSync(plansDir(layout), { recursive: true });
  writeFileSync(file, renderPacketFile(packet), "utf8");
  return file;
}

/** Whether a packet supplies the minimum to dispatch a build. */
export function isBuildable(packet: Pick<PacketFile, "status" | "deliverable" | "verify">): boolean {
  return packet.status !== "done" && packet.status !== "blocked" && packet.deliverable.trim().length > 0 && packet.verify.length > 0;
}

/* ------------------------------------------------------------- index */

const DEFAULT_HEADINGS = ["Features", "Bugs", "Ideas", "Done"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHeadingLine(line: string): boolean {
  return /^\s*#{1,6}(\s|$)/.test(line);
}

/** `- [ ] slug — title` / `- [x] slug — title` / optional `→ plans/<slug>.md` link. */
export function indexLine(slug: string, title: string, opts: { done?: boolean; link?: boolean } = {}): string {
  const box = opts.done ? "[x]" : "[ ]";
  const label = title.trim() ? ` — ${title.trim()}` : "";
  const link = opts.link === false ? "" : ` → ${PLANS_DIR}/${slug}.md`;
  return `- ${box} ${slug}${label}${link}`;
}

/** Ensure `plans/plan.md` exists with the standard category headings. */
export function ensureIndex(layout: Layout): string {
  const file = indexPath(layout);
  if (!existsSync(file)) {
    mkdirSync(plansDir(layout), { recursive: true });
    writeFileSync(file, `# Plan\n\n${DEFAULT_HEADINGS.map((heading) => `## ${heading}\n\n`).join("")}`, "utf8");
  }
  return file;
}

function slugReference(line: string, slug: string): boolean {
  return line.includes(`${PLANS_DIR}/${slug}.md`) || new RegExp(`(^|\\W)${escapeRegExp(slug)}(\\.|\\s|$)`).test(line);
}

/**
 * Insert or replace a work-item line under a heading. Missing headings are
 * created at the end; an existing line for the slug is replaced in place.
 */
export function addIndexEntry(
  layout: Layout,
  heading: string,
  slug: string,
  title: string,
  opts: { done?: boolean; link?: boolean } = {},
): void {
  const file = ensureIndex(layout);
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

/** Remove every work-item line referencing a slug. */
export function removeIndexEntry(layout: Layout, slug: string): void {
  const file = indexPath(layout);
  if (!existsSync(file)) return;
  const next = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !(/^\s*-\s+\[[ x]\]\s/.test(line) && slugReference(line, slug)))
    .join("\n");
  writeFileSync(file, next, "utf8");
}

/** Move an item to `## Done`: drop the live line, append a checked one. */
export function markIndexDone(layout: Layout, slug: string, title: string): void {
  removeIndexEntry(layout, slug);
  addIndexEntry(layout, "Done", slug, title, { done: true, link: false });
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

/** Read index + packet files and render an annotated human view. */
export function renderPlan(layout: Layout): PlanView {
  const file = indexPath(layout);
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : ["# Plan", ""];
  const packets = new Map(listPacketFiles(layout).map((packet) => [packet.slug, packet]));

  const items: PlanItem[] = [];
  const rendered: string[] = [];
  let heading = "";
  for (const line of lines) {
    if (isHeadingLine(line)) {
      heading = line.replace(/^\s*#{1,6}\s*/, "").trim();
      rendered.push(line);
      continue;
    }
    const bullet = line.match(/^\s*-\s+\[([ x])\]\s+(.*)$/);
    if (!bullet) {
      rendered.push(line);
      continue;
    }
    const done = bullet[1] === "x";
    let rest = (bullet[2] ?? "").trim();

    // Completed lines resolve against a (likely deleted) packet; keep `## Done`
    // lines verbatim rather than mis-annotating them with a stale status.
    if (done) {
      rendered.push(line);
      items.push({ heading, done, title: rest, hasPacket: false });
      continue;
    }

    let slug: string | undefined;
    const link = rest.match(new RegExp(`^(.*?)\\s*→\\s*${PLANS_DIR}/([^)]+\\.md)\\s*$`));
    if (link) rest = (link[1] ?? "").trim();
    const split = rest.split("—").map((part) => part.trim());
    const firstToken = split[0] ?? "";
    if (firstToken && isValidSlug(firstToken) && packets.has(firstToken)) {
      slug = firstToken;
      rest = split.slice(1).join(" — ").trim();
    }
    const packet = slug ? packets.get(slug) : undefined;
    const hasPacket = Boolean(packet);
    const status = packet?.status;
    const title = rest || packet?.deliverable || "";

    if (!slug && !hasPacket) {
      // Plain idea line with no packet: render untouched.
      rendered.push(line);
      items.push({ heading, done, title: rest || firstToken, hasPacket: false });
      continue;
    }

    const parts: string[] = [];
    if (slug) {
      const glyph = status ? `${statusGlyph(status)} ${status}` : "";
      const branchTag = status && status !== "done" ? `  ⤳ ${packetBranch(slug)}` : "";
      parts.push(`${line}  ${glyph}${branchTag}`.trimEnd());
      if (packet?.blocked) parts.push(`      blocked: ${packet.blocked}`);
      if (packet && packet.deps.length > 0) parts.push(`      deps: ${packet.deps.join(", ")}`);
    }
    rendered.push(...parts);

    items.push({
      heading,
      done,
      ...(slug ? { slug } : {}),
      title,
      hasPacket,
      ...(status ? { status } : {}),
      ...(packet?.blocked ? { blocked: packet.blocked } : {}),
    });
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
