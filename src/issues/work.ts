/**
 * machine_code — resolve a selected issue into the Task a run can attach to.
 *
 * Runs attach to Tasks. A human can still select an Epic or Feature in the
 * TUI/new-run composer; with `autoCreate`, the harness fills the missing
 * levels (Epic → Feature → Task, or Feature → Task) using the run objective as
 * the title. Exact-title open children are reused so a retry does not create a
 * duplicate task every time.
 */
import {
  IssueError,
  type Issue,
  type IssueProvider,
  type IssueRef,
  type NewIssue,
} from "./provider.js";
import {
  ensureEpicReserved,
  ensureFeatureReserved,
  isReserved,
  isReservedTask,
  resolvePlanningAnchor,
  validateRunIssue,
  type ReservedOptions,
} from "./reserved.js";

export interface ResolveRunTargetInput {
  provider: IssueProvider;
  ref: IssueRef;
  request: string;
  agent?: string;
  /** Fill Epic/Feature gaps with a new Feature/Task. */
  autoCreate?: boolean;
  reserved?: ReservedOptions;
}

export interface ResolveRunTargetResult {
  issue: Issue;
  created: Issue[];
}

export function objectiveTitle(request: string, fallback = "machine_code task"): string {
  const first = request
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0);
  const title = (first ?? fallback).replace(/\s+/g, " ").trim();
  return title.length > 120 ? `${title.slice(0, 117).trimEnd()}…` : title;
}

/** One `## Heading` section from an issue body, without the heading. */
function bodySection(body: string, heading: string): string {
  const lines = body.split("\n");
  const pattern = new RegExp(`^##\\s+${heading}\\b`, "i");
  const start = lines.findIndex((line) => pattern.test(line.trim()));
  if (start < 0) return "";
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line) || line.trim().startsWith("<!--")) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** First prose paragraph after any leading headings and comments. */
function firstParagraph(body: string): string {
  const out: string[] = [];
  let started = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    if (!started && (trimmed.startsWith("#") || trimmed.startsWith("<!--"))) continue;
    started = true;
    out.push(trimmed);
  }
  return out.join(" ").trim();
}

/** A placeholder prompt that names no work, e.g. "Build the task." */
export function isGenericTaskRequest(request: string): boolean {
  return /^(?:build|do|run|implement|work on)\s+(?:the\s+)?(?:task|issue)\.?$/i.test(request.trim());
}

export type IssueRequestVerb = "Implement" | "Plan" | "Review" | "Investigate";

export function issueRequestVerb(agent: string): IssueRequestVerb {
  switch (agent) {
    case "planner":
      return "Plan";
    case "review":
      return "Review";
    case "general":
      return "Investigate";
    default:
      return "Implement";
  }
}

/**
 * The default run objective for a task-attached run. A human can start a run
 * from a Task without typing a prompt; the issue title and Deliverable become
 * the request, so the run state names the actual work.
 */
export function issueRunRequest(issue: Issue, verb: IssueRequestVerb = "Implement"): string {
  const ref = `${issue.ref.repo}#${issue.ref.number}`;
  const title = issue.title.trim() || `Task ${ref}`;
  const deliverable = bodySection(issue.body, "Deliverable") || firstParagraph(issue.body);
  const lines = [`${verb} ${ref}: ${title}`];
  if (deliverable) lines.push("", `Deliverable: ${deliverable.replace(/\s+/g, " ").slice(0, 800)}`);
  if (issue.acceptance.length > 0) {
    lines.push("", "Acceptance:");
    for (const item of issue.acceptance.slice(0, 6)) lines.push(`- ${item}`);
  }
  return lines.join("\n").slice(0, 2_000);
}

function objectiveBody(request: string): string {
  return [
    "<!-- mc:task {\"createdBy\":\"machine_code\",\"auto\":true} -->",
    "",
    "## Objective",
    "",
    request.trim().slice(0, 8 * 1024),
    "",
    "## Notes",
    "",
    "This Task was created by machine_code because the selected issue was an Epic or Feature.",
    "Inherited context comes from the parent hierarchy; use `mc:context` on the parent to add files, tools, or scripts.",
    "",
    '<!-- mc:approval {"mode":"human","reason":"auto-created task"} -->',
    "",
  ].join("\n");
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function findReusable(children: readonly Issue[], title: string, kind: Issue["kind"]): Issue | undefined {
  const target = normalizeTitle(title);
  return children.find((child) => child.kind === kind && child.state === "open" && normalizeTitle(child.title) === target);
}

async function createChild(
  provider: IssueProvider,
  parent: Issue,
  kind: "feature" | "task",
  title: string,
  body: string,
): Promise<{ issue: Issue; created: boolean }> {
  const existing = findReusable(await provider.children(parent.ref), title, kind);
  if (existing) return { issue: existing, created: false };
  return {
    issue: await provider.create({ title, body, kind, parent: parent.ref, labels: ["mc:auto"] } satisfies NewIssue),
    created: true,
  };
}

function planningAgent(agent?: string): boolean {
  return agent === "planner" || agent === "review";
}

export async function resolveRunTarget(input: ResolveRunTargetInput): Promise<ResolveRunTargetResult> {
  const { provider, ref, request, autoCreate } = input;
  const issue = await provider.get(ref);
  if (!issue) throw new IssueError("issue_not_found", `issue ${ref.repo}#${ref.number} not found`);

  if (planningAgent(input.agent) || (input.agent === "general" && issue.kind !== "task")) {
    const anchor = await resolvePlanningAnchor(provider, issue.ref, input.reserved);
    const resolved = await provider.get(anchor);
    if (!resolved) throw new IssueError("issue_not_found", `planning anchor ${anchor.repo}#${anchor.number} not found`);
    return { issue: resolved, created: [] };
  }

  // Never auto-create work under a reserved Planning & Review anchor.
  if (autoCreate && isReserved(issue)) {
    throw new IssueError(
      "issue_is_reserved",
      `${ref.repo}#${ref.number} is a reserved Planning & Review anchor; choose a deliverable Task`,
    );
  }

  if (!autoCreate) {
    return { issue: await validateRunIssue(provider, issue.ref, { allowReserved: input.agent === "sudo" }), created: [] };
  }

  const created: Issue[] = [];
  let current = issue;
  if (current.kind === "epic") {
    await ensureEpicReserved(provider, current.ref, input.reserved);
    const feature = await createChild(
      provider,
      current,
      "feature",
      objectiveTitle(request),
      objectiveBody(request),
    );
    if (feature.created) created.push(feature.issue);
    current = feature.issue;
  }
  if (current.kind === "feature") {
    await ensureFeatureReserved(provider, current.ref, input.reserved);
    const task = await createChild(provider, current, "task", objectiveTitle(request), objectiveBody(request));
    if (task.created) created.push(task.issue);
    current = task.issue;
  }
  if (current.kind !== "task") {
    throw new IssueError("issue_not_task", `could not resolve ${issue.ref.repo}#${issue.ref.number} to a Task`);
  }
  if (isReservedTask(current) && input.agent !== "sudo") {
    throw new IssueError(
      "issue_is_reserved_task",
      `${current.ref.repo}#${current.ref.number} is a reserved Task 0; implementation runs need a deliverable Task`,
    );
  }
  return { issue: current, created };
}

/** Explicit Feature creation for the TUI/CLI when a human chooses an Epic. */
export async function createFeatureForEpic(
  provider: IssueProvider,
  epic: Issue,
  request: string,
): Promise<Issue> {
  await ensureEpicReserved(provider, epic.ref);
  return (await createChild(provider, epic, "feature", objectiveTitle(request), objectiveBody(request))).issue;
}

/** Explicit Task creation under a Feature. */
export async function createTaskForFeature(
  provider: IssueProvider,
  feature: Issue,
  request: string,
): Promise<Issue> {
  await ensureFeatureReserved(provider, feature.ref);
  return (await createChild(provider, feature, "task", objectiveTitle(request), objectiveBody(request))).issue;
}
