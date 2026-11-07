/**
 * machine_code — navigable run hierarchy.
 *
 * The Runs page has three grouping modes:
 *
 *   gh-issue  repository → git issue tree / untracked / orphaned runs
 *   status    repository → run status
 *   overall   run status across every repository
 *
 * Rows stay flat for keyboard navigation; `depth` carries the visual
 * hierarchy and `parent` identifies fold groups.
 */
import { basename } from "node:path";
import type { Issue, IssueRef } from "../issues/provider.js";
import type { RunSummary } from "../state/runs.js";
import type { PacketFile, PlanCategories } from "../plan/packets.js";
import { isDeliverable, rollupIssue, sortRuns, type IssueRollup } from "./status.js";

export type RunGroup = "packets" | "gh-issue" | "status" | "overall";

export const RUN_GROUPS: readonly RunGroup[] = ["packets", "status"];

export const RUN_GROUP_LABELS: Record<RunGroup, string> = {
  packets: "Packets",
  "gh-issue": "GH issue",
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
      tone: "issues" | "untracked" | "orphaned" | "status";
    }
  | {
      kind: "issue";
      id: string;
      issue: Issue;
      depth: number;
      rollup: IssueRollup;
      parent?: string;
      collapsible: boolean;
      collapsed: boolean;
      childCount: number;
      directRuns: number;
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
    };

export interface RunOptions {
  runs: readonly RunSummary[];
  /** Backwards-compatible single-repo issue list. */
  issues?: readonly Issue[];
  /** Cached issues keyed by run repository root. */
  issuesByRepo?: ReadonlyMap<string, readonly Issue[]>;
  /** Repo root the packet catalog belongs to (the cwd/preferred repo). */
  packetRepo?: string;
  /** Packet files for the `packets` group (one repo). */
  packets?: readonly PacketFile[];
  /** Plan category headings + orphan slugs for the `packets` group. */
  planCategories?: PlanCategories;
  group?: RunGroup;
  collapsed?: ReadonlySet<string>;
  /** Case-insensitive substring over issue/run fields and repository paths. */
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
  byIssueKey: Map<string, RunRow & { kind: "issue" }>;
  runs: RunSummary[];
  untracked: RunSummary[];
  planning: RunSummary[];
  orphaned: RunSummary[];
  attention: number;
}

function keyOf(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

export function repoOf(run: RunSummary): string {
  return run.repoRoot || "(unknown repository)";
}

export function repoLabel(repoRoot: string): string {
  return basename(repoRoot) || repoRoot;
}

function issueText(issue: Issue): string {
  return `#${issue.ref.number} ${issue.title} ${issue.kind} ${issue.labels.join(" ")}`;
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
    run.issue ? `#${run.issue.number}` : "",
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

const KIND_RANK: Record<string, number> = { epic: 0, feature: 1 };

function issueRoots(issues: readonly Issue[]): Issue[] {
  const known = new Set(issues.map((issue) => keyOf(issue.ref)));
  return issues.filter((issue) => !issue.parent || !known.has(keyOf(issue.parent)));
}

function sortIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const ak = KIND_RANK[a.kind] ?? 3;
    const bk = KIND_RANK[b.kind] ?? 3;
    return ak - bk || a.ref.number - b.ref.number;
  });
}

export interface PickerIssueRow {
  issue: Issue;
  /** Real parent depth, not a kind-based indent. */
  depth: number;
}

/**
 * Parent-first issue order for the new-run picker. The cache is written in
 * provider order (often newest first); this restores the tree and keeps
 * ancestors visible when the filter matches a child.
 */
export function orderIssueTree(issues: readonly Issue[], text = ""): PickerIssueRow[] {
  const byKey = new Map(issues.map((issue) => [keyOf(issue.ref), issue]));
  const children = new Map<string, Issue[]>();
  const roots: Issue[] = [];
  for (const issue of issues) {
    const parentKey = issue.parent ? keyOf(issue.parent) : "";
    if (parentKey && byKey.has(parentKey)) {
      const list = children.get(parentKey) ?? [];
      list.push(issue);
      children.set(parentKey, list);
    } else {
      roots.push(issue);
    }
  }
  const query = text.trim().toLowerCase();
  const matches = (issue: Issue): boolean =>
    !query || `#${issue.ref.number} ${issue.title} ${issue.kind}`.toLowerCase().includes(query);
  const relevance = new Map<string, boolean>();
  const mark = (issue: Issue): boolean => {
    const key = keyOf(issue.ref);
    const cached = relevance.get(key);
    if (cached !== undefined) return cached;
    let childKept = false;
    for (const child of children.get(key) ?? []) {
      if (mark(child)) childKept = true;
    }
    const keep = matches(issue) || childKept;
    relevance.set(key, keep);
    return keep;
  };
  for (const root of roots) mark(root);

  const out: PickerIssueRow[] = [];
  const walk = (issue: Issue, depth: number): void => {
    if (!relevance.get(keyOf(issue.ref))) return;
    out.push({ issue, depth });
    for (const child of sortIssues(children.get(keyOf(issue.ref)) ?? [])) walk(child, depth + 1);
  };
  for (const root of sortIssues(roots)) walk(root, 0);
  return out;
}

export function buildRunIndex(options: RunOptions): RunIndex {
  const now = options.now ?? Date.now();
  const collapsed = options.collapsed ?? new Set<string>();
  const text = options.text?.trim().toLowerCase() ?? "";
  // The TUI and CLI default to the `packets` group explicitly; the library
  // default stays `gh-issue` so existing callers/tests are unchanged.
  const group = options.group ?? "gh-issue";
  const rows: RunRow[] = [];
  const byRunId = new Map<string, RunRow & { kind: "run" }>();
  const byIssueKey = new Map<string, RunRow & { kind: "issue" }>();

  const attentionRuns = options.runs.filter(statusNeedsAttention);
  const baseRuns = options.attentionOnly ? attentionRuns : [...options.runs];

  const issuesFor = (repoRoot: string): readonly Issue[] => {
    if (options.issuesByRepo) return options.issuesByRepo.get(repoRoot) ?? [];
    return options.issues ?? [];
  };

  const issueKeysByRepo = new Map<string, Set<string>>();
  if (options.issuesByRepo) {
    for (const [repoRoot, issues] of options.issuesByRepo) {
      issueKeysByRepo.set(repoRoot, new Set(issues.map((issue) => keyOf(issue.ref))));
    }
  }
  const legacyKnown = new Set((options.issues ?? []).map((issue) => keyOf(issue.ref)));
  const knownIssues = (repoRoot: string): Set<string> =>
    options.issuesByRepo ? issueKeysByRepo.get(repoRoot) ?? new Set<string>() : legacyKnown;

  const planning: RunSummary[] = [];
  const untracked: RunSummary[] = [];
  const orphaned: RunSummary[] = [];
  for (const run of baseRuns) {
    if (!run.issue) {
      untracked.push(run);
      continue;
    }
    const repoRoot = repoOf(run);
    const known = knownIssues(repoRoot);
    if (!known.has(keyOf(run.issue))) orphaned.push(run);
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
    tone: "issues" | "untracked" | "orphaned" | "status",
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

  const pushIssueTree = (repoRoot: string, repoRuns: readonly RunSummary[], depth: number): void => {
    const issues = issuesFor(repoRoot);
    if (issues.length === 0) return;
    const byIssue = new Map<string, RunSummary[]>();
    for (const run of repoRuns) {
      if (!run.issue) continue;
      const key = keyOf(run.issue);
      const list = byIssue.get(key) ?? [];
      list.push(run);
      byIssue.set(key, list);
    }
    const childrenOf = (issue: Issue): Issue[] =>
      sortIssues(
        issues.filter(
          (candidate) =>
            candidate.parent &&
            candidate.parent.repo === issue.ref.repo &&
            candidate.parent.number === issue.ref.number,
        ),
      );
    const ownMatch = (issue: Issue): boolean => text.length > 0 && issueText(issue).toLowerCase().includes(text);
    const issueRuns = (issue: Issue): RunSummary[] => byIssue.get(keyOf(issue.ref)) ?? [];
    const relevantCache = new Map<string, boolean>();
    const issueRelevant = (issue: Issue): boolean => {
      const key = keyOf(issue.ref);
      const cached = relevantCache.get(key);
      if (cached !== undefined) return cached;
      const hasRun = issueRuns(issue).length > 0;
      const childRelevant = childrenOf(issue).some((child) => issueRelevant(child));
      // Planning anchors are always shown: runs attach to them for planning
      // work, and hiding a gate makes a stalled plan unreadable.
      const relevant =
        text.length === 0 || ownMatch(issue) || hasRun || childRelevant;
      relevantCache.set(key, relevant);
      return relevant;
    };

    const roots = sortIssues(issueRoots(issues));
    const issueCount = issues.filter((issue) => issueRelevant(issue)).length;
    const sectionId = `issues:${repoRoot}`;
    if (!pushSection(sectionId, "Git issues", issueCount, depth, "issues")) return;

    const descendantsCache = new Map<string, { tasks: Issue[]; runs: RunSummary[] }>();
    const descendantsOf = (issue: Issue): { tasks: Issue[]; runs: RunSummary[] } => {
      const key = keyOf(issue.ref);
      const cached = descendantsCache.get(key);
      if (cached) return cached;
      const tasks: Issue[] = [];
      const runs: RunSummary[] = [];
      for (const child of childrenOf(issue)) {
        if (child.kind === "feature" && isDeliverable(child)) tasks.push(child);
        runs.push(...issueRuns(child));
        const nested = descendantsOf(child);
        tasks.push(...nested.tasks);
        runs.push(...nested.runs);
      }
      const result = { tasks, runs };
      descendantsCache.set(key, result);
      return result;
    };

    const walk = (issue: Issue, issueDepth: number, parent?: string): void => {
      if (!issueRelevant(issue)) return;
      const children = childrenOf(issue).filter(issueRelevant);
      const directRuns = issueRuns(issue);
      const descendants = descendantsOf(issue);
      const rollup = rollupIssue(issue, directRuns, descendants.tasks, descendants.runs, now);
      const id = `issue:${keyOf(issue.ref)}`;
      const collapsible = children.length > 0 || directRuns.length > 0;
      const isCollapsed = collapsed.has(id);
      const row: RunRow = {
        kind: "issue",
        id,
        issue,
        depth: issueDepth,
        rollup,
        parent,
        collapsible,
        collapsed: isCollapsed,
        childCount: children.length,
        directRuns: directRuns.length,
      };
      rows.push(row);
      byIssueKey.set(keyOf(issue.ref), row as RunRow & { kind: "issue" });
      if (isCollapsed) return;
      for (const child of children) walk(child, issueDepth + 1, id);
      pushRuns(directRuns, issueDepth + 1, id);
    };

    for (const root of roots) walk(root, depth + 1, sectionId);
  };

  const pushPacketTree = (repoRoot: string, repoRuns: readonly RunSummary[], depth: number): void => {
    const packets = options.packets ?? [];
    if (packets.length === 0) return;
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
    const categories = options.planCategories?.categories ?? [];
    for (const category of categories) {
      const slugs = category.slugs.filter((slug) => bySlug.has(slug));
      if (slugs.length === 0) continue;
      const sectionId = `plan:${repoRoot}:${category.heading}`;
      if (!pushSection(sectionId, category.heading, slugs.length, depth, "issues")) continue;
      for (const slug of slugs) pushPacketRow(slug, depth + 1, sectionId);
    }
    const orphanSlugs = (options.planCategories?.orphanSlugs ?? []).filter((slug) => bySlug.has(slug));
    if (orphanSlugs.length > 0) {
      const sectionId = `plan:${repoRoot}:orphan`;
      if (pushSection(sectionId, "No plan", orphanSlugs.length, depth, "orphaned")) {
        for (const slug of orphanSlugs) pushPacketRow(slug, depth + 1, sectionId);
      }
    }
  };

  const issueOnlyRepos =
    group === "gh-issue" && !options.attentionOnly && options.issuesByRepo
      ? [...options.issuesByRepo.entries()]
          .filter(([, issues]) => issues.length > 0)
          .map(([repoRoot]) => repoRoot)
      : [];
  // A repo with packets but no runs still shows its packet tree in the
  // `packets` group, mirroring the issue-only repo behavior.
  const repoNames = [
    ...new Set([
      ...baseRuns.map(repoOf),
      ...issueOnlyRepos,
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
      if (repoRuns.length === 0 && !packetRepo) {
        if (group !== "gh-issue" || options.attentionOnly) continue;
        // Issue-only repo (no runs at all): keep the tree so cached issues
        // stay visible. During text search only repos with a matching issue
        // stay; repos that merely have non-matching runs keep prior behavior.
        if (baseRuns.some((run) => repoOf(run) === repoRoot)) continue;
        const repoIssues = issuesFor(repoRoot);
        if (repoIssues.length === 0) continue;
        if (text && !repoIssues.some((issue) => issueText(issue).toLowerCase().includes(text))) continue;
      }
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

      pushIssueTree(repoRoot, repoRuns, 1);

      const free = repoRuns.filter((run) => !run.issue);
      const untrackedId = `untracked:${repoRoot}`;
      if (pushSection(untrackedId, "Untracked", free.length, 1, "untracked")) {
        pushRuns(free, 2, untrackedId);
      }

      const known = knownIssues(repoRoot);
      const missing = repoRuns.filter((run) => run.issue && !known.has(keyOf(run.issue)));
      const orphanedId = `orphaned:${repoRoot}`;
      if (pushSection(orphanedId, "Orphaned issue", missing.length, 1, "orphaned")) {
        pushRuns(missing, 2, orphanedId);
      }
    }
  }

  return {
    group,
    rows,
    selectable: rows,
    byRunId,
    byIssueKey,
    runs: visibleRuns,
    untracked: sortRuns(untracked, "activity"),
    planning: sortRuns(planning, "activity"),
    orphaned: sortRuns(orphaned, "activity"),
    attention: attentionRuns.length,
  };
}

/**
 * Rows that stay bright while the cursor sits on an issue or run.
 *
 * A focus keeps the selected row, its issue ancestors, its peers at the same
 * level, and its immediate children bright: features under an epic and runs
 * under a feature. Repo and section headings always
 * stay bright; selecting one disables dimming.
 */
export function focusRowIds(
  rows: readonly RunRow[],
  selected: RunRow | undefined,
): Set<string> | null {
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

  for (const ancestor of ancestorsOf(selected)) focus.add(ancestor.id);

  if (selected.kind === "issue") {
    for (const row of rows) {
      if (
        row.kind === "issue" &&
        row.parent === selected.parent &&
        row.issue.kind === selected.issue.kind
      ) {
        focus.add(row.id);
      }
    }
  } else {
    for (const row of rows) {
      if (row.kind === "run" && row.parent === selected.parent) focus.add(row.id);
    }
  }

  const childKind =
    selected.kind === "issue"
      ? selected.issue.kind === "epic"
        ? "feature"
        : "run"
      : undefined;
  for (const row of rows) {
    if (row.kind !== "issue" && row.kind !== "run") continue;
    if (row.parent !== selected.id) continue;
    if (childKind === "run" ? row.kind === "run" : row.kind === "issue" && row.issue.kind === childKind) {
      focus.add(row.id);
    }
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

export function issueOf(row: RunRow | undefined): Issue | undefined {
  return row?.kind === "issue" ? row.issue : undefined;
}
