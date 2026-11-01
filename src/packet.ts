/**
 * machine_code — task packets.
 *
 * The unit of work, context, and verification. Architect compiles one; the
 * runner saves it as an immutable snapshot before Build implements it.
 *
 * Canonical packets are committed JSON at .machine_code/tasks/<id>.json.
 * Legacy .md files that contain JSON remain readable. Ephemeral one-shot
 * snapshots live in .machine_code/local/tasks/ (gitignored). One resolver
 * serves orchestrate, queue, CLI, and TUI.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./paths.js";
import { writeJsonAtomic } from "./state/run-schema.js";

export type PacketMode = "solo" | "direct" | "verified" | "redundant";

export interface PacketAcceptance {
  command: string; // named command, e.g. typescript:test
  args?: Record<string, unknown>;
}

export interface TaskPacket {
  id: string;
  mode: PacketMode;
  agent?: "general" | "sudo" | "architect" | "build" | "review";
  budget_tokens?: number;
  goal: string;
  context: string[];
  constraints: string[];
  acceptance: PacketAcceptance[];
}

export function parseMode(value: string | undefined): PacketMode | undefined {
  if (value !== "solo" && value !== "direct" && value !== "verified" && value !== "redundant") return undefined;
  return value;
}

/** Committed, canonical packet file. */
export function packetPath(layout: Layout, id: string): string {
  return join(layout.repoDir, "tasks", `${id}.json`);
}

/** Gitignored, ephemeral packet snapshot. */
export function localPacketPath(layout: Layout, id: string): string {
  return join(layout.localDir, "tasks", `${id}.json`);
}

function parsePacketDoc(text: string): TaskPacket | null {
  try {
    const doc = JSON.parse(text) as TaskPacket;
    if (!doc || typeof doc !== "object" || !doc.id || !doc.mode || !doc.goal) return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * Resolve one packet by id. Search order: committed .json, committed legacy
 * .md, local .json, local legacy .md. Committed wins on id collisions.
 */
export function readPacket(layout: Layout, id: string): TaskPacket | null {
  const candidates = [
    packetPath(layout, id),
    join(layout.repoDir, "tasks", `${id}.md`),
    localPacketPath(layout, id),
    join(layout.localDir, "tasks", `${id}.md`),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const packet = parsePacketDoc(readFileSync(file, "utf8"));
    if (packet) return packet;
  }
  return null;
}

/**
 * Write a packet as canonical JSON. Default target is the committed tasks
 * directory; `local: true` writes an ephemeral snapshot instead. Atomic.
 */
export function writePacket(layout: Layout, packet: TaskPacket, opts: { local?: boolean } = {}): string {
  const file = opts.local ? localPacketPath(layout, packet.id) : packetPath(layout, packet.id);
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, packet);
  return file;
}

function listPacketDir(dir: string): TaskPacket[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") || n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: TaskPacket[] = [];
  for (const name of names) {
    try {
      const packet = parsePacketDoc(readFileSync(join(dir, name), "utf8"));
      if (packet) out.push(packet);
    } catch {
      // unreadable — skip
    }
  }
  return out;
}

/** All packets visible to this repo: committed first, then local snapshots. */
export function listPackets(layout: Layout): TaskPacket[] {
  const all = [
    ...listPacketDir(join(layout.repoDir, "tasks")),
    ...listPacketDir(join(layout.localDir, "tasks")),
  ];
  const seen = new Set<string>();
  const out: TaskPacket[] = [];
  for (const packet of all) {
    if (seen.has(packet.id)) continue;
    seen.add(packet.id);
    out.push(packet);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Committed packets only — the queue's processing set. */
export function listCommittedPackets(layout: Layout): TaskPacket[] {
  return listPacketDir(join(layout.repoDir, "tasks")).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export function newPacketId(request: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  const slug = request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${stamp}-${slug || "task"}`;
}
