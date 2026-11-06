/**
 * machine_code — the `issue` tool: structured, capability-gated issue access.
 *
 * One tool with an action enum keeps the tool surface small while enforcing
 * the Epic → Feature hierarchy in the harness:
 *   - create Epic    → no parent
 *   - create Feature → requires a parent Epic
 *   - link           → Feature→Epic only
 *   - plan           → Feature issues only
 *   - close          → acceptance + approval policy (human requests approval)
 *   - ensure         → validates the Epic → Feature hierarchy
 *
 * Reads are issue:read; creating needs issue:create; editing, linking, and
 * ensure need issue:plan (legacy issue:write / issue:hierarchy:write remain
 * aliases); closure needs issue:close.
 */
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  IssueError,
  parseAcceptance,
  parseIssueRef,
  refKey,
  type Issue,
  type IssueProvider,
  type IssueRef,
} from "../issues/provider.js";
import { issueContextErrors, withContextFiles } from "../issues/context.js";
import { checkCompletion } from "../issues/completion.js";
import { renderPlanMarker, type PlanMarker, type PlanReview, type PlanRole, type PlanStatus, type PlanVerification, type PlanWorktree } from "../plan/schema.js";
import { featureSizeErrors, validatePlanIssue } from "../plan/validate.js";
import type { Layout } from "../paths.js";
import type { RunRecorder } from "../state/runs.js";
import type { RunStateStore } from "../context/state.js";
import { loadMachineConfig } from "../config.js";
import { parsePlanRef, readPlanLines, trackIssueInPlan, untrackIssueInPlans } from "../plan/tracking.js";
import { isSecretPath } from "./safety.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface IssueToolContext {
  provider: IssueProvider;
  /** Default repo for bare issue numbers. */
  repo?: string;
  capabilities: readonly string[];
  recorder: RunRecorder;
  /** Needed for acceptance-evidence lookup in this repo's runs. */
  layout: Layout;
  /** Optional run state so the next prompt remembers the issue graph. */
  state?: RunStateStore;
  /** Approval default for deliverables created by this run. */
  defaultApproval: "human" | "agent";
}

const GraphNode = Type.Object({
  key: Type.String({ description: "Temporary key used by later nodes." }),
  title: Type.String(),
  body: Type.Optional(
    Type.String({
      description: "Required. Epic needs ## Context; Feature needs ## Deliverable and acceptance criteria.",
    }),
  ),
  /** Source plan lines this node replaces, e.g. `plans/tui.md:12-14`. */
  plan_ref: Type.Optional(
    Type.String({
      description:
        "Optional plan source: plans/<name>.md:<start>[-<end>] (1-based lines). " +
        "The tracking line replaces those lines and the plan file is committed on main.",
    }),
  ),
  context_files: Type.Optional(
    Type.Array(Type.String({ description: "Repo-relative files you chose after reading; recorded in mc:context." })),
  ),
  blocked_by: Type.Optional(Type.Array(Type.String({ description: "Temporary key or issue ref." }))),
});
const GraphParams = Type.Object({
  epic: GraphNode,
  features: Type.Array(GraphNode),
}, {
  description: "Graph payload.",
});

const IssueGraphParams = Type.Object({
  epic: GraphNode,
  features: Type.Array(GraphNode),
  dry_run: Type.Optional(
    Type.Boolean({ description: "Validate and summarize the graph without creating issues." }),
  ),
}, {
  description:
    "Create an Epic with Features in one call. Pass epic and features at the top level. " +
    "For more than 3 features, create layers with the issue tool instead.",
});

const IssueParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("view"),
      Type.Literal("tree"),
      Type.Literal("create"),
      Type.Literal("edit"),
      Type.Literal("plan"),
      Type.Literal("close"),
      Type.Literal("link"),
      Type.Literal("ensure"),
    ],
    { description: "Issue operation." },
  ),
  issue: Type.Optional(Type.String({ description: "Issue ref: 123, owner/repo#123, or a URL." })),
  parent: Type.Optional(Type.String({ description: "Parent ref (link/create)." })),
  kind: Type.Optional(
    Type.Union([Type.Literal("epic"), Type.Literal("feature")], {
      description: "Issue kind for create.",
    }),
  ),
  title: Type.Optional(Type.String()),
  body: Type.Optional(
    Type.String({
      description:
        "Required for create/edit. Epic needs ## Context, ## Goal, ## Scope. Feature needs ## Context, ## Deliverable and acceptance criteria.",
    }),
  ),
  context_files: Type.Optional(
    Type.Array(Type.String({ description: "Repo-relative files you chose after reading; recorded in mc:context." })),
  ),
  labels: Type.Optional(Type.Array(Type.String())),
  /** Issue refs this issue is blocked by (create/edit). */
  blocked_by: Type.Optional(Type.Array(Type.String({ description: "Issue ref: 123, owner/repo#123, or a URL." }))),
  /** Alias for blocked_by. Dependencies are the same graph. */
  depends_on: Type.Optional(Type.Array(Type.String({ description: "Alias for blocked_by." }))),
  /** Edit only: remove these blocked_by links. */
  remove_blocked_by: Type.Optional(Type.Array(Type.String({ description: "Issue ref to stop being blocked by." }))),
  /** Create only: plan source lines this issue replaces, e.g. `plans/tui.md:12-14`. */
  plan_ref: Type.Optional(
    Type.String({
      description:
        "Optional plan source for create: plans/<name>.md:<start>[-<end>] (1-based lines). " +
        "The tracking line replaces those lines and the plan file is committed on main.",
    }),
  ),
  state: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
      description: "Issue-state filter for list/tree: open | closed | all. Use state, not status.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max issues to list (default 100, max 200)." })),
  reason: Type.Optional(Type.String({ description: "Close reason (close)." })),
  depth: Type.Optional(Type.Number({ description: "Tree depth (default 2)." })),
  /** mc:plan fields for the `plan` action. */
  plan_status: Type.Optional(
    Type.Union([Type.Literal("draft"), Type.Literal("ready")], {
      description: "Plan status for action=plan: draft | ready. Not an issue filter.",
    }),
  ),
  /** Legacy alias for plan_status. */
  status: Type.Optional(
    Type.Union([Type.Literal("draft"), Type.Literal("ready")], {
      description: "Deprecated alias for plan_status.",
    }),
  ),
  plan_role: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("review")])),
  verification: Type.Optional(
    Type.Union([Type.Literal("direct"), Type.Literal("verified")]),
  ),
  worktree: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("optional")])),
  retries_before_replan: Type.Optional(Type.Number({ description: "Integer 0-20 (default 2)." })),
  plan_review: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("human")])),
  result_review: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("human")])),
});

type IssueToolParams = Static<typeof IssueParams>;
type InternalIssueParams = Omit<IssueToolParams, "action"> & {
  action: IssueToolParams["action"] | "graph";
  graph?: Static<typeof GraphParams>;
  dry_run?: boolean;
};

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

/**
 * Plan file to track an issue in: the configured `context.plan_file` when
 * set, otherwise a `plans/<name>.md` reference in the issue body.
 */
function trackingPlanFile(ctx: IssueToolContext, body: string): string | undefined {
  try {
    const configured = loadMachineConfig(ctx.layout)?.context?.planFile;
    if (configured) return configured;
  } catch {
    // A broken machine config must not block issue tracking.
  }
  const match = body.match(/plans\/[A-Za-z0-9][\w\-.]*\.md/);
  return match ? match[0] : undefined;
}

/**
 * Best-effort tracking-line append. Records a `plan_tracking` event either
 * way and never throws: tracking must not fail the issue tool.
 */
/**
 * Repo files this run actually read, most recent first. The planner reads
 * the code its features describe; attaching those paths as issue context
 * means the builder starts with the files pinned instead of re-discovering
 * them over several turns. Attribution is windowed: reads since this run's
 * last issue creation, so sequential creates each get their own context.
 * Best-effort: anything unreadable or out of scope is skipped silently.
 */
function recentlyReadFiles(ctx: IssueToolContext, limit = 6, windowed = true): string[] {
  let events: Array<Record<string, unknown>>;
  try {
    events = ctx.recorder.readEvents() as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const cleaned = raw.trim().replace(/^\.\//, "");
    if (!cleaned || cleaned === "null" || cleaned === "undefined") return;
    if (cleaned.startsWith("/") || cleaned.split("/").includes("..")) return;
    if (cleaned.startsWith("plans/") || cleaned.startsWith("knowledge/") || cleaned.startsWith(".")) return;
    if (isSecretPath(cleaned) || seen.has(cleaned)) return;
    let abs: string;
    try {
      abs = join(ctx.layout.repoRoot, cleaned);
      if (!existsSync(abs) || !statSync(abs).isFile()) return;
    } catch {
      return;
    }
    seen.add(cleaned);
    if (out.length < limit) out.push(cleaned);
  };
  for (let index = events.length - 1; index >= 0 && out.length < limit; index--) {
    const event = events[index]!;
    if (windowed && event.type === "issue_created") break;
    if (event.type !== "tool_call_start") continue;
    const tool = event.tool;
    const args = (event.args ?? {}) as Record<string, unknown>;
    if (tool === "read" && typeof args.path === "string") push(args.path);
    else if (tool === "search" && Array.isArray(args.paths)) {
      for (const item of args.paths as unknown[]) push(item);
    }
  }
  return out;
}

function trackCreated(
  ctx: IssueToolContext,
  kind: "epic" | "feature",
  number: number,
  title: string,
  planFile?: string,
  planRef?: string,
): Promise<string> {
  return trackIssueInPlan(ctx.layout.repoRoot, {
    kind,
    number,
    title,
    ...(planFile ? { planFile } : {}),
    ...(planRef ? { planRef } : {}),
  }).then(({ note, committed }) => {
    ctx.recorder.event("plan_tracking", {
      action: planRef ? "replace" : "append",
      issue: number,
      ...(planFile ? { planFile } : {}),
      ...(planRef ? { planRef } : {}),
      committed,
    });
    return note;
  }).catch((error) => {
    ctx.recorder.event("plan_tracking", {
      action: planRef ? "replace_failed" : "append_failed",
      issue: number,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  });
}

/** Best-effort tracking-line removal from every plans/*.md file, committed on main. */
function untrackClosed(ctx: IssueToolContext, number: number): Promise<string> {
  return untrackIssueInPlans(ctx.layout.repoRoot, number).then(({ files, committed }) => {
    ctx.recorder.event("plan_tracking", { action: "remove", issue: number, planFiles: files, committed });
    return files.length > 0 ? ` Removed tracking from ${files.join(", ")}.` : "";
  }).catch((error) => {
    ctx.recorder.event("plan_tracking", {
      action: "remove_failed",
      issue: number,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  });
}

/**
 * Validate `plan_ref` source refs without touching anything: parseable shape,
 * an existing plans/*.md file, an in-bounds range, and no overlaps between
 * items in one call.
 */
function validatePlanRefs(
  repoRoot: string,
  items: Array<{ label: string; planRef?: string }>,
): string[] {
  const errors: string[] = [];
  const seen: Array<{ label: string; file: string; start: number; end: number }> = [];
  for (const item of items) {
    if (!item.planRef) continue;
    const parsed = parsePlanRef(item.planRef);
    if (parsed.error || !parsed.ref) {
      errors.push(`${item.label}: ${parsed.error ?? "invalid plan_ref"}`);
      continue;
    }
    const { file, start, end } = parsed.ref;
    const lines = readPlanLines(repoRoot, file);
    if (!lines) {
      errors.push(`${item.label}: plan file not found: ${file}`);
      continue;
    }
    if (end > lines.length) {
      errors.push(`${item.label}: plan_ref ${file}:${start}-${end} is out of bounds (${lines.length} lines)`);
      continue;
    }
    for (const prior of seen) {
      if (prior.file === file && start <= prior.end && prior.start <= end) {
        errors.push(`${item.label} plan_ref ${file}:${start}-${end} overlaps ${prior.label} (${prior.start}-${prior.end})`);
      }
    }
    seen.push({ label: item.label, file, start, end });
  }
  return errors;
}

function line(issue: Issue): string {
  const bits = [`#${issue.ref.number}`, issue.kind, issue.state, issue.title];
  if (issue.parent) bits.push(`parent=#${issue.parent.number}`);
  if (issue.approval) bits.push(`approval=${issue.approval}`);
  if (issue.plan) bits.push(`plan=${issue.plan.status}`);
  if (issue.planError) bits.push("plan=invalid");
  if (issue.acceptance.length > 0) bits.push(`accept=${issue.acceptance.length}`);
  if (issue.blockedBy.length > 0) bits.push(`blocked-by=${issue.blockedBy.map((b) => `#${b.number}`).join(",")}`);
  return bits.join(" ");
}

function parseJsonish(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON object or array, not a string`);
  }
}

/** Weak models serialize absent optionals as the string "null". No optional
 * field ever means the literal text "null", so drop null-like scalar values
 * (and null-like entries inside string arrays) before schema validation.
 * A successfully repaired call still must satisfy the real schema. */
function stripNullStrings(out: Record<string, unknown>, repairs: string[]): void {
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && (value.trim() === "null" || value.trim() === "undefined")) {
      delete out[key];
      repairs.push(`${key}:"null" dropped`);
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const kept = (value as string[]).filter(
        (item) => item.trim() !== "null" && item.trim() !== "undefined",
      );
      if (kept.length !== value.length) {
        if (kept.length > 0) out[key] = kept;
        else delete out[key];
        repairs.push(`${key} null entries dropped`);
      }
    }
  }
}

/** Accept status=open as the tree/list filter alias for state. */
function normalizeIssueArguments(
  args: unknown,
  recorder: RunRecorder,
): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  const repairs: string[] = [];
  stripNullStrings(out, repairs);
  if (
    (out.action === "list" || out.action === "tree") &&
    out.state === undefined &&
    (out.status === "open" || out.status === "closed" || out.status === "all")
  ) {
    out.state = out.status;
    delete out.status;
    repairs.push("status->state");
  }
  if (repairs.length > 0) {
    recorder.event("tool_call_repaired", { tool: "issue", repairs });
  }
  return out;
}

function normalizeIssueGraphArguments(
  args: unknown,
  recorder: RunRecorder,
): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  const repairs: string[] = [];
  const nested = out.graph;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const key of ["epic", "features"] as const) {
      if (out[key] === undefined && key in nested) {
        out[key] = (nested as Record<string, unknown>)[key];
        repairs.push(`graph.${key}->${key}`);
      }
    }
    delete out.graph;
  }
  delete out.action;
  for (const key of ["epic", "features"] as const) {
    if (!(key in out)) continue;
    const before = out[key];
    let value = parseJsonish(before, key);
    if (key === "features" && value && !Array.isArray(value)) value = [value];
    if (value !== before) repairs.push(`${key} JSON string`);
    out[key] = value;
  }
  // Null-string scalars inside graph items mean "absent", not literal text.
  for (const item of [out.epic, ...(Array.isArray(out.features) ? out.features : [])]) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      stripNullStrings(item as Record<string, unknown>, repairs);
    }
  }
  if (repairs.length > 0) {
    recorder.event("tool_call_repaired", { tool: "issue_graph", repairs });
  }
  return out;
}

export function issueTools(ctx: IssueToolContext): { issue: AgentTool<typeof IssueParams>; graph: AgentTool<typeof IssueGraphParams> } {
  /** The graph changes only through this tool; cache trees until a write. */
  const treeCache = new Map<string, string>();
  const require = (cap: string): void => {
    if (!ctx.capabilities.includes(cap)) {
      throw new IssueError("capability_missing", `issue tool action requires ${cap}`);
    }
  };
  const requirePlan = (): void => {
    if (
      ctx.capabilities.includes("issue:plan") ||
      ctx.capabilities.includes("issue:write") ||
      ctx.capabilities.includes("issue:hierarchy:write")
    ) {
      return;
    }
    throw new IssueError("capability_missing", "issue tool action requires issue:plan");
  };
  const requireCreate = (): void => {
    if (ctx.capabilities.includes("issue:create")) return;
    throw new IssueError(
      "issue_create_forbidden",
      "creating issues requires issue:create; use an agent with issue_access=create",
    );
  };
  const dependencies = async (
    values: Array<readonly string[] | undefined>,
    owner?: IssueRef,
  ): Promise<IssueRef[] | undefined> => {
    const raw = values.flatMap((value) => value ?? []);
    if (raw.length === 0) return undefined;
    const unique = new Map<string, IssueRef>();
    for (const value of raw) {
      const dependency = parseIssueRef(value, ctx.repo, ctx.provider.kind);
      if (ctx.repo && dependency.repo !== ctx.repo) {
        throw new IssueError(
          "dependency_repo",
          `dependency ${dependency.repo}#${dependency.number} must be in the same repository (${ctx.repo})`,
        );
      }
      if (owner && refKey(owner) === refKey(dependency)) {
        throw new IssueError("dependency_self", "an issue cannot block itself");
      }
      const found = await ctx.provider.get(dependency);
      if (!found) throw new IssueError("dependency_not_found", `dependency ${value} was not found`);
      unique.set(refKey(dependency), dependency);
    }
    return [...unique.values()];
  };
  const ref = (value: string | undefined, label: string): IssueRef => {
    if (!value) throw new IssueError("argument_missing", `${label} is required`);
    return parseIssueRef(value, ctx.repo, ctx.provider.kind);
  };
  const remember = (issue: Issue, extra = ""): void => {
    const parent = issue.parent ? ` parent #${issue.parent.number}` : "";
    const plan = issue.plan ? ` plan ${issue.plan.status}` : "";
    const accept = issue.acceptance.length > 0 ? ` accept=${issue.acceptance.length}` : "";
    const blocked = issue.blockedBy.length > 0
      ? ` blocked-by ${issue.blockedBy.map((dependency) => `#${dependency.number}`).join(",")}`
      : "";
    ctx.state?.addIssueFact(
      issue.ref.number,
      `#${issue.ref.number} ${issue.kind} ${issue.state} "${issue.title}"${parent}${plan}${accept}${blocked}${extra ? ` ${extra}` : ""}`,
    );
  };

  /** A Feature with acceptance is ready by default; do not spend a turn on plan. */
  const autoPlan = async (target: Issue): Promise<{ issue?: Issue; error?: string }> => {
    if (target.plan || target.acceptance.length === 0) return {};
    const plan: PlanMarker = {
      v: 1,
      status: "ready",
      role: "build",
      verification: "verified",
      worktree: "required",
      retriesBeforeReplan: 2,
      planReview: "agent",
      resultReview: "agent",
    };
    const marker = renderPlanMarker(plan);
    const nextBody = `${target.body.replace(/\s+$/, "")}\n\n${marker}\n`;
    const validation = validatePlanIssue({ ...target, body: nextBody }, { layout: ctx.layout });
    if (!validation.ok) return { error: validation.errors.join("; ") };
    const updated = await ctx.provider.update(target.ref, { body: nextBody });
    ctx.recorder.event("plan_updated", {
      issue: updated.ref.number,
      status: plan.status,
      verification: plan.verification,
      worktree: plan.worktree,
    });
    return { issue: updated };
  };

  const issue: AgentTool<typeof IssueParams> = {
    name: "issue",
    label: "issue",
      description:
        "Structured GitHub issue access. list/view/tree read (tree without issue shows all roots); create/edit write; create/edit accept blocked_by/depends_on; " +
        "remove_blocked_by unwires links on edit. " +
        "Every created/edited Epic needs ## Context, ## Goal, ## Scope; every Feature needs ## Context, ## Deliverable and acceptance criteria. The tool rejects missing context. " +
        "plan writes the Feature mc:plan marker; link sets the Feature→Epic parent; ensure validates hierarchy; close follows approval. " +
        "Independent create/edit calls in one assistant turn run in parallel; send a whole layer of Features together. " +
        "Pass context_files for the exact repo files you chose after reading; the tool records them in mc:context. Nothing is inferred. " +
        "Reuse a suitable Epic; otherwise create Epic→Feature, then plan each Feature.",
    parameters: IssueParams,
    prepareArguments: (args) => normalizeIssueArguments(args, ctx.recorder) as Static<typeof IssueParams>,
    async execute(_id, params: Static<typeof IssueParams>) {
      try {
        return await run(params);
      } catch (error) {
        if (error instanceof IssueError) return fail(`${error.code}: ${error.message}`);
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const graph: AgentTool<typeof IssueGraphParams> = {
    name: "issue_graph",
    label: "issue_graph",
    description:
        "Create an Epic with Features in one call. Pass epic and features at the top level. " +
        "Use issue_graph for small plans (<=3 features); otherwise create layers with the issue tool. " +
        "blocked_by chains deliverables only. " +
        "Every Epic body needs ## Context, ## Goal, ## Scope; every Feature needs ## Context, ## Deliverable and acceptance criteria. Use context_files for exact repo files. " +
        "When working from a plan file, pass plan_ref like plans/tui.md:12-14 on each node naming its source lines; " +
        "the tracking line replaces those lines and the plan file is committed on main. " +
        "Set dry_run=true to validate without creating issues.",
    parameters: IssueGraphParams,
    prepareArguments: (args) =>
      normalizeIssueGraphArguments(args, ctx.recorder) as Static<typeof IssueGraphParams>,
    async execute(_id, params: Static<typeof IssueGraphParams>) {
      try {
        return await run({
          action: "graph",
          graph: { epic: params.epic, features: params.features },
          ...(params.dry_run === true ? { dry_run: true } : {}),
        } as InternalIssueParams);
      } catch (error) {
        if (error instanceof IssueError) return fail(`${error.code}: ${error.message}`);
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  return { issue, graph };

  async function run(params: InternalIssueParams): Promise<AgentToolResult<undefined>> {
    switch (params.action) {
      case "list": {
        require("issue:read");
        const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 100)));
        const issues = await ctx.provider.list({ state: params.state ?? "all", limit });
        if (issues.length === 0) {
          const canCreate = ctx.capabilities.includes("issue:create");
          return ok(
            canCreate
              ? "no issues\nNo issues exist yet. If you are planning, create the Epic now: " +
                  'issue { action: "create", kind: "epic", title: "..." }. Do not list again.'
              : "no issues\nNo issues exist yet. This role has read-only issue access.",
          );
        }
        for (const issue of issues.slice(0, 50)) remember(issue);
        return ok(issues.map(line).join("\n"));
      }
      case "view": {
        require("issue:read");
        const issue = await ctx.provider.get(ref(params.issue, "issue"));
        if (!issue) return fail(`issue not found: ${params.issue}`);
        remember(issue);
        ctx.state?.addIssueBodyFact(issue.ref.number, issue.body);
        return ok(`${line(issue)}\n${issue.body.slice(0, 4000)}`);
      }
      case "tree": {
        require("issue:read");
        const depth = Math.max(0, Math.min(5, Math.floor(params.depth ?? 2)));
        const state = params.state ?? "open";
        const rootRef = params.issue ? ref(params.issue, "issue") : undefined;
        const treeKey = rootRef ? `${refKey(rootRef)}:${depth}` : `roots:${state}:${depth}`;
        const cached = treeCache.get(treeKey);
        if (cached) return ok(`${cached}\n[cached tree; issue graph unchanged]`);
        let deliverableFeatures = 0;
        let readyFeatures = 0;
        let contextMissing = 0;
        const inspect = (issue: Issue): void => {
          if (issueContextErrors({ kind: issue.kind, body: issue.body }).length > 0) {
            contextMissing += 1;
          }
          if (issue.kind !== "feature") return;
          deliverableFeatures += 1;
          if (issue.plan?.status === "ready") readyFeatures += 1;
        };
        const lines: string[] = [];
        const walk = async (issue: Issue, level: number): Promise<void> => {
          if (level >= depth) return;
          for (const child of await ctx.provider.children(issue.ref)) {
            remember(child);
            inspect(child);
            lines.push(`${"  ".repeat(level + 1)}${line(child)}`);
            await walk(child, level + 1);
          }
        };
        // No issue: show every root (open by default), so a planner can inspect
        // the whole forest without guessing a number first.
        if (!rootRef) {
          const roots = (await ctx.provider.list({ state, limit: 200 })).filter((issue) => !issue.parent);
          for (const root of roots) {
            remember(root);
            inspect(root);
            lines.push(line(root));
            await walk(root, 0);
          }
          if (lines.length === 0) {
            return ok(
              state === "open"
                ? "no open issues\nCreate the Epic with action=create if you are planning."
                : "no issues",
            );
          }
        } else {
          const root = await ctx.provider.get(rootRef);
          if (!root) return fail(`issue not found: ${params.issue}`);
          remember(root);
          inspect(root);
          lines.push(line(root));
          await walk(root, 0);
        }
        const graphNote = deliverableFeatures === 0
          ? ""
          : deliverableFeatures === readyFeatures
            ? `Graph complete: all ${deliverableFeatures} deliverable Features are plan ready. Create a named Epic/Feature only when the request asks; else stop with issue numbers.`
            : `Graph incomplete: ${deliverableFeatures - readyFeatures} of ${deliverableFeatures} deliverable Features are not plan ready.`;
        const contextNote = contextMissing > 0
          ? `Context incomplete: ${contextMissing} issue(s) miss required body sections. Repair them with action=edit when the request asks.`
          : "";
        const note = [graphNote, contextNote].filter(Boolean).join("\n");
        const text = note ? `${note}\n\n${lines.join("\n")}` : lines.join("\n");
        treeCache.set(treeKey, text);
        return ok(text);
      }
      case "graph": {
        requireCreate();
        if (!params.graph) {
          return fail(
            "graph action requires graph. Send {\"action\":\"graph\",\"graph\":{\"epic\":{...},\"features\":[...]}}. " +
              "epic/features are not top-level parameters.",
          );
        }
        const graph = params.graph;
        const dryRun = params.dry_run === true;
        // Attach what this run actually read: the planner's working set
        // becomes each node's context, so the builder starts pinned. One
        // snapshot for the whole graph — creates run back-to-back with no
        // reads between them, so per-node windowing would starve every node.
        const graphReads = recentlyReadFiles(ctx, 8, false);
        graph.epic.body = withContextFiles(graph.epic.body ?? "", [
          ...(graph.epic.context_files ?? []),
          ...graphReads,
        ]);
        for (const feature of graph.features) {
          feature.body = withContextFiles(feature.body ?? "", [
            ...(feature.context_files ?? []),
            ...graphReads,
          ]);
        }
        const keys = new Set<string>();
        const addKey = (key: string): void => {
          if (!key) throw new IssueError("graph_key_missing", "every graph node needs a key");
          if (keys.has(key)) throw new IssueError("graph_key_duplicate", `duplicate graph key ${key}`);
          keys.add(key);
        };
        addKey(graph.epic.key);
        for (const feature of graph.features) addKey(feature.key);
        // Validate blocked_by before anything is created (dry runs included):
        // temp keys must exist in the payload, issue refs must exist.
        const checkGraphDependency = async (ownerLabel: string, ownerKey: string, value: string): Promise<void> => {
          if (keys.has(value)) {
            if (value === ownerKey) throw new IssueError("dependency_self", `${ownerLabel} cannot block itself`);
            return;
          }
          const dependency = parseIssueRef(value, ctx.repo, ctx.provider.kind);
          if (ctx.repo && dependency.repo !== ctx.repo) {
            throw new IssueError(
              "dependency_repo",
              `${ownerLabel}: dependency ${dependency.repo}#${dependency.number} must be in the same repository (${ctx.repo})`,
            );
          }
          const found = await ctx.provider.get(dependency);
          if (!found) throw new IssueError("dependency_not_found", `${ownerLabel}: dependency ${value} was not found`);
        };
        for (const feature of graph.features) {
          for (const value of feature.blocked_by ?? []) {
            await checkGraphDependency(`feature ${feature.key}`, feature.key, value);
          }
        }
        const bodyErrors: string[] = [];
        const checkBody = (label: string, kind: "epic" | "feature", body = ""): void => {
          for (const error of issueContextErrors({ kind, body })) bodyErrors.push(`${label} ${error}`);
        };
        checkBody(`epic ${graph.epic.key}`, "epic", graph.epic.body);
        for (const feature of graph.features) checkBody(`feature ${feature.key}`, "feature", feature.body);
        if (bodyErrors.length > 0) {
          return fail(
            `graph issues need body context: ${bodyErrors.join(" | ")}. ` +
              "Add the required sections and retry. Template per feature: " +
              "## Context (why + files/symbols) ## Deliverable (done-state) " +
              "## Acceptance criteria (- one verifiable item per line, <=3). " +
              "The epic additionally needs ## Goal and ## Scope.",
          );
        }
        const oversized = graph.features
          .map((feature) => ({
            key: feature.key,
            errors: featureSizeErrors({
              acceptance: parseAcceptance(feature.body ?? ""),
              body: feature.body ?? "",
            }),
          }))
          .filter((feature) => feature.errors.length > 0);
        if (oversized.length > 0) {
          return fail(
            `graph has oversized Features: ${oversized
              .map((feature) => `${feature.key} (${feature.errors.join("; ")})`)
              .join(" | ")}. Split each into smaller Features and retry.`,
          );
        }
        const refErrors = validatePlanRefs(ctx.layout.repoRoot, [
          { label: `epic ${graph.epic.key}`, planRef: graph.epic.plan_ref },
          ...graph.features.map((feature) => ({ label: `feature ${feature.key}`, planRef: feature.plan_ref })),
        ]);
        if (refErrors.length > 0) {
          return fail(
            `graph plan_refs are invalid: ${refErrors.join(" | ")}. ` +
              "Use plans/<name>.md:<start>[-<end>] with 1-based lines that exist and do not overlap.",
          );
        }
        if (dryRun) {
          return ok(
            `graph valid: epic ${graph.epic.key}; features ${graph.features.length}; no issues created`,
          );
        }
        const createdNodes = new Map<string, Issue>();
        const resolveDependencies = (values: string[] | undefined): IssueRef[] | undefined => {
          const refs = (values ?? []).map((value) => {
            const node = createdNodes.get(value);
            return node ? node.ref : parseIssueRef(value, ctx.repo, ctx.provider.kind);
          });
          return refs.length > 0 ? refs : undefined;
        };
        const notReady: string[] = [];
        treeCache.clear();
        const epic = await ctx.provider.create({
          title: graph.epic.title,
          body: withApproval(graph.epic.body ?? "", ctx.defaultApproval),
          kind: "epic",
        });
        createdNodes.set(graph.epic.key, epic);
        remember(epic);
        ctx.state?.setPhase("act");
        ctx.recorder.event("issue_created", { number: epic.ref.number, kind: epic.kind, title: epic.title });
        for (const feature of graph.features) {
          const created = await ctx.provider.create({
            title: feature.title,
            body: withApproval(feature.body ?? "", ctx.defaultApproval),
            kind: "feature",
            parent: epic.ref,
          });
          createdNodes.set(feature.key, created);
          remember(created);
          ctx.recorder.event("issue_created", {
            number: created.ref.number,
            kind: created.kind,
            title: created.title,
            parent: epic.ref.number,
          });
          const auto = await autoPlan(created);
          if (auto.issue) remember(auto.issue, "plan ready");
          else notReady.push(`${feature.key}: ${auto.error ?? "missing acceptance criteria"}`);
        }
        for (const feature of graph.features) {
          const target = createdNodes.get(feature.key)!;
          const blockedBy = resolveDependencies(feature.blocked_by);
          if (blockedBy) {
            const updated = await ctx.provider.update(target.ref, { blockedBy });
            remember(updated);
          }
        }
        treeCache.clear();
        const summary = [
          `epic #${epic.ref.number}`,
          `features ${graph.features.map((feature) => `${feature.key}=#${createdNodes.get(feature.key)!.ref.number}`).join(", ") || "none"}`,
        ].join("; ");
        let tracking = "";
        const graphPlanFile = trackingPlanFile(ctx, "");
        tracking += await trackCreated(ctx, "epic", epic.ref.number, epic.title, graphPlanFile, graph.epic.plan_ref);
        for (const feature of graph.features) {
          const created = createdNodes.get(feature.key)!;
          tracking += await trackCreated(ctx, "feature", created.ref.number, created.title, graphPlanFile, feature.plan_ref);
        }
        return ok(
          `created graph: ${summary}${tracking}` +
            (notReady.length > 0 ? `\nnot plan-ready: ${notReady.join("; ")}` : ""),
        );
      }
      case "create": {
        requireCreate();
        treeCache.clear();
        const kind = params.kind as string | undefined;
        if (!kind) return fail("create requires kind (epic|feature)");
        if (kind === "task") return fail("Tasks are no longer tracked; create a Feature under its Epic instead");
        if (kind !== "epic" && kind !== "feature") return fail("create requires kind (epic|feature)");
        if (!params.title) return fail("create requires title");
        const body = withContextFiles(withApproval(params.body ?? "", ctx.defaultApproval), [
          ...(params.context_files ?? []),
          ...recentlyReadFiles(ctx),
        ]);
        const contextErrors = issueContextErrors({ kind, body });
        if (contextErrors.length > 0) {
          return fail(
            `${kind} body needs context: ${contextErrors.join("; ")}. ` +
              "Add the required sections and retry.",
          );
        }
        const parent = params.parent ? ref(params.parent, "parent") : undefined;
        if (kind === "epic") {
          if (parent) return fail("an Epic has no parent");
        } else {
          if (!parent) return fail("creating a Feature requires parent (its Epic)");
          const parentIssue = await ctx.provider.get(parent);
          if (!parentIssue) return fail(`parent not found: ${params.parent}`);
          if (parentIssue.kind !== "epic") return fail(`a Feature's parent must be an Epic (got ${parentIssue.kind})`);
        }
        if (kind === "feature") {
          const errors = featureSizeErrors({ acceptance: parseAcceptance(body), body });
          if (errors.length > 0) {
            return fail(`Feature is too large: ${errors.join("; ")}. Split it into smaller Features and retry.`);
          }
        }
        const blockedBy = await dependencies([params.blocked_by, params.depends_on]);
        const created = await ctx.provider.create({
          title: params.title,
          body,
          kind,
          parent,
          ...(params.labels != null ? { labels: params.labels } : {}),
          ...(blockedBy ? { blockedBy } : {}),
        });
        ctx.recorder.event("issue_created", {
          number: created.ref.number,
          kind: created.kind,
          title: created.title,
          parent: parent?.number,
        });
        remember(created);
        ctx.state?.setPhase("act");
        let note = "";
        if (created.kind === "epic") {
          note =
            `\nNext: create Features with action=create kind=feature parent=#${created.ref.number}.`;
        } else if (created.plan) {
          note = `\nplan already ${created.plan.status}.`;
        } else {
          const auto = await autoPlan(created);
          if (auto.issue) {
            remember(auto.issue, "plan ready");
            note =
              `\nplan ready on #${auto.issue.ref.number}. ` +
              "Use context_files for the exact files you chose after reading. " +
              "Then create the next Feature or stop.";
          } else if (created.acceptance.length > 0) {
            note =
              `\nNext: plan failed (${auto.error ?? "unknown error"}); fix the body ` +
              `(acceptance and mc:context files), then action=plan issue=#${created.ref.number} status=ready.`;
          } else {
            note =
              `\nNext: add acceptance criteria and an mc:context marker with files, ` +
              `then action=plan issue=#${created.ref.number} status=ready.`;
          }
        }
        const planFile = trackingPlanFile(ctx, params.body ?? "");
        if (planFile || params.plan_ref) {
          note += await trackCreated(ctx, created.kind, created.ref.number, created.title, planFile, params.plan_ref);
        }
        return ok(`created #${created.ref.number} (${created.kind}): ${created.title}${note}`);
      }
      case "edit": {
        requirePlan();
        treeCache.clear();
        const target = await ctx.provider.get(ref(params.issue, "issue"));
        if (!target) return fail(`issue not found: ${params.issue}`);
        if (target.kind !== "epic" && target.kind !== "feature") {
          return fail(`only Epic or Feature issues can be edited (got ${target.kind})`);
        }
        const nextBody = params.body == null
          ? (params.context_files && params.context_files.length > 0
              ? withContextFiles(target.body ?? "", params.context_files)
              : undefined)
          : withContextFiles(params.body, params.context_files);
        if (nextBody !== undefined) {
          const contextErrors = issueContextErrors({ kind: target.kind, body: nextBody });
          if (contextErrors.length > 0) {
            return fail(
              `${target.kind} body needs context: ${contextErrors.join("; ")}. ` +
                "Add the required sections and retry.",
            );
          }
        }
        if (target.kind === "feature" && nextBody !== undefined) {
          const errors = featureSizeErrors({ acceptance: parseAcceptance(nextBody), body: nextBody });
          if (errors.length > 0) {
            return fail(`Feature is too large: ${errors.join("; ")}. Split it into smaller Features and retry.`);
          }
        }
        const blockedBy = await dependencies([params.blocked_by, params.depends_on], target.ref);
        const removeBlockedBy = params.remove_blocked_by?.length
          ? await dependencies([params.remove_blocked_by], undefined)
          : undefined;
        let nextParent: IssueRef | null | undefined;
        if (params.parent !== undefined) {
          const candidate = ref(params.parent, "parent");
          const parentIssue = await ctx.provider.get(candidate);
          if (!parentIssue) return fail(`parent not found: ${params.parent}`);
          if (!(target.kind === "feature" && parentIssue.kind === "epic")) {
            return fail(`invalid hierarchy: ${target.kind} cannot be a child of ${parentIssue.kind} (Feature→Epic)`);
          }
          nextParent = candidate;
        }
        const updated = await ctx.provider.update(target.ref, {
          ...(params.title != null ? { title: params.title } : {}),
          ...(nextBody !== undefined ? { body: nextBody } : {}),
          ...(params.labels != null ? { labels: params.labels } : {}),
          ...(blockedBy ? { blockedBy } : {}),
          ...(removeBlockedBy ? { removeBlockedBy } : {}),
          ...(nextParent !== undefined ? { parent: nextParent } : {}),
        });
        remember(updated);
        ctx.state?.setPhase("act");
        return ok(`updated #${updated.ref.number}: ${updated.title}`);
      }
      case "plan": {
        requirePlan();
        treeCache.clear();
        const target = await ctx.provider.get(ref(params.issue, "issue"));
        if (!target) return fail(`issue not found: ${params.issue}`);
        if (target.kind !== "feature") return fail("mc:plan applies to Feature issues only");
        const planStatus = params.plan_status ?? params.status;
        if (planStatus === "ready" && target.acceptance.length === 0) {
          return fail("a ready plan needs acceptance criteria in the issue body");
        }
        const retries = params.retries_before_replan ?? target.plan?.retriesBeforeReplan ?? 2;
        if (!Number.isInteger(retries) || retries < 0 || retries > 20) {
          return fail("retries_before_replan must be an integer in 0-20");
        }
        const plan: PlanMarker = {
          v: 1,
          status: (planStatus ?? target.plan?.status ?? "draft") as PlanStatus,
          role: (params.plan_role ?? target.plan?.role ?? "build") as PlanRole,
          verification: (params.verification ?? target.plan?.verification ?? "verified") as PlanVerification,
          worktree: (params.worktree ?? target.plan?.worktree ?? "required") as PlanWorktree,
          retriesBeforeReplan: retries,
          planReview: (params.plan_review ?? target.plan?.planReview ?? "agent") as PlanReview,
          resultReview: (params.result_review ?? target.plan?.resultReview ?? "agent") as PlanReview,
        };
        const marker = renderPlanMarker(plan);
        const nextBody = /<!--\s*mc:plan[\s\S]*?-->/.test(target.body)
          ? target.body.replace(/<!--\s*mc:plan[\s\S]*?-->/, marker)
          : `${target.body.replace(/\s+$/, "")}\n\n${marker}\n`;
        const validation = validatePlanIssue({ ...target, body: nextBody }, { layout: ctx.layout });
        if (!validation.ok) {
          return fail(`plan validation failed: ${validation.errors.join("; ")}`);
        }
        const updated = await ctx.provider.update(target.ref, { body: nextBody });
        ctx.recorder.event("plan_updated", {
          issue: updated.ref.number,
          status: plan.status,
          verification: plan.verification,
          worktree: plan.worktree,
        });
        remember(updated, `plan ${plan.status}`);
        ctx.state?.setPhase("act");
        return ok(
          `plan ${plan.status} on #${updated.ref.number}: ${plan.role}/${plan.verification}, ` +
            `worktree ${plan.worktree}, retries ${plan.retriesBeforeReplan}, ` +
            `reviews ${plan.planReview}/${plan.resultReview}`,
        );
      }
      case "close": {
        require("issue:close");
        treeCache.clear();
        const target = await ctx.provider.get(ref(params.issue, "issue"));
        if (!target) return fail(`issue not found: ${params.issue}`);
        const completion = await checkCompletion(ctx.provider, ctx.layout, target);
        if (!completion.ok) return fail(`cannot close #${target.ref.number}: ${completion.reason}`);
        const approval = target.approval ?? ctx.defaultApproval;
        if (approval === "human") {
          ctx.recorder.event("approval_requested", {
            issue: target.ref.number,
            action: "close",
            reason: params.reason ?? "issue closure",
          });
          return ok(
            `close requested for #${target.ref.number}; approval is human — a human must approve with "machine_code approve ${target.ref.number}"`,
          );
        }
        await ctx.provider.close(target.ref, params.reason ?? "completed");
        ctx.recorder.event("issue_closed", {
          issue: target.ref.number,
          by: ctx.recorder.id,
          reason: params.reason,
        });
        const untracked = target.kind === "epic" || target.kind === "feature"
          ? await untrackClosed(ctx, target.ref.number)
          : "";
        return ok(`closed #${target.ref.number}${untracked}`);
      }
      case "link": {
        requirePlan();
        treeCache.clear();
        const child = await ctx.provider.get(ref(params.issue, "issue"));
        if (!child) return fail(`issue not found: ${params.issue}`);
        if (!params.parent) return fail("link requires parent");
        const parent = await ctx.provider.get(ref(params.parent, "parent"));
        if (!parent) return fail(`parent not found: ${params.parent}`);
        if (!(child.kind === "feature" && parent.kind === "epic")) {
          return fail(`invalid hierarchy: ${child.kind} cannot be a child of ${parent.kind} (Feature→Epic)`);
        }
        await ctx.provider.linkParent(child.ref, parent.ref);
        ctx.recorder.event("issue_linked", { issue: child.ref.number, parent: parent.ref.number });
        remember(child, `parent #${parent.ref.number}`);
        return ok(`linked #${child.ref.number} (${child.kind}) under #${parent.ref.number} (${parent.kind})`);
      }
      case "ensure": {
        requirePlan();
        treeCache.clear();
        const target = await ctx.provider.get(ref(params.issue, "issue"));
        if (!target) return fail(`issue not found: ${params.issue}`);
        if (target.kind === "epic") {
          const children = await ctx.provider.children(target.ref);
          const features = children.filter((child) => child.kind === "feature");
          for (const feature of features.slice(0, 50)) remember(feature);
          remember(target);
          const other = children.length - features.length;
          return ok(
            `epic #${target.ref.number}: ${features.length} feature(s)` +
              (other > 0 ? `, ${other} non-feature child(ren)` : ""),
          );
        }
        if (target.kind === "feature") {
          if (!target.parent) return fail(`feature #${target.ref.number} has no parent Epic`);
          const parent = await ctx.provider.get(target.parent);
          if (!parent) return fail(`parent not found for feature #${target.ref.number}`);
          if (parent.kind !== "epic") {
            return fail(`a Feature's parent must be an Epic (got ${parent.kind})`);
          }
          remember(target);
          return ok(`feature #${target.ref.number}: parent epic #${parent.ref.number}`);
        }
        return fail(`only Epic or Feature issues carry a hierarchy (got ${target.kind})`);
      }
      default:
        return fail(`unknown issue action: ${String((params as { action?: unknown }).action)}`);
    }
  }
}

export function issueTool(ctx: IssueToolContext): AgentTool<typeof IssueParams> {
  return issueTools(ctx).issue;
}

export function issueGraphTool(ctx: IssueToolContext): AgentTool<typeof IssueGraphParams> {
  return issueTools(ctx).graph;
}

function withApproval(body: string, mode: "human" | "agent"): string {
  if (/<!--\s*mc:approval/.test(body)) return body;
  return `${body.replace(/\s+$/, "")}\n\n<!-- mc:approval {"mode":"${mode}"} -->\n`;
}

