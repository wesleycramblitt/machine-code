/**
 * machine_code — issues CLI (create, move, list, build, batch, approve, delete).
 *
 * The issue file is the contract: its prompt is the objective and its
 * `verify` list is the gate set. There are no packet files.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { layout } from "../paths.js";
import { loadEnvFiles } from "../env.js";
import { RunRecorder, listRuns, reconcileRun, registerProject } from "../state/runs.js";
import { createWorktree, reusableWorktreeOwner, refreshReusedWorktree, WorktreeError } from "../worktree.js";
import { loadAvailability } from "../availability.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import { runLoop, type RunLoopResult } from "../loop.js";
import { resolveAgent } from "../agents/config.js";
import { resolveGates, withSyncGate } from "../verify.js";
import { allCommands } from "../commands/registry.js";
import { slugify } from "../plan/slug.js";
import {
  findIssue,
  listIssues,
  writeIssue,
  moveIssue,
  parseKind,
  legalStatus,
  kindTag,
  statusTag,
  ISSUE_KIND_LABELS,
  ISSUE_KINDS,
  ISSUE_STATUS_LABELS,
  statusesForKind,
  type Issue,
  type IssueStatus,
} from "../plan/issues.js";
import { approveIssue, deleteIssue, issueToTaskPacket, unmetDepends, unknownDepends, activeFileConflicts } from "../tasks/issue.js";
import { abortMergeIfInProgress, ensureCommitted, mergeBranchIntoMain } from "../tasks/merge.js";
import { runItemId } from "../plan/lifecycle.js";
import { commitPlanningFiles } from "../tasks/planning.js";
import { fail, parseFlags, loadRuntime, EXIT } from "./common.js";

const ACTIVE_RUN_STATUSES = new Set(["created", "running", "awaiting_input"]);

/** One mutating issue operation at a time: merge/delete/build must not race a live run. */
function activeIssueRuns(l: ReturnType<typeof layout>, slug: string) {
  return listRuns(l)
    .filter((run) => runItemId(run) === slug && ACTIVE_RUN_STATUSES.has(run.status))
    .filter((run) => ACTIVE_RUN_STATUSES.has(reconcileRun(run).status));
}

function assertNoActiveRun(l: ReturnType<typeof layout>, slug: string, action: string, force = false): void {
  const active = activeIssueRuns(l, slug);
  if (active.length > 0 && !force) {
    fail(
      `${slug} has an active run (${active.map((run) => run.id.slice(-8)).join(", ")}); ` +
        `finish or pause it before ${action}`,
    );
  }
}

export async function cmdApprove(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) fail("usage: machine_code approve <slug>");
  const l = layout();
  const slug = slugify(target);
  const issue = findIssue(l, slug);
  if (!issue) fail(`no issue ${slug}`);
  if (issue.kind === "ideas") fail(`ideas are researched, not approved: ${slug}`);
  if (issue.status !== "needs-human-review" && issue.status !== "done") {
    fail(`${slug} is ${issue.status}; build it before approving`);
  }
  assertNoActiveRun(l, slug, "approve");
  if (issue.review === "human") {
    process.stderr.write(`note: ${slug} has review = human (never auto-merged by batch)\n`);
  }
  await approveIssue(l, slug);
  process.stdout.write(`approved and merged ${slug}\n`);
  return 0;
}

export function cmdPlan(argv: string[]): number {
  const { flags } = parseFlags(argv);
  const l = layout();
  const issues = listIssues(l);
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
    return 0;
  }
  const lines: string[] = ["# Issues"];
  for (const kind of ISSUE_KINDS) {
    lines.push("", `## ${ISSUE_KIND_LABELS[kind]}`);
    for (const status of statusesForKind(kind)) {
      const group = issues.filter((issue) => issue.kind === kind && issue.status === status);
      if (group.length === 0) continue;
      lines.push(`### ${ISSUE_STATUS_LABELS[status]}`);
      for (const issue of group) lines.push(`- [ ] ${issue.slug} - ${issue.title}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/* -------------------------------------------------------------- issue */

/** Inspect and edit issue files: list, create, move, show, run. */
export async function cmdIssue(argv: string[]): Promise<number> {
  // `--status` is a boolean switch on other commands (show/runs). Issue create
  // needs it as a value, so rename it before the shared parser sees it.
  const creating = argv[0] === "create" || argv[0] === "new";
  const normalized = creating
    ? argv.flatMap((arg) => (arg === "--status" ? ["--issue-status"] : [arg]))
    : argv;
  const { flags, positional } = parseFlags(normalized);
  const l = layout();
  const sub = positional[0];

  if (sub === "create" || sub === "new") {
    const kindArg = positional[1];
    const slugArg = positional[2];
    if (!kindArg || !slugArg) fail('usage: machine_code issue create <ideas|features|bugs> <slug> "<prompt>" [--priority low|medium|high] [--review none|human] [--verification direct|verified] [--depends a,b] [--files path,glob] [--tags a,b] [--acceptance a,b] [--status <dir>]');
    const kind = parseKind(kindArg);
    if (!kind) fail(`unknown kind ${JSON.stringify(kindArg)}; use ideas|features|bugs`);
    const slug = slugify(slugArg);
    if (!slug) fail("issue slug becomes empty");
    if (findIssue(l, slug)) fail(`issue ${slug} already exists`);
    const statusFlag = flags.get("issue-status");
    if (statusFlag && !legalStatus(kind, statusFlag)) fail(`invalid status ${JSON.stringify(statusFlag)} for ${kind}`);
    const reviewFlag = flags.get("review") ?? "none";
    if (!["none", "human"].includes(reviewFlag)) fail("--review must be none|human");
    const verificationFlag = flags.get("verification") ?? "direct";
    if (!["direct", "verified"].includes(verificationFlag)) fail("--verification must be direct|verified");
    const issue = writeIssue(l, {
      kind,
      slug,
      prompt: positional.slice(3).join(" ").trim() || slug,
      verification: verificationFlag as "direct" | "verified",
      ...(statusFlag ? { status: statusFlag as IssueStatus } : {}),
      ...(flags.get("priority") ? { priority: flags.get("priority") } : {}),
      ...(flags.get("depends") ? { depends: flags.get("depends")!.split(",").map((e) => e.trim()).filter(Boolean).map((e) => slugify(e)) } : {}),
      ...(flags.get("files") ? { files: flags.get("files")!.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      ...(flags.get("tags") ? { tags: flags.get("tags")!.split(",").map((e) => e.trim()) } : {}),
      ...(flags.get("acceptance") ? { acceptance: flags.get("acceptance")!.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      ...(flags.get("verify") ? { verify: flags.get("verify")!.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      review: reviewFlag as "none" | "human",
    });
    await commitPlanningFiles(l, `[NEW ${kindTag(kind)}] ${slug}`);
    process.stdout.write(`created ${issue.rel}\n`);
    return 0;
  }

  if (sub === "move") {
    const slug = positional[1];
    const to = positional[2];
    if (!slug || !to) fail("usage: machine_code issue move <slug> <status>");
    const cleaned = slugify(slug);
    const issue = findIssue(l, cleaned);
    if (!issue) fail(`no issue ${cleaned}`);
    if (!legalStatus(issue.kind, to)) fail(`invalid status ${JSON.stringify(to)} for ${issue.kind}`);
    const moved = moveIssue(l, cleaned, to as IssueStatus);
    const status = to as IssueStatus;
    await commitPlanningFiles(l, `[${kindTag(issue.kind)} ${statusTag(status)}] ${cleaned}`);
    process.stdout.write(`moved ${cleaned} → ${moved?.rel ?? ""}\n`);
    return 0;
  }

  if (sub === "reject") {
    const slug = positional[1];
    if (!slug) fail("usage: machine_code issue reject <slug>");
    const cleaned = slugify(slug);
    const issue = findIssue(l, cleaned);
    if (!issue) fail(`no issue ${cleaned}`);
    if (issue.kind === "ideas") fail("ideas are researched, not reviewed");
    if (issue.status !== "needs-human-review") {
      fail(`issue ${cleaned} is ${issue.status}; reject requires needs-human-review`);
    }
    moveIssue(l, cleaned, "failed-human-review");
    await commitPlanningFiles(l, `[${kindTag(issue.kind)} FAILED HUMAN REVIEW] ${cleaned}`);
    process.stdout.write(`rejected ${cleaned} → failed-human-review\n`);
    return 0;
  }

  if (sub === "run") {
    const slug = positional[1];
    if (!slug) fail("usage: machine_code issue run <slug> [--agent research|engineer]");
    const cleaned = slugify(slug);
    const issue = findIssue(l, cleaned);
    if (!issue) fail(`no issue ${cleaned}`);
    const explicitAgent = flags.get("agent");
    // The default run for a feature/bug is the full build: gates, optional
    // review, commit, and status move. Ideas default to research.
    if (explicitAgent === undefined && issue.kind !== "ideas") {
      const args = [cleaned];
      const model = flags.get("model");
      if (model) args.push("--model", model);
      if (flags.has("no-review")) args.push("--no-review");
      return cmdBuild(args);
    }
    const agent = explicitAgent ?? (issue.kind === "ideas" ? "research" : "engineer");
    const args = ["run", "--agent", agent, "--item", cleaned];
    const model = flags.get("model");
    if (model) args.push("--model", model);
    args.push(issue.prompt);
    const child = spawn(process.execPath, [process.argv[1]!, ...args], { stdio: "inherit" });
    const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    return code;
  }

  if (sub === "list" || sub === "ls" || sub === undefined) {
    const issues = listIssues(l);
    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
      return 0;
    }
    if (issues.length === 0) {
      process.stdout.write('no issues (use `machine_code issue create ideas|features|bugs <slug> "<prompt>"`)\n');
      return 0;
    }
    for (const issue of issues) {
      process.stdout.write(`${issue.rel}\n  ${issue.title}\n`);
    }
    return 0;
  }

  const showSlug = sub === "show" || sub === "get" ? positional[1] : sub;
  const issue = findIssue(l, slugify(showSlug ?? ""));
  if (!issue) fail(`no issue ${showSlug ?? "(none)"} (run \`machine_code issue list\`)`);
  process.stdout.write(
    `${issue.rel}\npriority ${issue.priority} · review ${issue.review}` +
      `${issue.verify.length ? ` · verify ${issue.verify.join(", ")}` : ""}\n\n${issue.prompt}\n`,
  );
  return 0;
}

/* ------------------------------------------------------------------ build */

/** Shared bounded build: issue → worktree → engineer → gates → review → commit. */
export async function runIssueBuild(
  l: ReturnType<typeof layout>,
  issue: Issue,
  flags: Map<string, string>,
): Promise<number> {
  const slug = issue.slug;
  const unmet = unmetDepends(l, issue);
  if (unmet.length > 0) {
    process.stderr.write(`machine_code: issue ${slug} depends on ${unmet.join(", ")} — build ${unmet.join(", ")} first\n`);
    return EXIT["blocked"];
  }
  const unknown = unknownDepends(l, issue);
  if (unknown.length > 0) {
    process.stderr.write(`machine_code: ignoring unknown depends for ${slug}: ${unknown.join(", ")} (fix or remove them in the issue header)\n`);
  }
  const overlaps = activeFileConflicts(l, issue);
  if (overlaps.length > 0) {
    process.stderr.write(
      `machine_code: issue ${slug} shares files with active work — ` +
        overlaps.map((c) => `${c.slug} (run ${c.runId.slice(-8)}: ${c.files.join(", ")})`).join("; ") +
        `; wait for it to finish or add depends: ${overlaps.map((c) => c.slug).join(", ")}\n`,
    );
    return EXIT["blocked"];
  }
  assertNoActiveRun(l, slug, "build");
  const goal = issue.prompt.trim() || issue.title || slug;
  const packet = issueToTaskPacket(issue);
  const runtime = await loadRuntime(l);
  const recorder = new RunRecorder(l, {
    agent: "engineer",
    mode: "",
    request: goal,
    repoRoot: l.repoRoot,
    itemId: slug,
  });
  registerProject(l.home, l.repoRoot);
  recorder.event("issue_build_start", { slug });

  const abort = new AbortController();
  let sigints = 0;
  process.on("SIGINT", () => {
    sigints += 1;
    if (sigints === 1) {
      abort.abort();
    } else {
      recorder.finalize("interrupted");
      process.exit(130);
    }
  });
  process.on("SIGTERM", () => abort.abort());

  let toolRoot = l.repoRoot;
  try {
    // Sync main first so the branch starts from (or merges) current upstream.
    try {
      const { fastForwardMain } = await import("../tasks/sync.js");
      const synced = await fastForwardMain(l.repoRoot);
      if (!synced.ok) process.stderr.write(`machine_code: main sync: ${synced.detail}\n`);
    } catch {
      // Remote unreachable — local main is good enough.
    }
    const reuse = reusableWorktreeOwner(listRuns(l), issue.branch, "engineer");
    if (reuse) {
      toolRoot = reuse.path;
      const refresh = await refreshReusedWorktree(reuse.path);
      recorder.patchSummary({
        worktree: reuse.path,
        worktreeOwnerRunId: reuse.run.id,
        branch: reuse.run.branch,
        baseBranch: reuse.run.baseBranch,
        baseRef: reuse.run.baseRef,
      });
      recorder.event("worktree_reused", { parentRunId: reuse.run.id, path: reuse.path, branch: reuse.run.branch, refresh });
      process.stderr.write(
        `worktree ${reuse.path} (reused from ${reuse.run.id}, branch ${reuse.run.branch}` +
          `${refresh === "updated" ? ", merged main" : refresh === "conflict" ? ", main merge conflicted (state preserved)" : ""})\n`,
      );
    } else {
      const supervisor = new ProcessSupervisor({
        runId: recorder.id,
        runDir: recorder.dir,
        onEvent: (type, data) => recorder.event(type, data),
      });
      const spec = await createWorktree({ layout: l, runId: recorder.id, kind: "issue", slug, branch: issue.branch, processes: supervisor });
      toolRoot = spec.path;
      recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
      recorder.event("worktree_created", { path: spec.path, branch: spec.branch, baseRef: spec.baseRef, baseBranch: spec.baseBranch });
    }
  } catch (error) {
    if (error instanceof WorktreeError) {
      recorder.finalize("blocked", `${error.code}: ${error.message}`);
      moveIssue(l, slug, "blocked");
      await commitPlanningFiles(l, `[${kindTag(issue.kind)} BLOCKED] ${slug}`);
      return EXIT["blocked"];
    }
    throw error;
  }

  // Resolve the engineer agent and gates, then run the loop directly.
  const modelCommands = allCommands(l);
  const gateCommands = allCommands(l, { scriptsRoot: toolRoot });
  const gates = withSyncGate(resolveGates(packet, gateCommands), recorder.current.baseBranch);
  const resolved = resolveAgent(l, "engineer", {
    machineOverrides: runtime.machine.agents.engineer,
    runOverrides: {},
  });
  recorder.recordConfig({ ...resolved.config, capabilities: resolved.capabilities });
  const buildRequest =
    `Implement this issue exactly:\n\n${JSON.stringify(packet, null, 2)}\n\n` +
    "Acceptance commands must pass. If the issue is wrong or a gate cannot run, report blocked with evidence.";

  let result = await runLoop({
    models: runtime.models,
    catalogue: runtime.catalogue.models,
    configuredProviders: runtime.configuredProviders,
    agent: resolved.def,
    agentConfig: resolved.config,
    agentCapabilities: resolved.capabilities,
    layout: l,
    machine: runtime.machine,
    request: buildRequest,
    root: l.repoRoot,
    toolRoot,
    home: l.home,
    availability: loadAvailability(l.home),
    recorder,
    commands: modelCommands,
    ...(flags.get("model") ? { requireModel: flags.get("model") } : {}),
    signal: abort.signal,
    gates,
    ...(packet.context.length > 0 ? { seedFiles: packet.context } : {}),
  });

  // Gates passed: commit the worktree, then merge only after every gate. A
  // human-review issue stops at needs-human-review; approval performs the
  // same final merge later.
  if (result.status === "completed") {
    const branch = recorder.current.branch;
    if (!branch) {
      result = { ...result, status: "blocked", error: "run completed without a branch to merge" };
    } else {
      let commit: string | null = null;
      try {
        commit = await ensureCommitted(
          toolRoot,
          recorder.current.baseRef,
          `mc(${slug}): ${goal}\n\nrun: ${recorder.id}\nissue: ${slug}`,
        );
      } catch (error) {
        result = {
          ...result,
          status: "blocked",
          error: `commit failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!commit && result.status === "completed") {
        result = { ...result, status: "blocked", error: "engineer produced no committable change" };
      } else if (commit) {
        recorder.patchSummary({ commit });
        recorder.event("commit_created", { sha: commit, branch, issue: slug });
        const { pushFeatureBranch } = await import("../tasks/sync.js");
        const pushed = await pushFeatureBranch(toolRoot, branch);
        recorder.event("branch_pushed", { branch, pushed });
        if (issue.review === "human") {
          moveIssue(l, slug, "needs-human-review");
        } else {
          const merged = await mergeBranchIntoMain(l.repoRoot, toolRoot, branch);
          if (merged.ok) {
            recorder.event("branch_merged", { branch, mergeCommit: merged.mergeCommit });
            const { updateIssueMeta } = await import("../plan/issues.js");
            if (merged.mergeCommit) updateIssueMeta(l, slug, { commit: merged.mergeCommit });
            moveIssue(l, slug, "done");
          } else {
            moveIssue(l, slug, "blocked");
            result = {
              ...result,
              status: "blocked",
              error: `merge failed: ${branch} into main${merged.detail ? ` (${merged.detail})` : ""}`,
            };
          }
        }
      }
    }
  }
  if (result.status !== "completed") await abortMergeIfInProgress(toolRoot);
  if (result.status === "blocked" || result.status === "failed") {
    if (result.lastGateFailure) {
      moveIssue(l, slug, "failed-gates");
    } else {
      moveIssue(l, slug, "blocked");
    }
  }
  await commitPlanningFiles(l, `[${kindTag(issue.kind)} BUILD] ${slug} (${result.status})`);
  recorder.finalize(result.status, result.error, result.finalText);
  process.stdout.write(`build ${slug}: ${result.status}${result.error ? ` — ${result.error}` : ""}\n`);
  if (result.status === "completed") {
    process.stdout.write(`  next: ${slug} is done\n`);
  }
  return EXIT[result.status];
}

/**
 * Build an issue (`build <slug>`), or self-scope a free-form goal into a
 * feature issue and build it (`build "<goal>"`).
 */
export async function cmdBuild(argv: string[]): Promise<number> {
  // `--review` is a bare switch here; `issue create --review agent` keeps its
  // value form in its own command.
  const normalized = argv.flatMap((arg) => (arg === "--review" ? ["--with-review"] : [arg]));
  const { flags, positional } = parseFlags(normalized);
  const joined = positional.join(" ").trim();
  if (!joined) {
    fail('usage:\n  machine_code build <slug> [--review] [--model <key>]\n  machine_code build "<goal>"   (self-scopes a feature issue)');
  }
  const l = layout();

  if (positional.length === 1 && !positional[0]!.includes(" ")) {
    const slug = slugify(positional[0]!);
    const issue = findIssue(l, slug);
    if (!issue) fail(`no issue ${slug} — create one with \`machine_code issue create features|bugs ${slug} "..."\``);
    if (issue.kind === "ideas") fail(`ideas are researched first: machine_code issue run ${slug}`);
    if (issue.status === "done") fail(`issue ${slug} is already done`);
    return runIssueBuild(l, issue, flags);
  }

  const slug = slugify(joined).slice(0, 40) || "task";
  let issue = findIssue(l, slug);
  if (!issue) {
    issue = writeIssue(l, { kind: "features", slug, prompt: joined });
    await commitPlanningFiles(l, `[NEW FEATURE] ${slug}`);
    process.stderr.write(`self-scoped as ${slug} → issues/features/todo/${slug}.md\n`);
  } else {
    if (issue.kind === "ideas") fail(`ideas are researched first: machine_code issue run ${slug}`);
    if (issue.status === "done") fail(`issue ${slug} is already done`);
  }
  return runIssueBuild(l, issue, flags);
}

/* ---------------------------------------------------------------- future */

/**
 * TODO: Replace with a repo-level issue runner that processes all available
 * issues with consistent settings (agent, model, tier, etc.) and handles
 * approvals automatically where appropriate.
 */

/* ----------------------------------------------------------------- delete */

/** Delete an issue and its branch. */
export async function cmdDelete(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const slugArg = positional[0];
  if (!slugArg) fail("usage: machine_code delete <slug> [--force]");
  const l = layout();
  const slug = slugify(slugArg);
  if (!findIssue(l, slug)) fail(`no issue ${slug}`);
  const force = flags.has("force");
  assertNoActiveRun(l, slug, "delete", force);
  await deleteIssue(l, slug, { force });
  process.stdout.write(`deleted ${slug}\n`);
  return 0;
}
