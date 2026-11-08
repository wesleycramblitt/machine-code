/**
 * machine_code — navigable run hierarchy.
 *
 * The Runs page has three grouping modes:
 *
 *   packets   repository → plan category → packet → runs
 *   status    repository → run status
 *   overall   run status across every repository
 *
 * Rows stay flat for keyboard navigation; `depth` carries the visual
 * hierarchy and `parent` identifies fold groups.
 */
import { basename } from "node:path";
import type { RunSummary } from "../state/runs.js";
import type { PacketFile, PlanIndexItem } from "../plan/packets.js";
import { sortRuns } from "./status.js";

export type RunGroup = "packets" | "status" | "overall";

export const RUN_GROUPS: readonly RunGroup[] = ["packets", "status"];

export const RUN_GROUP_LABELS: Record<RunGroup, string> = {
  packets: "Packets",
  status: "Status",
  overall: "Overall status",
};

export type RunRow =
  | {
      kind: "repo";
      id: string;
      repoRoot: string;
      label: string;
      count: number;
      depth: number;
      collapsible: boolean;
      collapsed: boolean;
    }
  | {
      kind: "section";
      id: string;
      label: string;
      count: number;
      depth: number;
      collapsible: boolean;
      collapsed: boolean;
      tone: "untracked" | "orphaned" | "status";
    }
  | {
      kind: "run";
      id: string;
      run: RunSummary;
      depth: number;
      parent?: string;
    }
  | {
      kind: "packet";
      id: string;
      slug: string;
      packet: PacketFile;
      depth: number;
      parent?: string;
      directRuns: number;
      collapsible: boolean;
      collapsed: boolean;
    }
  | {
      kind: "plan";
      id: string;
      /** Repo-relative plan path. */
      path: string;
      title: string;
      depth: number;
      parent?: string;
    }
  | {
      kind: "planline";
      id: string;
      slug: string;
      title: string;
      heading: string;
      done: boolean;
      depth: number;
      parent?: string;
    };

export interface RunOptions {
  runs: readonly RunSummary[];
  /** Repo root the packet catalog belongs to (the cwd/preferred repo). */
  packetRepo?: string;
  /** Packet files for the `packets` group (one repo). */
  packets?: readonly PacketFile[];
  /** Plan files for the collapsible Plans section. */
  plans?: readonly { path: string; title: string }[];
  /** Parsed plan index items; un-packeted ones surface under their heading. */
  planItems?: readonly { heading: string; slug: string; title: string; done: boolean; packet?: string }[];
  group?: RunGroup;
  collapsed?: ReadonlySet<string>;
  /** Case-insensitive substring over run fields and repository paths. */
  text?: string;
  /** Only keep work that needs a human or is in flight. */
  attentionOnly?: boolean;
  /** Put this repository first (normally the TUI cwd). */
  preferredRepo?: string;
  now?: number;
}

export interface RunIndex {
  group: RunGroup;
  rows: RunRow[];
  /** Rows a cursor can land on, including headings. */
  selectable: RunRow[];
  byRunId: Map<string, RunRow & { kind: "run" }>;
  runs: RunSummary[];
  untracked: RunSummary[];
  planning: RunSummary[];
  orphaned: RunSummary[];
  attention: number;
}

export function repoOf(run: RunSummary): string {
  return run.repoRoot || "(unknown repository)";
}

export function repoLabel(repoRoot: string): string {
  return basename(repoRoot) || repoRoot;
}

function runText(run: RunSummary): string {
  return [
    run.id,
    run.agent,
    run.mode,
    run.request,
    run.status,
    run.repoRoot,
    run.prNumber ? `pr #${run.prNumber}` : "",
    run.packetId ?? "",
  ].join(" ");
}

function statusNeedsAttention(run: RunSummary): boolean {
  return (
    run.status === "running" ||
    run.status === "awaiting_input" ||
    run.status === "blocked" ||
    run.status === "paused" ||
    run.status === "interrupted" ||
    run.status === "failed" ||
    run.prState === "open"
  );
}

const STATUS_ORDER: Array<{ status: RunSummary["status"]; label: string }> = [
  { status: "running", label: "Running" },
  { status: "awaiting_input", label: "Awaiting input" },
  { status: "blocked", label: "Blocked" },
  { status: "paused", label: "Paused" },
  { status: "failed", label: "Failed" },
  { status: "interrupted", label: "Interrupted" },
  { status: "created", label: "Created" },
  { status: "completed", label: "Completed" },
  { status: "cancelled", label: "Cancelled" },
];

export function buildRunIndex(options: RunOptions): RunIndex {
  const collapsed = options.collapsed ?? new Set<string>();
  const text = options.text?.trim().toLowerCase() ?? "";
  // The TUI and CLI default to the `packets` group explicitly; the library
  // default stays `packets` as well now that issues are gone.
  const group = options.group ?? "packets";
  const rows: RunRow[] = [];
  const byRunId = new Map<string, RunRow & { kind: "run" }>();

  const attentionRuns = options.runs.filter(statusNeedsAttention);
  const baseRuns = options.attentionOnly ? attentionRuns : [...options.runs];

  const planning: RunSummary[] = [];
  const untracked: RunSummary[] = [];
  const orphaned: RunSummary[] = [];
  for (const run of baseRuns) {
    if (!run.packetId) {
      untracked.push(run);
    }
  }

  const runMatches = (run: RunSummary): boolean => {
    if (!text) return true;
    return runText(run).toLowerCase().includes(text);
  };
  const repoMatches = (repoRoot: string): boolean => !text || repoRoot.toLowerCase().includes(text);
  const visibleRun = (run: RunSummary): boolean => repoMatches(repoOf(run)) || runMatches(run);
  const visibleRuns = baseRuns.filter(visibleRun);

  const pushRun = (run: RunSummary, depth: number, parent?: string): void => {
    const row: RunRow = { kind: "run", id: `run:${run.id}`, run, depth, parent };
    rows.push(row);
    byRunId.set(run.id, row as RunRow & { kind: "run" });
  };

  const pushRuns = (list: readonly RunSummary[], depth: number, parent?: string): void => {
    for (const run of sortRuns(list, "activity")) pushRun(run, depth, parent);
  };

  const pushSection = (
    id: string,
    label: string,
    count: number,
    depth: number,
    tone: "untracked" | "orphaned" | "status",
  ): boolean => {
    if (count === 0) return false;
    rows.push({ kind: "section", id, label, count, depth, collapsible: true, collapsed: collapsed.has(id), tone });
    return !collapsed.has(id);
  };

  const pushRepo = (repoRoot: string, count: number): boolean => {
    const id = `repo:${repoRoot}`;
    const isCollapsed = collapsed.has(id);
    rows.push({
      kind: "repo",
      id,
      repoRoot,
      label: repoLabel(repoRoot),
      count,
      depth: 0,
      collapsible: true,
      collapsed: isCollapsed,
    });
    return !isCollapsed;
  };

  const pushStatusGroups = (
    list: readonly RunSummary[],
    depth: number,
    idPrefix: string,
  ): void => {
    for (const { status, label } of STATUS_ORDER) {
      const groupRuns = list.filter((run) => run.status === status);
      if (groupRuns.length === 0) continue;
      const id = `${idPrefix}:${status}`;
      if (!pushSection(id, label, groupRuns.length, depth, "status")) continue;
      pushRuns(groupRuns, depth + 1, id);
    }
  };

  const pushPacketTree = (repoRoot: string, repoRuns: readonly RunSummary[], depth: number): void => {
    const packets = options.packets ?? [];
    const bySlug = new Map(packets.map((packet) => [packet.slug, packet] as const));
    const runsBySlug = new Map<string, RunSummary[]>();
    for (const run of repoRuns) {
      if (!run.packetId) continue;
      const list = runsBySlug.get(run.packetId) ?? [];
      list.push(run);
      runsBySlug.set(run.packetId, list);
    }
    const pushPacketRow = (slug: string, packetDepth: number, parentId?: string): void => {
      const packet = bySlug.get(slug);
      if (!packet) return;
      const id = `packet:${slug}`;
      const directRuns = runsBySlug.get(slug) ?? [];
      const isCollapsed = collapsed.has(id);
      rows.push({
        kind: "packet",
        id,
        slug,
        packet,
        depth: packetDepth,
        parent: parentId,
        directRuns: directRuns.length,
        collapsible: directRuns.length > 0,
        collapsed: isCollapsed,
      });
      if (isCollapsed) return;
      pushRuns(sortRuns(directRuns, "activity"), packetDepth + 1, id);
    };

    // Plan categories hold the captured lines. A linked packet nests under its
    // line, so the intent and its build contract read as one item instead of
    // appearing in two places. Lines without a packet stay plain capture rows.
    const byHeading = new Map<string, PlanIndexItem[]>();
    for (const item of options.planItems ?? []) {
      const list = byHeading.get(item.heading) ?? [];
      list.push(item);
      byHeading.set(item.heading, list);
    }
    const placed = new Set<string>();
    for (const [heading, list] of byHeading) {
      const sectionId = `plan:${repoRoot}:${heading}`;
      if (!pushSection(sectionId, heading, list.length, depth, "status")) continue;
      for (const item of list) {
        const packet = item.packet ? bySlug.get(item.packet) : undefined;
        const lineId = `planline:${repoRoot}:${heading}:${item.slug}`;
        rows.push({
          kind: "planline",
          id: lineId,
          slug: item.slug,
          title: item.title,
          heading,
          done: item.done,
          depth: depth + 1,
          parent: sectionId,
        });
        if (!packet) continue;
        placed.add(packet.slug);
        pushPacketRow(packet.slug, depth + 2, lineId);
      }
    }

    // Packets with no plan line still need a home: they are build-ready but
    // not yet placed on the hand-written map.
    const unplaced = packets.filter((packet) => !placed.has(packet.slug));
    const unplannedId = `plan:${repoRoot}:unplanned`;
    if (pushSection(unplannedId, "Unplanned packets", unplaced.length, depth, "orphaned")) {
      const STATUS_RANK: Record<PacketFile["status"], number> = {
        "in-progress": 0,
        blocked: 1,
        todo: 2,
        done: 3,
      };
      const ordered = [...unplaced].sort(
        (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.slug.localeCompare(b.slug),
      );
      for (const packet of ordered) pushPacketRow(packet.slug, depth + 1, unplannedId);
    }

    // Plan files: Enter/n opens the composer seeded for a planner run. Plans
    // are reference documents, not runs, so they never carry children.
    const plans = options.plans ?? [];
    const plansSectionId = `plans:${repoRoot}`;
    if (pushSection(plansSectionId, "Plans", plans.length, depth, "status")) {
      for (const plan of plans) {
        rows.push({
          kind: "plan",
          id: `plan:${repoRoot}:${plan.path}`,
          path: plan.path,
          title: plan.title,
          depth: depth + 1,
          parent: plansSectionId,
        });
      }
    }
  };

  // A repo with packets but no runs still shows its packet tree in the
  // `packets` group.
  const repoNames = [
    ...new Set([
      ...baseRuns.map(repoOf),
      ...(group === "packets" && options.packetRepo ? [options.packetRepo] : []),
    ]),
  ];
  const preferred = options.preferredRepo;
  repoNames.sort((a, b) => {
    if (preferred) {
      if (a === preferred && b !== preferred) return -1;
      if (b === preferred && a !== preferred) return 1;
    }
    return a.localeCompare(b);
  });

  if (group === "overall") {
    pushStatusGroups(visibleRuns, 0, "status:all");
  } else {
    for (const repoRoot of repoNames) {
      const repoRuns = baseRuns.filter((run) => repoOf(run) === repoRoot && visibleRun(run));
      const packetRepo = group === "packets" && options.packetRepo === repoRoot;
      if (repoRuns.length === 0 && !packetRepo) continue;
      if (!pushRepo(repoRoot, repoRuns.length)) continue;
      if (group === "status") {
        pushStatusGroups(repoRuns, 1, `status:${repoRoot}`);
        continue;
      }
      if (group === "packets") {
        // Only the repo that owns the packet catalog gets its packet tree;
        // other repos list their (packet-less) runs under Untracked.
        if (packetRepo) pushPacketTree(repoRoot, repoRuns, 1);
        const free = repoRuns.filter((run) => !run.packetId);
        const untrackedId = `untracked:${repoRoot}`;
        if (pushSection(untrackedId, "Untracked", free.length, 1, "untracked")) {
          pushRuns(free, 2, untrackedId);
        }
        continue;
      }

      pushStatusGroups(repoRuns, 1, `status:${repoRoot}`);
    }
  }

  return {
    group,
    rows,
    selectable: rows,
    byRunId,
    runs: visibleRuns,
    untracked: sortRuns(untracked, "activity"),
    planning: sortRuns(planning, "activity"),
    orphaned: sortRuns(orphaned, "activity"),
    attention: attentionRuns.length,
  };
}

/**
 * Rows that stay bright while the cursor sits on a packet or run.
 *
 * A focus keeps the selected row, its ancestors, its peers at the same
 * level, and its immediate children bright: runs under a packet. Repo and
 * section headings always stay bright; selecting one disables dimming.
 */
export function focusRowIds(
  rows: readonly RunRow[],
  selected: RunRow | undefined,
): Set<string> | null {
  if (
    !selected ||
    (selected.kind !== "packet" && selected.kind !== "run" && selected.kind !== "plan" && selected.kind !== "planline")
  ) {
    return null;
  }
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const focus = new Set<string>([selected.id]);

  const ancestorsOf = (row: RunRow & { parent?: string }): RunRow[] => {
    const out: RunRow[] = [];
    const seen = new Set<string>();
    let parent = row.parent;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const candidate = byId.get(parent);
      if (!candidate) break;
      out.push(candidate);
      parent = "parent" in candidate ? candidate.parent : undefined;
    }
    return out;
  };

  const selectedParent = "parent" in selected ? selected.parent : undefined;
  for (const ancestor of ancestorsOf(selected)) focus.add(ancestor.id);
  for (const row of rows) {
    if (row.kind !== "run" && row.kind !== "packet" && row.kind !== "plan" && row.kind !== "planline") continue;
    if (row.parent === selectedParent) focus.add(row.id);
  }

  for (const row of rows) {
    if (row.kind !== "run" && row.kind !== "packet") continue;
    if (row.parent !== selected.id) continue;
    if (row.kind === "run") focus.add(row.id);
  }
  return focus;
}

/** Next/previous cursor row. Section headings are normal cursor stops. */
export function moveSelection(index: number, delta: number, selectable: readonly RunRow[]): number {
  if (selectable.length === 0) return 0;
  return Math.max(0, Math.min(selectable.length - 1, index + delta));
}

export function runOf(row: RunRow | undefined): RunSummary | undefined {
  return row?.kind === "run" ? row.run : undefined;
}
