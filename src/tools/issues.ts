/**
 * machine_code — the `issue` tool: structured, capability-gated issue access.
 *
 * One tool with an action enum keeps the tool surface small while enforcing
 * hierarchy and reserved-issue invariants in the harness:
 *   - create Epic    → ensures Feature 0 + Task 0
 *   - create Feature → ensures Task 0 (and the parent Epic's chain)
 *   - create Task    → ensures the parent Feature's Task 0 first
 *   - link           → Feature→Epic and Task→Feature only
 *   - close          → acceptance + approval policy (human requests approval)
 *   - ensure         → repairs missing/duplicate reserved issues
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
import {
  ensureEpicReserved,
  ensureFeatureReserved,
  isReserved,
  isReservedTask,
  runCountsFrom,
} from "../issues/reserved.js";
import { checkCompletion, cascadeReserved } from "../issues/completion.js";
import { renderPlanMarker, type PlanMarker, type PlanReview, type PlanRole, type PlanStatus, type PlanVerification, type PlanWorktree } from "../plan/schema.js";
import { taskSizeErrors, validatePlanIssue } from "../plan/validate.js";
import type { Layout } from "../paths.js";
import type { RunRecorder } from "../state/runs.js";
import type { RunStateStore } from "../context/state.js";

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
      description: "Required. ## Context; Epic/Feature also ## Goal and ## Scope (Feature also ## Success measures).",
    }),
  ),
  context_files: Type.Optional(
    Type.Array(Type.String({ description: "Repo-relative files you chose after reading; recorded in mc:context." })),
  ),
  blocked_by: Type.Optional(Type.Array(Type.String({ description: "Temporary key or issue ref." }))),
});
const GraphTask = Type.Object({
  key: Type.String({ description: "Temporary key used by later nodes." }),
  feature: Type.String({ description: "Feature key." }),
  title: Type.String(),
  body: Type.Optional(
    Type.String({ description: "Required. ## Context, ## Deliverable, and ## Acceptance criteria." }),
  ),
  context_files: Type.Optional(
    Type.Array(Type.String({ description: "Repo-relative files you chose after reading; recorded in mc:context." })),
  ),
  blocked_by: Type.Optional(Type.Array(Type.String({ description: "Temporary key or issue ref." }))),
});
const GraphParams = Type.Object({
  epic: GraphNode,
  features: Type.Array(GraphNode),
  tasks: Type.Array(GraphTask),
}, {
  description: "Graph payload.",
});

const IssueGraphParams = Type.Object({
  epic: GraphNode,
  features: Type.Array(GraphNode),
  tasks: Type.Array(GraphTask),
  dry_run: Type.Optional(
    Type.Boolean({ description: "Validate and summarize the graph without creating issues." }),
  ),
}, {
  description:
    "Create an Epic with Features and Tasks. Pass epic, features, and tasks at the top level. " +
    "For more than 3 features or 8 tasks, create layers with the issue tool instead.",
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
    Type.Union([Type.Literal("epic"), Type.Literal("feature"), Type.Literal("task")], {
      description: "Issue kind for create.",
    }),
  ),
  title: Type.Optional(Type.String()),
  body: Type.Optional(
    Type.String({
      description:
        "Required for create/edit. ## Context; Epic/Feature also ## Goal and ## Scope (Feature also ## Success measures); Task also ## Deliverable and acceptance criteria.",
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
    Type.Union([Type.Literal("direct"), Type.Literal("verified"), Type.Literal("redundant")]),
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

function line(issue: Issue): string {
  const bits = [`#${issue.ref.number}`, issue.kind, issue.state, issue.title];
  if (isReserved(issue)) bits.push("[reserved]");
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

/** Accept status=open as the tree/list filter alias for state. */
function normalizeIssueArguments(
  args: unknown,
  recorder: RunRecorder,
): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...(args as Record<string, unknown>) };
  if (
    (out.action === "list" || out.action === "tree") &&
    out.state === undefined &&
    (out.status === "open" || out.status === "closed" || out.status === "all")
  ) {
    out.state = out.status;
    delete out.status;
    recorder.event("tool_call_repaired", { tool: "issue", repairs: ["status->state"] });
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
    for (const key of ["epic", "features", "tasks"] as const) {
      if (out[key] === undefined && key in nested) {
        out[key] = (nested as Record<string, unknown>)[key];
        repairs.push(`graph.${key}->${key}`);
      }
    }
    delete out.graph;
  }
  delete out.action;
  for (const key of ["epic", "features", "tasks"] as const) {
    if (!(key in out)) continue;
    const before = out[key];
    let value = parseJsonish(before, key);
    if ((key === "features" || key === "tasks") && value && !Array.isArray(value)) value = [value];
    if (value !== before) repairs.push(`${key} JSON string`);
    out[key] = value;
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
  const counts = () => runCountsFrom(requireRuns(ctx.recorder));
  const remember = (issue: Issue, extra = ""): void => {
    const parent = issue.parent ? ` parent #${issue.parent.number}` : "";
    const plan = issue.plan ? ` plan ${issue.plan.status}` : "";
    const accept = issue.acceptance.length > 0 ? ` accept=${issue.acceptance.length}` : "";
    const blocked = issue.blockedBy.length > 0
      ? ` blocked-by ${issue.blockedBy.map((dependency) => `#${dependency.number}`).join(",")}`
      : "";
    const reserved = isReserved(issue) ? " [reserved]" : "";
    ctx.state?.addIssueFact(
      issue.ref.number,
      `#${issue.ref.number} ${issue.kind} ${issue.state} "${issue.title}"${parent}${plan}${accept}${blocked}${reserved}${extra ? ` ${extra}` : ""}`,
    );
  };
  /**
   * A planner run often starts before the Epic/Feature exists. When it creates
   * the first issue, attach the run to that scope's reserved Task 0 so the
   * Runs page shows it under Planning & Review, never directly under an Epic
   * or Feature.
   */
  const linkPlanningRun = (anchor: Issue): void => {
    const current = ctx.recorder.current;
    if (current.issue) return;
    if (current.agent !== "planner") return;
    ctx.recorder.patchSummary({ issue: anchor.ref });
    ctx.recorder.event("issue_linked", {
      issue: anchor.ref.number,
      kind: anchor.kind,
      source: "planning-anchor",
    });
    remember(anchor);
  };

  /** A Task with acceptance is ready by default; do not spend a turn on plan. */
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
      "Every created/edited body needs ## Context; Epic/Feature also need ## Goal and ## Scope (Feature: ## Success measures); Task needs ## Deliverable and acceptance criteria. The tool rejects missing context. " +
      "plan writes the Task mc:plan marker; link sets parent-child; ensure repairs reserved anchors; close follows approval. " +
      "Independent create/edit calls in one assistant turn run in parallel; send a whole layer (Features or Tasks) together. " +
      "Pass context_files for the exact repo files you chose after reading; the tool records them in mc:context. Nothing is inferred. " +
      "Creating an Epic also creates reserved Feature 0: Planning & Review and Task 0: Planning & Review; creating a Feature also creates reserved Task 0: Planning & Review. " +
      "These anchors are not deliverables. Reuse a suitable non-reserved Epic/Feature; otherwise create Epic→Feature→Task, then plan each Task.",
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
      "Create an Epic with Features and Tasks in one call. Pass epic, features, and tasks at the top level. " +
      "Use issue_graph for small plans (<=3 features, <=8 tasks); otherwise create layers with the issue tool. " +
      "Every body needs ## Context; Epic/Feature also ## Goal and ## Scope (Feature: ## Success measures); " +
      "Task needs ## Deliverable and acceptance criteria. Use context_files for exact repo files. " +
      "Set dry_run=true to validate without creating issues.",
    parameters: IssueGraphParams,
    prepareArguments: (args) =>
      normalizeIssueGraphArguments(args, ctx.recorder) as Static<typeof IssueGraphParams>,
    async execute(_id, params: Static<typeof IssueGraphParams>) {
      try {
        return await run({
          action: "graph",
          graph: { epic: params.epic, features: params.features, tasks: params.tasks },
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
        let deliverableTasks = 0;
        let readyTasks = 0;
        let contextMissing = 0;
        const inspect = (issue: Issue): void => {
          if (!isReserved(issue) && issueContextErrors({ kind: issue.kind, body: issue.body }).length > 0) {
            contextMissing += 1;
          }
          if (issue.kind !== "task" || isReserved(issue)) return;
          deliverableTasks += 1;
          if (issue.plan?.status === "ready") readyTasks += 1;
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
        const graphNote = deliverableTasks === 0
          ? ""
          : deliverableTasks === readyTasks
            ? `Graph complete: all ${deliverableTasks} deliverable Tasks are plan ready. Create a named Epic/Feature/Task only when the request asks; else stop with issue numbers.`
            : `Graph incomplete: ${deliverableTasks - readyTasks} of ${deliverableTasks} deliverable Tasks are not plan ready.`;
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
            "graph action requires graph. Send {\"action\":\"graph\",\"graph\":{\"epic\":{...},\"features\":[...],\"tasks\":[...]}}. " +
              "epic/features/tasks are not top-level parameters.",
          );
        }
        const graph = params.graph;
        const dryRun = params.dry_run === true;
        graph.epic.body = withContextFiles(graph.epic.body ?? "", graph.epic.context_files);
        for (const feature of graph.features) {
          feature.body = withContextFiles(feature.body ?? "", feature.context_files);
        }
        for (const task of graph.tasks) {
          task.body = withContextFiles(task.body ?? "", task.context_files);
        }
        const keys = new Set<string>();
        const addKey = (key: string): void => {
          if (!key) throw new IssueError("graph_key_missing", "every graph node needs a key");
          if (keys.has(key)) throw new IssueError("graph_key_duplicate", `duplicate graph key ${key}`);
          keys.add(key);
        };
        addKey(graph.epic.key);
        for (const feature of graph.features) addKey(feature.key);
        for (const task of graph.tasks) addKey(task.key);
        const featureKeys = new Set(graph.features.map((feature) => feature.key));
        for (const task of graph.tasks) {
          if (!featureKeys.has(task.feature)) {
            throw new IssueError("graph_parent_missing", `task ${task.key} references unknown feature ${task.feature}`);
          }
        }
        const bodyErrors: string[] = [];
        const checkBody = (label: string, kind: "epic" | "feature" | "task", body = ""): void => {
          for (const error of issueContextErrors({ kind, body })) bodyErrors.push(`${label} ${error}`);
        };
        checkBody(`epic ${graph.epic.key}`, "epic", graph.epic.body);
        for (const feature of graph.features) checkBody(`feature ${feature.key}`, "feature", feature.body);
        for (const task of graph.tasks) checkBody(`task ${task.key}`, "task", task.body);
        if (bodyErrors.length > 0) {
          return fail(
            `graph issues need body context: ${bodyErrors.join(" | ")}. ` +
              "Add the required sections and retry.",
          );
        }
        const oversized = graph.tasks
          .map((task) => ({
            key: task.key,
            errors: taskSizeErrors({
              acceptance: parseAcceptance(task.body ?? ""),
              body: task.body ?? "",
            }),
          }))
          .filter((task) => task.errors.length > 0);
        if (oversized.length > 0) {
          return fail(
            `graph has oversized Tasks: ${oversized
              .map((task) => `${task.key} (${task.errors.join("; ")})`)
              .join(" | ")}. Split each into smaller Tasks and retry.`,
          );
        }
        if (dryRun) {
          return ok(
            `graph valid: epic ${graph.epic.key}; features ${graph.features.length}; tasks ${graph.tasks.length}; no issues created`,
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
        const epicReserved = await ensureEpicReserved(ctx.provider, epic.ref, { runCounts: counts() });
        remember(epicReserved.feature0);
        remember(epicReserved.task0);
        linkPlanningRun(epicReserved.task0);
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
          const task0 = await ensureFeatureReserved(ctx.provider, created.ref, { runCounts: counts() });
          remember(task0);
          linkPlanningRun(task0);
        }
        for (const task of graph.tasks) {
          const parent = createdNodes.get(task.feature);
          if (!parent || parent.kind !== "feature") {
            throw new IssueError("graph_parent_missing", `feature ${task.feature} was not created`);
          }
          const created = await ctx.provider.create({
            title: task.title,
            body: withApproval(task.body ?? "", ctx.defaultApproval),
            kind: "task",
            parent: parent.ref,
          });
          createdNodes.set(task.key, created);
          remember(created);
          ctx.recorder.event("issue_created", {
            number: created.ref.number,
            kind: created.kind,
            title: created.title,
            parent: parent.ref.number,
          });
          const auto = await autoPlan(created);
          if (auto.issue) remember(auto.issue, "plan ready");
          else notReady.push(`${task.key}: ${auto.error ?? "missing acceptance criteria"}`);
        }
        for (const feature of graph.features) {
          const target = createdNodes.get(feature.key)!;
          const blockedBy = resolveDependencies(feature.blocked_by);
          if (blockedBy) {
            const updated = await ctx.provider.update(target.ref, { blockedBy });
            remember(updated);
          }
        }
        for (const task of graph.tasks) {
          const target = createdNodes.get(task.key)!;
          const blockedBy = resolveDependencies(task.blocked_by);
          if (blockedBy) {
            const updated = await ctx.provider.update(target.ref, { blockedBy });
            remember(updated);
          }
        }
        treeCache.clear();
        const summary = [
          `epic #${epic.ref.number}`,
          `features ${graph.features.map((feature) => `${feature.key}=#${createdNodes.get(feature.key)!.ref.number}`).join(", ") || "none"}`,
          `tasks ${graph.tasks.map((task) => `${task.key}=#${createdNodes.get(task.key)!.ref.number}`).join(", ") || "none"}`,
        ].join("; ");
        return ok(
          `created graph: ${summary}` +
            (notReady.length > 0 ? `\nnot plan-ready: ${notReady.join("; ")}` : ""),
        );
      }
      case "create": {
        requireCreate();
        treeCache.clear();
        if (!params.kind) return fail("create requires kind (epic|feature|task)");
        if (!params.title) return fail("create requires title");
        const body = withContextFiles(
          withApproval(params.body ?? "", ctx.defaultApproval),
          params.context_files,
        );
        const contextErrors = issueContextErrors({ kind: params.kind, body });
        if (contextErrors.length > 0) {
          return fail(
            `${params.kind} body needs context: ${contextErrors.join("; ")}. ` +
              "Add the required sections and retry.",
          );
        }
        const parent = params.parent ? ref(params.parent, "parent") : undefined;
        let parentFeatureTask0: Issue | undefined;
        let parentEpicTask0: Issue | undefined;
        if (params.kind === "task") {
          if (!parent) return fail("creating a Task requires parent (its Feature)");
          const parentIssue = await ctx.provider.get(parent);
          if (!parentIssue) return fail(`parent not found: ${params.parent}`);
          if (parentIssue.kind !== "feature") return fail(`a Task's parent must be a Feature (got ${parentIssue.kind})`);
          if (isReserved(parentIssue)) {
            return fail(
              `parent #${parentIssue.ref.number} is a reserved planning anchor; ` +
                "create a normal Feature under the Epic and put Tasks there",
            );
          }
          // Repair the parent chain before adding a deliverable.
          if (parentIssue.kind === "feature") {
            parentFeatureTask0 = await ensureFeatureReserved(ctx.provider, parentIssue.ref, { runCounts: counts() });
          }
        }
        if (params.kind === "feature") {
          if (!parent) return fail("creating a Feature requires parent (its Epic)");
          const parentIssue = await ctx.provider.get(parent);
          if (!parentIssue) return fail(`parent not found: ${params.parent}`);
          if (parentIssue.kind !== "epic") return fail(`a Feature's parent must be an Epic (got ${parentIssue.kind})`);
          const reserved = await ensureEpicReserved(ctx.provider, parentIssue.ref, { runCounts: counts() });
          parentEpicTask0 = reserved.task0;
        }
        if (params.kind === "task") {
          const errors = taskSizeErrors({ acceptance: parseAcceptance(body), body });
          if (errors.length > 0) {
            return fail(`Task is too large: ${errors.join("; ")}. Split it into smaller Tasks and retry.`);
          }
        }
        const blockedBy = await dependencies([params.blocked_by, params.depends_on]);
        const created = await ctx.provider.create({
          title: params.title,
          body,
          kind: params.kind,
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
        if (created.kind === "task" && parentFeatureTask0) linkPlanningRun(parentFeatureTask0);
        if (created.kind === "feature" && parentEpicTask0) linkPlanningRun(parentEpicTask0);
        let note = "";
        if (created.kind === "epic") {
          const reserved = await ensureEpicReserved(ctx.provider, created.ref, { runCounts: counts() });
          remember(reserved.feature0);
          remember(reserved.task0);
          linkPlanningRun(reserved.task0);
          note =
            `\nreserved: Feature 0 #${reserved.feature0.ref.number} "Feature 0: Planning & Review", ` +
            `Task 0 #${reserved.task0.ref.number} "Task 0: Planning & Review"` +
            `\nThese are coordination anchors, not deliverables. Do not add work under them.` +
            `\nNext: create Features with action=create kind=feature parent=#${created.ref.number}.`;
        } else if (created.kind === "feature") {
          const task0 = await ensureFeatureReserved(ctx.provider, created.ref, { runCounts: counts() });
          remember(task0);
          note =
            `\nreserved: Task 0 #${task0.ref.number} "Task 0: Planning & Review"` +
            `\nThis is a coordination anchor, not a deliverable. Do not add work under it.` +
            `\nNext: create Tasks with action=create kind=task parent=#${created.ref.number}.`;
        } else if (created.plan) {
          note = `\nplan already ${created.plan.status}.`;
        } else {
          const auto = await autoPlan(created);
          if (auto.issue) {
            remember(auto.issue, "plan ready");
            note =
              `\nplan ready on #${auto.issue.ref.number}. ` +
              "Use context_files for the exact files you chose after reading. " +
              "Then create the next Task or stop.";
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
        return ok(`created #${created.ref.number} (${created.kind}): ${created.title}${note}`);
      }
      case "edit": {
        requirePlan();
        treeCache.clear();
        const target = await ctx.provider.get(ref(params.issue, "issue"));
        if (!target) return fail(`issue not found: ${params.issue}`);
        if (target.reserved && params.title != null) {
          return fail("reserved issues cannot be retitled (their identity is the reserved role)");
        }
        const nextBody = target.reserved
          ? (params.body ?? undefined)
          : params.body == null
            ? (params.context_files && params.context_files.length > 0
                ? withContextFiles(target.body ?? "", params.context_files)
                : undefined)
            : withContextFiles(params.body, params.context_files);
        if (!target.reserved && nextBody !== undefined) {
          const contextErrors = issueContextErrors({ kind: target.kind, body: nextBody });
          if (contextErrors.length > 0) {
            return fail(
              `${target.kind} body needs context: ${contextErrors.join("; ")}. ` +
                "Add the required sections and retry.",
            );
          }
        }
        if (target.kind === "task" && nextBody !== undefined) {
          const errors = taskSizeErrors({ acceptance: parseAcceptance(nextBody), body: nextBody });
          if (errors.length > 0) {
            return fail(`Task is too large: ${errors.join("; ")}. Split it into smaller Tasks and retry.`);
          }
        }
        const blockedBy = await dependencies([params.blocked_by, params.depends_on], target.ref);
        const updated = await ctx.provider.update(target.ref, {
          ...(params.title != null ? { title: params.title } : {}),
          ...(nextBody !== undefined ? { body: nextBody } : {}),
          ...(params.labels != null ? { labels: params.labels } : {}),
          ...(blockedBy ? { blockedBy } : {}),
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
        if (target.kind !== "task") return fail("mc:plan applies to Task issues only");
        if (target.reserved) return fail("reserved anchors cannot carry a deliverable plan");
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
        const cascaded = await cascadeReserved(ctx.provider, target, "close");
        ctx.recorder.event("issue_closed", {
          issue: target.ref.number,
          by: ctx.recorder.id,
          reason: params.reason,
          cascaded,
        });
        return ok(`closed #${target.ref.number}${cascaded.length ? ` (reserved: ${cascaded.map((n) => `#${n}`).join(", ")})` : ""}`);
      }
      case "link": {
        requirePlan();
        treeCache.clear();
        const child = await ctx.provider.get(ref(params.issue, "issue"));
        if (!child) return fail(`issue not found: ${params.issue}`);
        if (!params.parent) return fail("link requires parent");
        const parent = await ctx.provider.get(ref(params.parent, "parent"));
        if (!parent) return fail(`parent not found: ${params.parent}`);
        if (!(child.kind === "feature" && parent.kind === "epic") && !(child.kind === "task" && parent.kind === "feature")) {
          return fail(`invalid hierarchy: ${child.kind} cannot be a child of ${parent.kind} (Feature→Epic, Task→Feature)`);
        }
        if (child.kind === "task") await ensureFeatureReserved(ctx.provider, parent.ref, { runCounts: counts() });
        if (child.kind === "feature") await ensureEpicReserved(ctx.provider, parent.ref, { runCounts: counts() });
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
          const reserved = await ensureEpicReserved(ctx.provider, target.ref, { runCounts: counts() });
          remember(target);
          remember(reserved.feature0);
          remember(reserved.task0);
          return ok(
            `epic #${target.ref.number}: Feature 0 #${reserved.feature0.ref.number}, Task 0 #${reserved.task0.ref.number}`,
          );
        }
        if (target.kind === "feature") {
          const task0 = await ensureFeatureReserved(ctx.provider, target.ref, { runCounts: counts() });
          remember(target);
          remember(task0);
          return ok(`feature #${target.ref.number}: Task 0 #${task0.ref.number}`);
        }
        if (target.parent) {
          const parent = await ctx.provider.get(target.parent);
          if (parent?.kind === "feature") {
            const task0 = await ensureFeatureReserved(ctx.provider, parent.ref, { runCounts: counts() });
            remember(target);
            remember(task0);
            return ok(`task #${target.ref.number}: parent Task 0 #${task0.ref.number}`);
          }
        }
        return ok(`task #${target.ref.number}: no reserved hierarchy to ensure`);
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

/**
 * Run counts for reserved-duplicate decisions. The issue tool only knows its
 * own run, so callers pass a provider-backed count when available.
 */
function requireRuns(recorder: RunRecorder): Array<{ issue?: IssueRef }> {
  return [{ issue: recorder.current.issue }];
}

export { isReservedTask };
