/**
 * machine_code — queue runner (M4).
 *
 * Processes committed packets in .machine_code/tasks/ in filename order.
 * Completed packets are skipped; interrupted/blocked/failed work stops the
 * queue until explicit resume/requeue. Packets are immutable; each run starts
 * from the current base branch.
 */
import type { Layout } from "./paths.js";
import { listCommittedPackets, type TaskPacket } from "./packet.js";
import { listAllRuns } from "./state/runs.js";

export function listQueuedPackets(layout: Layout): TaskPacket[] {
  return listCommittedPackets(layout);
}

export function isPacketDone(layout: Layout, packet: TaskPacket): boolean {
  const runs = listAllRuns(layout.home);
  return runs.some((r) => r.packetId === packet.id && r.status === "completed");
}

export interface QueueProgress {
  packet: TaskPacket;
  status: "skipped" | "completed" | "blocked" | "failed" | "interrupted";
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
    if (p.status !== "completed" && p.status !== "skipped") {
      // stop the queue on interrupted/blocked/failed
      break;
    }
  }
  return progress;
}
