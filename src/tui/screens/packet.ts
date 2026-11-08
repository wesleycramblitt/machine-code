/**
 * machine_code — work-item detail screen.
 *
 * One page per item (feature, bug, or idea): lifecycle status, the plan
 * background around the item, the build contract when one exists, every run
 * attached to it, and the actions that move it forward. A packet is the
 * item's contract here, not a separate object.
 */
import { B, C, D, G, GR, R, RED, W, Y, command, joinCommands, trunc } from "../format.js";
import { sortRuns } from "../status.js";
import type { RunSummary } from "../../state/runs.js";
import type { PacketFile } from "../../plan/packets.js";
import { runItemId } from "../../plan/lifecycle.js";
import { windowedBody, type Viewport } from "./types.js";

export interface ItemHeader {
  slug: string;
  title: string;
  /** "Feature" | "Bug" | "Idea" | "Other". */
  kindLabel: string;
  plan: string;
  /** Lifecycle label, e.g. "Ready to Build". */
  statusLabel: string;
  blocked?: string;
  hasContract: boolean;
  /** Prose around the item in its plan file. */
  background: string[];
}

export interface PacketProps extends Viewport {
  slug: string | null;
  item: ItemHeader | null;
  packet: PacketFile | null;
  runs: readonly RunSummary[];
  scroll: number;
}

export interface PacketFrame {
  body: string[];
  actions: string;
  secondary: string;
  scroll: number;
}

export function renderPacket(props: PacketProps): PacketFrame {
  const { bodyH, toast, slug, item, packet, runs, scroll } = props;
  const lines: string[] = [];
  if (!slug) {
    lines.push("", ` ${Y}item not found${R}`);
  } else {
    const kind = item?.kindLabel ?? "Item";
    const status = item?.statusLabel ?? (packet ? packet.status : "no contract");
    lines.push(` ${B}${W}${slug}${R}  ${C}[${status}]${R}  ${D}${kind} · ${item?.plan ?? `packets/${slug}.md`}${R}`);
    if (item?.blocked) lines.push(` ${RED}⚠ blocked: ${item.blocked}${R}`);
    if (item && item.background.length > 0) {
      lines.push("", ` ${B}background${R}`);
      const cap = item.background.slice(0, 14);
      for (const line of cap) lines.push(`   ${D}${trunc(line, 110)}${R}`);
      if (item.background.length > cap.length) lines.push(`   ${D}… ${item.background.length - cap.length} more line(s)${R}`);
    }
    lines.push("", ` ${B}contract${R} ${D}${packet ? `packets/${slug}.md` : "(none — press p to plan)"}${R}`);
    if (packet) {
      lines.push(` ${W}${packet.deliverable || "(no deliverable)"}${R}`);
      lines.push(` ${D}gate ${packet.review ?? "gates"} · status ${packet.status}${R}`);
      if (packet.deps.length > 0) lines.push(` ${D}deps: ${packet.deps.join(", ")}${R}`);
      if (packet.files.length > 0) {
        lines.push(` ${D}files:${R}`);
        for (const file of packet.files) lines.push(`   ${C}${file}${R}`);
      }
      if (packet.acceptance.length > 0) lines.push(` ${D}acceptance: ${packet.acceptance.join("; ")}${R}`);
      lines.push(` ${D}verify: ${packet.verify.length ? packet.verify.join(", ") : "(none)"}${R}`);
    }
    const attached = runs.filter((run) => runItemId(run) === slug);
    lines.push("", ` ${B}runs${R} ${D}(${attached.length})${R}`);
    for (const run of sortRuns(attached, "activity")) {
      lines.push(`   ${W}${run.id.slice(-8)}${R} ${D}${run.agent}${R} ${run.status}${run.error ? ` ${Y}${trunc(run.error, 40)}${R}` : ""}`);
    }
  }
  const w = windowedBody(lines, scroll, scroll, bodyH);
  return {
    ...w,
    actions: joinCommands([
      command("n", "Run", undefined, C),
      command("o", "Orchestrate", undefined, GR),
      ...(packet
        ? [
            command("p", "Plan", undefined, Y),
            command("b", "Build", undefined, C),
            command("g", "Gate", packet.review ?? "gates", packet.review === "agent" ? C : packet.review === "human" ? Y : D),
            command("a", "Approve", undefined, G),
            command("d", "Delete", undefined, RED),
          ]
        : [command("p", "Plan", undefined, Y)]),
      command("esc", "Back"),
    ]),
    secondary: item
      ? `${D}${item.plan}${item.hasContract ? ` · packets/${slug}.md` : ""}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`
      : slug
        ? `${D}packets/${slug}.md${toast ? ` · ${Y}${toast}${R}` : ""}${R}`
        : "",
  };
}
