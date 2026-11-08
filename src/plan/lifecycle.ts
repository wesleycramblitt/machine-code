/**
 * machine_code — work-item lifecycle.
 *
 * A packet is no longer a separate tree node: it is the item's contract, and
 * the contract plus the attached runs derive one lifecycle status. Statuses
 * are computed, never hand-set, so they cannot drift from reality.
 *
 *   idea          needs-research → researched → archived
 *   feature/bug   needs-planning → ready → in-progress → done → archived
 *
 * `blocked` is an orthogonal flag (with a reason), not a state.
 */
import type { RunSummary } from "../state/runs.js";
import type { PacketFile } from "./packets.js";
import type { PlanItem } from "./items.js";

export type ItemStatus =
  | "needs-research"
  | "researched"
  | "needs-planning"
  | "ready"
  | "in-progress"
  | "done"
  | "archived";

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  "needs-research": "Needs Research",
  researched: "Researched",
  "needs-planning": "Needs Planning",
  ready: "Ready to Build",
  "in-progress": "In Progress",
  done: "Done",
  archived: "Archived",
};

export interface ItemState {
  status: ItemStatus;
  /** Blocking reason, rendered as a flag next to the status. */
  blocked?: string;
}

/** The work item a run belongs to: explicit item, else its packet. */
export function runItemId(run: Pick<RunSummary, "itemId" | "packetId">): string | undefined {
  return run.itemId ?? run.packetId;
}

const ACTIVE_RUN = new Set<RunSummary["status"]>(["created", "running", "awaiting_input"]);

/**
 * Derive the item lifecycle. `contract` is the packet file for the item's
 * slug when one exists; `runs` may include research, planning, and build runs.
 */
export function itemState(
  item: PlanItem,
  contract: PacketFile | undefined,
  runs: readonly RunSummary[],
): ItemState {
  const blocked =
    contract?.status === "blocked" ? contract.blocked || "blocked" : contract?.blocked || undefined;
  const flag = blocked ? { blocked } : {};
  if (item.archived) return { status: "archived", ...flag };
  // The checkbox is authoritative for completion even after the contract is
  // gone (approve deletes the packet).
  if (item.done) return { status: "done", ...flag };
  const related = runs.filter((run) => runItemId(run) === item.slug);
  if (item.kind === "idea") {
    const researched = related.some((run) => run.agent === "research" && run.status === "completed");
    return { status: researched ? "researched" : "needs-research", ...flag };
  }
  if (!contract) return { status: "needs-planning", ...flag };
  if (related.some((run) => ACTIVE_RUN.has(run.status))) return { status: "in-progress", ...flag };
  if (contract.status === "done") return { status: "done", ...flag };
  return { status: "ready", ...flag };
}
