/**
 * machine_code — resolve a selected issue into the Feature a run can attach to.
 *
 * Runs attach to Features (build/review) or Epics (planner). A human can
 * still select an Epic in the TUI/new-run composer; with `autoCreate`, the
 * harness fills the missing level (Epic → Feature) using the run objective as
 * the title. Exact-title open children are reused so a retry does not create a
 * duplicate feature every time.
 */
import {
  IssueError,
  type Issue,
  type IssueProvider,
  type IssueRef,
  type NewIssue,
} from "./provider.js";
/**
 * Validate a run's primary issue association: it must be a Feature, or an
 * Epic when `allowEpic` is set (planner runs attach to Epics).
 */
export async function validateRunIssue(
  provider: IssueProvider,
  ref: IssueRef,
  opts: { allowEpic?: boolean } = {},
): Promise<Issue> {
  const issue = await provider.get(ref);
  if (!issue) throw new IssueError("issue_not_found", `issue ${ref.repo}#${ref.number} not found`);
  if ((issue.kind as string) === "task") {
    throw new IssueError(
      "issue_not_task",
      `runs attach to Features or Epics only (${ref.repo}#${ref.number} is a task, which no longer exists as a kind)`,
    );
  }
  if (issue.kind === "epic" && !opts.allowEpic) {
    throw new IssueError(
      "issue_not_feature",
      `runs attach to Features (${ref.repo}#${ref.number} is an epic); planner runs may pass allowEpic`,
    );
  }
  return issue;
}

export interface ResolveRunTargetInput {
  provider: IssueProvider;
  ref: IssueRef;
  request: string;
  agent?: string;
  /** Fill an Epic gap with a new Feature. */
  autoCreate?: boolean;
}

export interface ResolveRunTargetResult {
  issue: Issue;
  created: Issue[];
  /** The issue the human selected, before resolving it to the run target. */
  scope?: Issue;
}

export function objectiveTitle(request: string, fallback = "machine_code feature"): string {
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
 * The default run objective for a feature-attached run. A human can start a run
 * from a Feature without typing a prompt; the issue title and Scope become
 * the request, so the run state names the actual work.
 */
export function issueRunRequest(issue: Issue, verb: IssueRequestVerb = "Implement"): string {
  const ref = `${issue.ref.repo}#${issue.ref.number}`;
  const title = issue.title.trim() || `Feature ${ref}`;
  const deliverable = bodySection(issue.body, "Deliverable");
  const scope = bodySection(issue.body, "Scope")
    || bodySection(issue.body, "Goal")
    || firstParagraph(issue.body);
  // Features are defined by their Deliverable; epics by Scope/Goal.
  const focus = issue.kind === "feature"
    ? deliverable || scope
    : scope || deliverable;
  const lines = [`${verb} ${ref}: ${title}`];
  if (focus) lines.push("", `Scope: ${focus.replace(/\s+/g, " ").slice(0, 800)}`);
  if (issue.acceptance.length > 0) {
    lines.push("", "Acceptance:");
    for (const item of issue.acceptance.slice(0, 6)) lines.push(`- ${item}`);
  }
  return lines.join("\n").slice(0, 2_000);
}

function objectiveBody(request: string): string {
  return [
    '<!-- mc:auto {"createdBy":"machine_code","auto":true} -->',
    "",
    "## Objective",
    "",
    request.trim().slice(0, 8 * 1024),
    "",
    "## Notes",
    "",
    "This Feature was created by machine_code because the selected issue was an Epic.",
    "Inherited context comes from the parent hierarchy; use `mc:context` on the parent to add files, tools, or scripts.",
    "",
    '<!-- mc:approval {"mode":"human","reason":"auto-created feature"} -->',
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
  kind: "feature",
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

export async function resolveRunTarget(input: ResolveRunTargetInput): Promise<ResolveRunTargetResult> {
  const { provider, ref, request, autoCreate } = input;
  const issue = await provider.get(ref);
  if (!issue) throw new IssueError("issue_not_found", `issue ${ref.repo}#${ref.number} not found`);

  // Planner runs attach to Epics; every other agent attaches to Features.
  if (input.agent === "planner") {
    if (issue.kind === "epic") return { issue, created: [], scope: issue };
    if (issue.kind === "feature" && issue.parent) {
      const parent = await provider.get(issue.parent);
      if (parent && parent.kind === "epic") return { issue: parent, created: [], scope: issue };
    }
    throw new IssueError(
      "issue_not_epic",
      `planner runs attach to Epics (${ref.repo}#${ref.number} is a ${issue.kind})`,
    );
  }

  if (!autoCreate) {
    return {
      issue: await validateRunIssue(provider, issue.ref),
      created: [],
      scope: issue,
    };
  }

  const created: Issue[] = [];
  let current = issue;
  if (current.kind === "epic") {
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
  if (current.kind !== "feature") {
    throw new IssueError("issue_not_feature", `could not resolve ${issue.ref.repo}#${issue.ref.number} to a Feature`);
  }
  return { issue: current, created, scope: issue };
}

/** Explicit Feature creation for the TUI/CLI when a human chooses an Epic. */
export async function createFeatureForEpic(
  provider: IssueProvider,
  epic: Issue,
  request: string,
): Promise<Issue> {
  return (await createChild(provider, epic, "feature", objectiveTitle(request), objectiveBody(request))).issue;
}
