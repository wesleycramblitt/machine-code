/**
 * machine_code — navigable work hierarchy.
 *
 * Two modes over the issues tree:
 *
 *   all   repository → kind (Features/Bugs/Ideas) → issue → runs
 *   type  repository → kind → status section → issue → runs
 *   status  repository → run status
 *   overall run status across every repository
 *
 * Status is a directory: the row set comes from `issues/<kind>/<status>/`.
 * The issue file is the work item; there are no packet rows.
 */
import { basename } from "node:path";
import type { RunSummary } from "../state/runs.js";
import {
  ISSUE_KIND_LABELS,
  ISSUE_KINDS,
  ISSUE_STATUS_LABELS,
  statusesForKind,
  type Issue,
  type IssueKind,
  type IssueStatus,
} from "../plan/issues.js";
import { effectiveStatus, runItemId } from "../plan/lifecycle.js";
import type { DisplayStatus } from "../plan/issues.js";
import { sortRuns } from "./status.js";

export type RunGroup = "all" | "category";

/** Modes the TUI cycles with `g`. */
export const RUN_GROUPS: readonly RunGroup[] = ["all", "category"];

export const RUN_GROUP_LABELS: Record<RunGroup, string> = {
  all: "All",
  category: "By category",
};

/** Parse a `--group` value, accepting the pre-restructure names. */
export function parseRunGroup(value: string | undefined): RunGroup | undefined {
  if (!value) return undefined;
  if (value === "packets" || value === "plan" || value === "type") return "all";
  if (value === "tag" || value === "tags") return "category";
  return (["all", "category"] as const).find((group) => group === value);
}

export type SectionTone = "feature" | "bug" | "idea" | "other" | "category" | "status" | "untracked";

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
      tone: SectionTone;
      issueKind?: IssueKind;
      issueStatus?: IssueStatus;
    }
  | {
      kind: "run";
      id: string;
      run: RunSummary;
      depth: number;
      parent?: string;
    }
  | {
      kind: "issue";
      id: string;
      slug: string;
      title: string;
      itemKind: IssueKind;
      status: IssueStatus;
      /** Effective status while a run is live. */
      effective: DisplayStatus;
      priority: string;
      review: Issue["review"];
      depth: number;
      parent?: string;
      collapsible: boolean;
      collapsed: boolean;
    };

export interface RunOptions {
  runs: readonly RunSummary[];
  /** Repo root the issues tree belongs to (the cwd/preferred repo). */
  issueRepo?: string;
  /** Issues for the work tree (one repo). */
  issues?: readonly Issue[];
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
    run.itemId ?? run.packetId ?? "",
    run.packetId ?? "",
  ].join(" ");
}

function statusNeedsAttention(run: RunSummary): boolean {
  return (
    run.status === "running" ||
    run.status === "awaiting_input" ||
    run.status === "blocked" ||
    run.status === "interrupted" ||
    run.status === "failed"
  );
}

const STATUS_ORDER: Array<{ status: RunSummary["status"]; label: string }> = [
  { status: "running", label: "Running" },
  { status: "awaiting_input", label: "Awaiting input" },
  { status: "blocked", label: "Blocked" },
  { status: "failed", label: "Failed" },
  { status: "interrupted", label: "Interrupted" },
  { status: "created", label: "Created" },
  { status: "completed", label: "Completed" },
  { status: "cancelled", label: "Cancelled" },
];

export function buildRunIndex(options: RunOptions): RunIndex {
  const collapsed = options.collapsed ?? new Set<string>();
  const text = options.text?.trim().toLowerCase() ?? "";
  const group = options.group ?? "all";
  const rows: RunRow[] = [];
  const byRunId = new Map<string, RunRow & { kind: "run" }>();

  const attentionRuns = options.runs.filter(statusNeedsAttention);
  const baseRuns = options.attentionOnly ? attentionRuns : [...options.runs];

  const planning: RunSummary[] = [];
  const untracked: RunSummary[] = [];
  const orphaned: RunSummary[] = [];
  for (const run of baseRuns) {
    if (!runItemId(run)) untracked.push(run);
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

  const pushSection = (id: string, label: string, count: number, depth: number, tone: SectionTone, kind?: IssueKind, status?: IssueStatus): boolean => {
    if (count === 0) return false;
    rows.push({ kind: "section", id, label, count, depth, collapsible: true, collapsed: collapsed.has(id), tone, ...(kind ? { issueKind: kind } : {}), ...(status ? { issueStatus: status } : {}) });
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

  const pushStatusGroups = (list: readonly RunSummary[], depth: number, idPrefix: string): void => {
    for (const { status, label } of STATUS_ORDER) {
      const groupRuns = list.filter((run) => run.status === status);
      if (groupRuns.length === 0) continue;
      const id = `${idPrefix}:${status}`;
      if (!pushSection(id, label, groupRuns.length, depth, "status")) continue;
      pushRuns(groupRuns, depth + 1, id);
    }
  };

  const RANK: Record<DisplayStatus, number> = {
    "needs-research": 0,
    researched: 1,
    todo: 0,
    "in-progress": 1,
    blocked: 2,
    done: 3,
  };

  const pushWorkTree = (repoRoot: string, repoRuns: readonly RunSummary[], depth: number): void => {
    const issues = options.issues ?? [];
    const runsByItem = new Map<string, RunSummary[]>();
    for (const run of repoRuns) {
      const itemId = runItemId(run);
      if (!itemId) continue;
      const list = runsByItem.get(itemId) ?? [];
      list.push(run);
      runsByItem.set(itemId, list);
    }
    const sortIssues = (list: readonly Issue[]): Issue[] =>
      [...list].sort(
        (a, b) =>
          RANK[effectiveStatus(a, repoRuns.filter((r) => runItemId(r) === a.slug))] -
            RANK[effectiveStatus(b, repoRuns.filter((r) => runItemId(r) === b.slug))] ||
          a.slug.localeCompare(b.slug),
      );
    const pushIssue = (issue: Issue, issueDepth: number, parentId: string): void => {
      const related = runsByItem.get(issue.slug) ?? [];
      const id = `issue:${issue.kind}:${issue.slug}`;
      const isCollapsed = collapsed.has(id);
      rows.push({
        kind: "issue",
        id,
        slug: issue.slug,
        title: issue.title,
        itemKind: issue.kind,
        status: issue.status,
        effective: effectiveStatus(issue, repoRuns),
        priority: issue.priority,
        review: issue.review,
        depth: issueDepth,
        parent: parentId,
        collapsible: related.length > 0,
        collapsed: isCollapsed,
      });
      if (isCollapsed || related.length === 0) return;
      pushRuns(sortRuns(related, "activity"), issueDepth + 1, id);
    };
    const toneFor = (kind: IssueKind): SectionTone =>
      kind === "features" ? "feature" : kind === "bugs" ? "bug" : kind === "ideas" ? "idea" : "other";

    if (group === "all") {
      // All: kind → status → issue (no category).
      for (const kind of ISSUE_KINDS) {
        const kindId = `kind:${repoRoot}:${kind}`;
        const list = issues.filter((issue) => issue.kind === kind);
        if (list.length === 0) continue;
        if (!pushSection(kindId, ISSUE_KIND_LABELS[kind], list.length, depth, toneFor(kind), kind)) continue;
        const byStatus = new Map<IssueStatus, Issue[]>();
        for (const issue of list) {
          const entry = byStatus.get(issue.status) ?? [];
          entry.push(issue);
          byStatus.set(issue.status, entry);
        }
        const order = statusesForKind(kind);
        const sorted = [...byStatus.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
        for (const [status, entries] of sorted) {
          if (entries.length === 0) continue;
          const id = `${kindId}:${status}`;
          if (!pushSection(id, ISSUE_STATUS_LABELS[status], entries.length, depth + 1, "status", kind, status)) continue;
          for (const issue of sortIssues(entries)) pushIssue(issue, depth + 2, id);
        }
      }
    } else if (group === "category") {
      // By category: kind → status → category → issue.
      for (const kind of ISSUE_KINDS) {
        const kindList = issues.filter((issue) => issue.kind === kind);
        if (kindList.length === 0) continue;
        const kindId = `kind:${repoRoot}:${kind}`;
        if (!pushSection(kindId, ISSUE_KIND_LABELS[kind], kindList.length, depth, toneFor(kind), kind)) continue;
        const byStatus = new Map<IssueStatus, Issue[]>();
        for (const issue of kindList) {
          const entry = byStatus.get(issue.status) ?? [];
          entry.push(issue);
          byStatus.set(issue.status, entry);
        }
        const order = statusesForKind(kind);
        const sorted = [...byStatus.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
        for (const [status, entries] of sorted) {
          if (entries.length === 0) continue;
          const statusId = `${kindId}:${status}`;
          if (!pushSection(statusId, ISSUE_STATUS_LABELS[status], entries.length, depth + 1, "status", kind, status)) continue;
          // Within each status, group by tag.
          const byTag = new Map<string, Issue[]>();
          for (const issue of entries) {
            const tag = issue.tags[0] ?? "Untagged";
            const list = byTag.get(tag) ?? [];
            list.push(issue);
            byTag.set(tag, list);
          }
          for (const [tag, list] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const tagId = `${statusId}:tag:${tag}`;
            if (!pushSection(tagId, tag, list.length, depth + 2, "category")) continue;
            for (const issue of sortIssues(list)) pushIssue(issue, depth + 3, tagId);
          }
        }
      }
    }

    const free = repoRuns.filter((run) => !runItemId(run));
    const untrackedId = `untracked:${repoRoot}`;
    if (pushSection(untrackedId, "Untracked runs", free.length, depth, "untracked")) {
      pushRuns(free, depth + 1, untrackedId);
    }
  };

  const workGroup = group === "all" || group === "category";
  const repoNames = [
    ...new Set([
      ...baseRuns.map(repoOf),
      ...(workGroup && options.issueRepo ? [options.issueRepo] : []),
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

  for (const repoRoot of repoNames) {
      const repoRuns = baseRuns.filter((run) => repoOf(run) === repoRoot && visibleRun(run));
      const issueRepo = workGroup && options.issueRepo === repoRoot;
      if (repoRuns.length === 0 && !issueRepo) continue;
      if (!pushRepo(repoRoot, repoRuns.length)) continue;
      if (issueRepo) {
        pushWorkTree(repoRoot, repoRuns, 1);
      } else {
        const free = repoRuns.filter((run) => !runItemId(run));
        const untrackedId = `untracked:${repoRoot}`;
        if (pushSection(untrackedId, "Untracked runs", free.length, 1, "untracked")) {
          pushRuns(free, 2, untrackedId);
        }
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
 * Rows that stay bright while the cursor sits on an issue or run.
 */
export function focusRowIds(rows: readonly RunRow[], selected: RunRow | undefined): Set<string> | null {
  if (!selected || (selected.kind !== "issue" && selected.kind !== "run")) return null;
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
    if (row.kind !== "run" && row.kind !== "issue") continue;
    if (row.parent === selectedParent) focus.add(row.id);
  }
  for (const row of rows) {
    if (row.kind !== "run") continue;
    if (row.parent === selected.id) focus.add(row.id);
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
