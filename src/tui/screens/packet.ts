/**
 * machine_code — issue detail screen.
 *
 * One page per issue: its status directory, prompt, dependencies, tags,
 * review mode, body, and every run attached to it. Actions move the issue
 * forward (plan/build/gate/approve/delete/orchestrate/edit).
 */
import { B, C, D, G, GR, M, R, RED, W, Y, command, joinCommands, trunc } from "../format.js";
import { sortRuns } from "../status.js";
import type { RunSummary } from "../../state/runs.js";
import { runItemId } from "../../plan/lifecycle.js";
import { windowedBody, type Viewport } from "./types.js";

export interface IssueHeader {
  slug: string;
  title: string;
  kindLabel: string;
  statusLabel: string;
  rel: string;
  priority: string;
  review: string;
  tags: string[];
  depends: string[];
  body: string[];
}

export interface PacketProps extends Viewport {
  slug: string | null;
  issue: IssueHeader | null;
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
  const { bodyH, toast, slug, issue, runs, scroll } = props;
  const lines: string[] = [];
  if (!slug) {
    lines.push("", ` ${Y}issue not found${R}`);
  } else {
    lines.push(` ${B}${W}${slug}${R}  ${C}[${issue?.statusLabel ?? "unknown"}]${R}  ${D}${issue?.kindLabel ?? "item"} · ${issue?.rel ?? ""}${R}`);
    if (issue) {
      lines.push(` ${D}priority ${issue.priority} · review ${issue.review}${issue.tags.length ? ` · tags ${issue.tags.join(", ")}` : ""}${issue.depends.length ? ` · depends ${issue.depends.join(", ")}` : ""} · status is the directory: ${issue.rel}${R}`);
      const body = issue.body.slice(0, 20);
      for (const line of body) lines.push(`   ${D}${trunc(line, 110)}${R}`);
      if (issue.body.length > body.length) lines.push(`   ${D}… ${issue.body.length - body.length} more line(s)${R}`);
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
      command("v", "Review", undefined, M),
      command("o", "Orchestrate", undefined, GR),
      command("b", "Build", undefined, C),
      command("g", "Gate", issue?.review ?? "none", issue?.review === "agent" ? C : issue?.review === "human" ? Y : D),
      command("a", "Approve", undefined, G),
      command("d", "Delete", undefined, RED),
      command("esc", "Back"),
    ]),
    secondary: slug ? `${D}${issue?.rel ?? `issues/${slug}`}${toast ? ` · ${Y}${toast}${R}` : ""}${R}` : "",
  };
}
