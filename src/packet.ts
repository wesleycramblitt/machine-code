/**
 * machine_code — task packet.
 *
 * The unit of work, context, and verification. Architect compiles one; the
 * runner saves it as an immutable snapshot before Build implements it. Human
   -authored packets live in .machine_code/tasks/ and are processed in filename
   order by the queue (M4).
 *
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";

export type PacketMode = "direct" | "verified" | "redundant";

export interface PacketAcceptance {
  command: string; // named command, e.g. typescript:test
  args?: Record<string, unknown>;
}

export interface TaskPacket {
  id: string;
  mode: PacketMode;
  budget_tokens?: number;
  goal: string;
  context: string[];
  constraints: string[];
  acceptance: PacketAcceptance[];
}

export function parseMode(value: string | undefined): PacketMode | undefined {
  if (value !== "direct" && value !== "verified" && value !== "redundant") return undefined;
  return value;
}

export function packetPath(layout: Layout, id: string): string {
  return join(layout.localDir, "tasks", `${id}.md`);
}

export function readPacket(layout: Layout, id: string): TaskPacket | null {
  const file = packetPath(layout, id);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as TaskPacket;
    if (!doc.id || !doc.mode || !doc.goal) return null;
    return doc;
  } catch {
    return null;
  }
}

export function writePacket(layout: Layout, packet: TaskPacket): string {
  const dir = join(layout.localDir, "tasks");
  mkdirSync(dir, { recursive: true });
  const file = packetPath(layout, packet.id);
  writeFileSync(file, JSON.stringify(packet, null, 2) + "\n", "utf8");
  return file;
}

export function listPackets(layout: Layout): TaskPacket[] {
  const dir = join(layout.localDir, "tasks");
  if (!existsSync(dir)) return [];
  const entries = require_readdir(dir).filter((e) => e.endsWith(".md"));
  const out: TaskPacket[] = [];
  for (const name of entries) {
    const p = readPacket(layout, name.slice(0, -3));
    if (p) out.push(p);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

import { readdirSync } from "node:fs";

function require_readdir(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
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
