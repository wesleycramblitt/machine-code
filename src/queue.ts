/**
 * machine_code — queue runner (M4).
 *
 * Processes committed packets in .machine_code/tasks/ in filename order.
 * Completed packets are skipped; interrupted/blocked/failed work stops the
 * queue until explicit resume/requeue. Packets are immutable; each run starts
 * from the current base branch.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths.js";
import { type TaskPacket } from "./packet.js";
import { listAllRuns } from "./state/runs.js";

function readQueuedPacket(layout: Layout, id: string): TaskPacket | null {
  const file = join(layout.repoDir, "tasks", `${id}.md`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TaskPacket;
  } catch {
    return null;
  }
}

export function listQueuedPackets(layout: Layout): TaskPacket[] {
  const dir = join(layout.repoDir, "tasks");
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  const out: TaskPacket[] = [];
  for (const name of entries) {
    const p = readQueuedPacket(layout, name.slice(0, -3));
    if (p) out.push(p);
  }
  return out;
}

export function isPacketDone(layout: Layout, packet: TaskPacket): boolean {
  const runs = listAllRuns(layout.home);
  return runs.some((r) => r.packetId === packet.id && r.status === "done");
}

export interface QueueProgress {
  packet: TaskPacket;
  status: "skipped" | "done" | "blocked" | "failed" | "interrupted";
  runId?: string;
}

export async function runQueue(
  layout: Layout,
  execute: (packet: TaskPacket) => Promise<{ status: string; runId: string }>,
  onProgress?: (p: QueueProgress) => void,
): Promise<QueueProgress[]> {
  const packets = listQueuedPackets(layout);
  const progress: QueueProgress[] = [];
  for (const packet of packets) {
    if (isPacketDone(layout, packet)) {
      const p: QueueProgress = { packet, status: "skipped" };
      progress.push(p);
      onProgress?.(p);
      continue;
    }
    const result = await execute(packet);
    const p: QueueProgress = { packet, status: result.status as QueueProgress["status"], runId: result.runId };
    progress.push(p);
    onProgress?.(p);
    if (p.status !== "done" && p.status !== "skipped") {
      // stop the queue on interrupted/blocked/failed
      break;
    }
  }
  return progress;
}
