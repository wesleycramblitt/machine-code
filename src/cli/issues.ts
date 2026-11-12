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
import { executeIssue, type OrchestrateResult } from "../orchestrate.js";
import { slugify } from "../plan/slug.js";
import {
  findIssue,
  listIssues,
  writeIssue,
  moveIssue,
  parseKind,
  legalStatus,
  ISSUE_KIND_LABELS,
  ISSUE_KINDS,
  ISSUE_STATUS_LABELS,
  statusesForKind,
  type Issue,
  type IssueStatus,
} from "../plan/issues.js";
import { approveIssue, deleteIssue, issueToTaskPacket, planIssueWaves } from "../tasks/issue.js";
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
  if (issue.status !== "done") fail(`${slug} is ${issue.status}; build it before approving`);
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
    if (!kindArg || !slugArg) fail('usage: machine_code issue create <ideas|features|bugs> <slug> "<prompt>" [--priority low|medium|high] [--review none|agent|human] [--verification direct|verified] [--depends a,b] [--tags a,b] [--acceptance a,b] [--status <dir>]');
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
      ...(flags.get("depends") ? { depends: flags.get("depends")!.split(",").map((e) => slugify(e)) } : {}),
      ...(flags.get("tags") ? { tags: flags.get("tags")!.split(",").map((e) => e.trim()) } : {}),
      ...(flags.get("acceptance") ? { acceptance: flags.get("acceptance")!.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      ...(flags.get("verify") ? { verify: flags.get("verify")!.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      review: reviewFlag as "none" | "human",
    });
    await commitPlanningFiles(l, `issues: add ${slug}`);
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
    await commitPlanningFiles(l, `issues: ${cleaned} → ${to}`);
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
    await commitPlanningFiles(l, `issues: ${cleaned} failed-human-review`);
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
  assertNoActiveRun(l, slug, "build");
  const goal = issue.prompt.trim() || issue.title || slug;
  const packet = issueToTaskPacket(issue);
  const runtime = await loadRuntime(l);
  const recorder = new RunRecorder(l, {
    agent: "engineer",
    mode: issue.verification,
    request: goal,
    repoRoot: l.repoRoot,
    itemId: slug,
    phase: "engineer",
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
    const reuse = reusableWorktreeOwner(listRuns(l), `mc/${slug}`, "engineer");
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
      const spec = await createWorktree({ layout: l, runId: recorder.id, kind: "issue", slug, processes: supervisor });
      toolRoot = spec.path;
      recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });
      recorder.event("worktree_created", { path: spec.path, branch: spec.branch, baseRef: spec.baseRef, baseBranch: spec.baseBranch });
    }
  } catch (error) {
    if (error instanceof WorktreeError) {
      recorder.finalize("blocked", `${error.code}: ${error.message}`);
      moveIssue(l, slug, "blocked");
      await commitPlanningFiles(l, `issues: ${slug} blocked`);
      return EXIT["blocked"];
    }
    throw error;
  }

  let result: OrchestrateResult;
  try {
    result = await executeIssue({
      models: runtime.models,
      catalogue: runtime.catalogue.models,
      configuredProviders: runtime.configuredProviders,
      availability: loadAvailability(l.home),
      layout: l,
      machine: runtime.machine,
      packet,
      include: { issues: [issue.rel] },
      request: goal,
      root: l.repoRoot,
      toolRoot,
      home: l.home,
      recorder,
      ...(flags.get("model") ? { requireModel: flags.get("model") } : {}),
      signal: abort.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.finalize("failed", message);
    await commitPlanningFiles(l, `issues: build ${slug} (failed)`);
    process.stderr.write(`build ${slug} failed: ${message}\n`);
    return EXIT.failed;
  }
  recorder.finalize(result.status, result.error, result.finalText);
  if (result.status === "completed") {
    moveIssue(l, slug, issue.review === "human" ? "needs-human-review" : "done");
  } else if (result.status === "blocked" || result.status === "failed") {
    if (/acceptance gates failed/i.test(result.error ?? "")) moveIssue(l, slug, "failed-gates");
    else moveIssue(l, slug, "blocked");
  }
  await commitPlanningFiles(l, `issues: build ${slug} (${result.status})`);
  process.stdout.write(`build ${slug}: ${result.status}${result.error ? ` — ${result.error}` : ""}\n`);
  if (result.status === "completed") {
    process.stdout.write(`  commit ${result.commit ?? "(none)"}\n  next: machine_code approve ${slug}\n`);
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
    await commitPlanningFiles(l, `issues: add ${slug}`);
    process.stderr.write(`self-scoped as ${slug} → issues/features/todo/${slug}.md\n`);
  } else {
    if (issue.kind === "ideas") fail(`ideas are researched first: machine_code issue run ${slug}`);
    if (issue.status === "done") fail(`issue ${slug} is already done`);
  }
  return runIssueBuild(l, issue, flags);
}

/* ------------------------------------------------------------------ batch */

/**
 * Build ready issues across isolated worktrees, honoring `depends` and a
 * `--max-parallel` cap. With `--auto-approve` it builds and merges wave by wave.
 */
export async function cmdBatch(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const l = layout();
  const maxParallel = Math.max(1, Number(flags.get("max-parallel") ?? "2") || 2);
  const dryRun = flags.has("dry-run");
  const autoApprove = flags.has("auto-approve");

  const waves = planIssueWaves(l, maxParallel);
  if (waves.length === 0) {
    process.stdout.write("no ready issues\n");
    return 0;
  }
  if (dryRun) {
    for (let i = 0; i < waves.length; i++) process.stdout.write(`wave ${i + 1}: ${waves[i]!.join(", ")}\n`);
    return 0;
  }

  const runBuildChild = (slug: string): Promise<{ slug: string; code: number }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [process.argv[1]!, "build", slug], { stdio: "inherit" });
      child.on("error", () => resolve({ slug, code: 1 }));
      child.on("exit", (code) => resolve({ slug, code: code ?? 1 }));
    });

  if (!autoApprove) {
    const wave = waves[0] ?? [];
    process.stdout.write(`wave 1: ${wave.join(", ")}\n`);
    await Promise.all(wave.map(runBuildChild));
    process.stdout.write(`next: machine_code approve ${wave.join(", ")}  (or re-run with --auto-approve)\n`);
    return 0;
  }

  let guard = 0;
  while (guard++ < 1000) {
    const current = planIssueWaves(l, maxParallel);
    const wave = current[0] ?? [];
    if (wave.length === 0) break;
    process.stdout.write(`wave ${guard}: ${wave.join(", ")}\n`);
    const results = await Promise.all(wave.map(runBuildChild));
    let approveFailed = false;
    let humanPending = false;
    for (const slug of wave) {
      const issue = findIssue(l, slug);
      if (!issue) continue;
      if (issue.review === "human") {
        humanPending = true;
        process.stderr.write(`leaving ${slug} for a human merge (review=human)\n`);
        continue;
      }
      // Only a built issue (done/) is approvable. A failed build or a
      // changes_requested review stays todo/blocked and must not merge.
      if (issue.status !== "done") {
        process.stderr.write(`not approving ${slug}: status ${issue.status}\n`);
        continue;
      }
      try {
        await approveIssue(l, slug);
      } catch (error) {
        approveFailed = true;
        process.stderr.write(`approve ${slug} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    const failed = results.filter((result) => result.code !== 0).map((result) => result.slug);
    if (failed.length > 0) {
      process.stderr.write(`build failed: ${failed.join(", ")}\n`);
      break;
    }
    // A dependent must not build on an unmerged parent.
    if (approveFailed || humanPending) break;
  }
  return 0;
}

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
