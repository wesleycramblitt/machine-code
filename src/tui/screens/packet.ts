/**
 * machine_code — packet detail screen.
 *
 * Pure render of one packet contract: status/gate header, deliverable,
 * deps, files, acceptance, verify commands, and attached runs. Takes the
 * already-read packet (IO stays with the caller) plus the run list.
 */
import { B, C, D, G, GR, R, RED, W, Y, command, joinCommands, trunc } from "../format.js";
import { sortRuns } from "../status.js";
import type { RunSummary } from "../../state/runs.js";
import type { PacketFile } from "../../plan/packets.js";
import { windowedBody, type Viewport } from "./types.js";

export interface PacketProps extends Viewport {
  slug: string | null;
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
  const { bodyH, toast, slug, packet, runs, scroll } = props;
  const lines: string[] = [];
  if (!packet || !slug) {
    lines.push("", ` ${Y}packet not found${R}`);
  } else {
    lines.push(` ${B}${W}${slug}${R}  ${D}[${packet.status}]  gate ${packet.review ?? "gates"}${R}`);
    lines.push(` ${W}${packet.deliverable || "(no deliverable)"}${R}`);
    if (packet.deps.length > 0) lines.push(` ${D}deps: ${packet.deps.join(", ")}${R}`);
    if (packet.files.length > 0) {
      lines.push(` ${D}files:${R}`);
      for (const file of packet.files) lines.push(`   ${C}${file}${R}`);
    }
    if (packet.acceptance.length > 0) lines.push(` ${D}acceptance: ${packet.acceptance.join("; ")}${R}`);
    lines.push(` ${D}verify: ${packet.verify.length ? packet.verify.join(", ") : "(none)"}${R}`);
    const attached = runs.filter((run) => run.packetId === slug);
    lines.push("", ` ${B}runs${R} ${D}(${attached.length})${R}`);
    for (const run of sortRuns(attached, "activity")) {
      lines.push(`   ${W}${run.id.slice(-8)}${R} ${D}${run.agent}${R} ${run.status}${run.error ? ` ${Y}${trunc(run.error, 40)}${R}` : ""}`);
    }
  }
  const w = windowedBody(lines, scroll, scroll, bodyH);
  return {
    ...w,
    actions: joinCommands([
      command("g", "Gate", packet?.review ?? "gates", packet?.review === "agent" ? C : packet?.review === "human" ? Y : D),
      command("o", "Orchestrate", undefined, GR),
      command("b", "Build", undefined, C),
      command("a", "Approve", undefined, G),
      command("d", "Delete", undefined, RED),
      command("esc", "Back"),
    ]),
    secondary: slug ? `${D}packets/${slug}.md${toast ? ` · ${Y}${toast}${R}` : ""}${R}` : "",
  };
}
