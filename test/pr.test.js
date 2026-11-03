/**
 * Phase 5 tests: runner-owned publish (push + Task PR into the Feature branch,
 * approval policy) and the capability-gated pr tool. Uses a temp repo with a
 * bare origin remote and a fake PR provider — no network, no real gh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWorktree, commitWorktree } from "../dist/worktree.js";
import { maybePublish } from "../dist/pr/publish.js";
import { publishFeature } from "../dist/pr/feature.js";
import { prTool } from "../dist/tools/pr.js";
import { RunRecorder } from "../dist/state/runs.js";

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function tempRepoWithOrigin() {
  const root = mkdtempSync(join(tmpdir(), "mc-pr-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(root, ["init", "--bare", "-q", bare]);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.local"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# t\n", "utf8");
  writeFileSync(join(repo, ".gitignore"), ".machine_code/local/\nnode_modules/\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  return { root, repo, bare };
}

function fakeLayout(repo) {
  return {
    home: join(repo, "home"),
    machineConfig: "",
    curation: "",
    catalogueFile: "",
    repoRoot: repo,
    repoDir: join(repo, ".machine_code"),
    localDir: join(repo, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(repo, ".machine_code", "local", "runs"),
  };
}

class FakePrProvider {
  constructor() {
    this.kind = "fake";
    this.created = [];
    this.merged = [];
    this.next = 100;
  }
  async available() { return true; }
  async create(input) {
    const pr = {
      number: this.next++,
      url: `https://example/pr/${this.next}`,
      state: "open",
      isDraft: Boolean(input.draft),
      head: input.head,
      base: input.base,
      title: input.title,
    };
    this.created.push(pr);
    return pr;
  }
  async status(number) { return this.created.find((p) => p.number === number) ?? null; }
  async setMergeable(number, mergeable) { const pr = this.created.find((p) => p.number === number); if (pr) pr.mergeable = mergeable; }
  async merge(number, method) { this.merged.push({ number, method }); }
  async list() { return []; }
}

class FakeIssues {
  constructor(approval) { this.kind = "fake"; this.approval = approval; }
  async get(ref) { return { ref, approval: this.approval, kind: "task", labels: [], children: [], blockedBy: [], blocking: [], acceptance: [], title: "t", body: "", state: "open" }; }
}

const MACHINE = {
  priceCaps: {},
  vetoes: [],
  notify: {},
  git: {},
  agents: {},
  issues: { provider: "github", policy: "optional", cacheTtlSeconds: 30 },
};

async function makeRun(layout, repo, approvalDefault = "human") {
  const recorder = new RunRecorder(layout, { agent: "build", mode: "verified", request: "do work", repoRoot: repo });
  const spec = await createWorktree({
    layout,
    runId: recorder.id,
    kind: "task",
    issueNumber: 31,
    featureNumber: 20,
  });
  recorder.patchSummary({
    worktree: spec.path,
    branch: spec.branch,
    baseBranch: spec.baseBranch,
    baseRef: spec.baseRef,
    issue: { provider: "github", repo: "o/r", number: 31 },
  });
  writeFileSync(join(spec.path, "OUT.txt"), "ok", "utf8");
  const { sha } = await commitWorktree({ path: spec.path, message: "do work" });
  recorder.patchSummary({ commit: sha });
  return { recorder, spec };
}

function events(recorder) {
  return readFileSync(join(recorder.dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

test("maybePublish pushes Task + Feature branches and opens a Task PR", async () => {
  const { root, repo, bare } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    const { recorder } = await makeRun(layout, repo);
    const prs = new FakePrProvider();
    const result = await maybePublish({
      layout,
      machine: MACHINE,
      recorder,
      prs,
      issues: new FakeIssues("human"),
      defaultApproval: "human",
      title: "Task: do work",
    });
    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.pr.base, "mc/feature/20");
    assert.equal(result.pr.head, "mc/task/31");
    // Both branches are on the bare origin.
    const branches = git(bare, ["branch", "--list"]).split("\n").map((s) => s.replace("*", "").trim());
    assert.ok(branches.includes("mc/task/31"));
    assert.ok(branches.includes("mc/feature/20"));
    const ev = events(recorder);
    assert.ok(ev.some((e) => e.type === "pr_opened"));
    assert.ok(ev.some((e) => e.type === "approval_requested" && e.action === "merge"));
    assert.equal(prs.merged.length, 0, "human approval must not merge");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval=agent merges the Task PR after publishing", async () => {
  const { root, repo } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    const { recorder } = await makeRun(layout, repo);
    const prs = new FakePrProvider();
    const result = await maybePublish({
      layout,
      machine: MACHINE,
      recorder,
      prs,
      issues: new FakeIssues("agent"),
      defaultApproval: "human",
    });
    assert.equal(result.status, "merged");
    assert.deepEqual(prs.merged, [{ number: result.pr.number, method: "squash" }]);
    assert.ok(events(recorder).some((e) => e.type === "pr_merged"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent merge surfaces a conflicting PR instead of attempting the merge", async () => {
  const { root, repo } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    git(repo, ["branch", "mc/feature/20", "main"]);
    git(repo, ["branch", "mc/task/31", "main"]);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "mutating", repoRoot: repo });
    recorder.patchSummary({ branch: "mc/task/31", baseBranch: "mc/feature/20" });
    const prs = new FakePrProvider();
    const created = await prs.create({ head: "mc/task/31", base: "mc/feature/20", title: "Task" });
    prs.setMergeable(created.number, false);
    prs.list = async () => [created];
    const result = await maybePublish({ layout, machine: MACHINE, recorder, prs, issues: new FakeIssues("agent"), defaultApproval: "agent" });
    assert.equal(result.status, "failed");
    assert.match(result.error, /merge conflicts/);
    assert.equal(prs.merged.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maybePublish skips run-scoped branches (no Task/Feature pair)", async () => {
  const { root, repo } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    const recorder = new RunRecorder(layout, { agent: "sudo", mode: "", request: "r", repoRoot: repo });
    const spec = await createWorktree({ layout, runId: recorder.id, kind: "run" });
    recorder.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch });
    const prs = new FakePrProvider();
    const result = await maybePublish({ layout, machine: MACHINE, recorder, prs });
    assert.equal(result.status, "skipped");
    assert.equal(prs.created.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- pr tool */

function toolCtx(capabilities, approval, prs) {
  const root = mkdtempSync(join(tmpdir(), "mc-prt-"));
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "r", repoRoot: root });
  return { recorder, root, ctx: { provider: prs, capabilities, recorder, defaultApproval: approval } };
}

test("pr tool gates reads/creates/merges by capability", async () => {
  const prs = new FakePrProvider();
  const a = toolCtx([], "human", prs);
  try {
    const list = await prTool(a.ctx).execute("c1", { action: "list" });
    assert.equal(list.isError, true);
    assert.match(list.content[0].text, /pr:read/);

    const b = toolCtx(["pr:create"], "human", prs);
    const bad = await prTool(b.ctx).execute("c1", { action: "create", head: "mc/task/31", base: "main" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Task PRs never target main/);

    const good = await prTool(b.ctx).execute("c1", { action: "create", head: "mc/task/31", base: "mc/feature/20" });
    assert.equal(good.isError, undefined);
    assert.equal(prs.created.length, 1);

    const noMerge = await prTool(b.ctx).execute("c1", { action: "merge", number: 100 });
    assert.equal(noMerge.isError, true);
    assert.match(noMerge.content[0].text, /pr:merge/);
  } finally {
    rmSync(a.root, { recursive: true, force: true });
  }
});

test("pr merge obeys approval: human requests, agent merges", async () => {
  const prs = new FakePrProvider();
  await prs.create({ head: "mc/task/31", base: "mc/feature/20", title: "t", body: "" });
  const number = prs.created[0].number;

  const human = toolCtx(["pr:read", "pr:merge"], "human", prs);
  try {
    const r = await prTool(human.ctx).execute("c1", { action: "merge", number });
    assert.match(r.content[0].text, /approval requested/);
    assert.equal(prs.merged.length, 0);
  } finally {
    rmSync(human.root, { recursive: true, force: true });
  }

  const agent = toolCtx(["pr:read", "pr:merge"], "agent", prs);
  try {
    const r = await prTool(agent.ctx).execute("c1", { action: "merge", number });
    assert.match(r.content[0].text, /merged/);
    assert.equal(prs.merged.length, 1);
  } finally {
    rmSync(agent.root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------- feature PR */

class FakeIssueGraph {
  constructor(feature, tasks) { this.kind = "fake"; this.feature = feature; this.tasks = tasks; }
  async get(ref) {
    if (ref.number === this.feature.ref.number) return this.feature;
    return this.tasks.find((t) => t.ref.number === ref.number) ?? null;
  }
  async children(ref) { return ref.number === this.feature.ref.number ? this.tasks : []; }
}

function featureIssue(approval = "human") {
  return {
    ref: { provider: "github", repo: "o/r", number: 20 },
    title: "Combustion chamber",
    body: "feature body",
    state: "open",
    kind: "feature",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: [],
    approval,
  };
}

function taskIssue(n, state) {
  return {
    ref: { provider: "github", repo: "o/r", number: n },
    title: `Task ${n}`,
    body: "",
    state,
    kind: "task",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: [],
  };
}

test("feature publish fast-forwards a stale local branch after a Task PR merge", async () => {
  const { root, repo } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    git(repo, ["branch", "mc/feature/20", "main"]);
    git(repo, ["push", "-q", "origin", "mc/feature/20"]);
    // Advance the remote Feature branch without moving the local ref.
    git(repo, ["checkout", "-q", "-b", "advance", "mc/feature/20"]);
    writeFileSync(join(repo, "merged.txt"), "merged task\n", "utf8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "merged task"]);
    git(repo, ["push", "-q", "origin", "advance:mc/feature/20"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["branch", "-D", "advance"]);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "publish", repoRoot: repo });
    const issues = new FakeIssueGraph(featureIssue("human"), [taskIssue(31, "closed")]);
    const result = await publishFeature({ layout, machine: MACHINE, recorder, feature: issues.feature.ref, issues, prs: new FakePrProvider() });
    assert.notEqual(result.status, "failed");
    const local = git(repo, ["rev-parse", "mc/feature/20"]).trim();
    const remote = git(repo, ["rev-parse", "origin/mc/feature/20"]).trim();
    assert.equal(local, remote);
    assert.match(git(repo, ["show", "mc/feature/20:merged.txt"]), /merged task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature PR is blocked while deliverable tasks are open", async () => {
  const { root, repo } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "publish", repoRoot: repo });
    const issues = new FakeIssueGraph(featureIssue(), [taskIssue(31, "closed"), taskIssue(32, "open")]);
    const prs = new FakePrProvider();
    const result = await publishFeature({ layout, machine: MACHINE, recorder, feature: issues.feature.ref, issues, prs });
    assert.equal(result.status, "blocked");
    assert.match(result.error, /open tasks: #32/);
    assert.equal(prs.created.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature PR runs integration gates, pushes the branch, and opens to main", async () => {
  const { root, repo, bare } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    git(repo, ["branch", "mc/feature/20", "main"]);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "publish", repoRoot: repo });
    const issues = new FakeIssueGraph(featureIssue("human"), [taskIssue(31, "closed"), taskIssue(32, "closed")]);
    const prs = new FakePrProvider();
    const result = await publishFeature({
      layout,
      machine: MACHINE,
      recorder,
      feature: issues.feature.ref,
      issues,
      prs,
      gates: [{ command: "core:status" }],
      defaultApproval: "human",
    });
    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.pr.head, "mc/feature/20");
    assert.equal(result.pr.base, "main");
    const branches = git(bare, ["branch", "--list"]).split("\n").map((s) => s.replace("*", "").trim());
    assert.ok(branches.includes("mc/feature/20"));
    assert.ok(events(recorder).some((e) => e.type === "integration_gate" && e.passed));
    assert.ok(events(recorder).some((e) => e.type === "approval_requested" && e.action === "merge"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature PR blocks when an integration gate fails and merges with agent approval", async () => {
  const { root, repo } = tempRepoWithOrigin();
  try {
    const layout = fakeLayout(repo);
    git(repo, ["branch", "mc/feature/20", "main"]);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "publish", repoRoot: repo });
    const issues = new FakeIssueGraph(featureIssue("agent"), [taskIssue(31, "closed")]);
    const prs = new FakePrProvider();

    const failed = await publishFeature({
      layout,
      machine: MACHINE,
      recorder,
      feature: issues.feature.ref,
      issues,
      prs,
      gates: [{ command: "core:show", args: { ref: "does-not-exist" } }],
    });
    assert.equal(failed.status, "blocked");
    assert.match(failed.error, /integration gate/);
    assert.equal(prs.created.length, 0);

    const merged = await publishFeature({ layout, machine: MACHINE, recorder, feature: issues.feature.ref, issues, prs });
    assert.equal(merged.status, "merged");
    assert.equal(prs.merged.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
