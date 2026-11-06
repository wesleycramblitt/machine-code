/**
 * TUI feature panel: merge/issue state without network, plus bold
 * verdict-label tolerance in the shared outcome parsers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { featurePanel, featureStageLite } from "../dist/tui/feature-status.js";
import { parseBuildOutcome, parseReviewVerdict } from "../dist/orchestrator/outcome.js";
import { RunRecorder } from "../dist/state/runs.js";
import { createWorktree, commitWorktree } from "../dist/worktree.js";

let COUNTER = 0;

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), `mc-featpanel-${++COUNTER}-`));
  const gitk = (args, opts = {}) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0 && !opts.allowFail) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result;
  };
  gitk(["init", "-b", "main"]);
  gitk(["config", "user.email", "test@example.com"]);
  gitk(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test repo\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), ".machine_code/local/\n", "utf8");
  gitk(["add", "-A"]);
  gitk(["commit", "-m", "init"]);
  return { dir, gitk };
}

function fakeLayout(root) {
  return {
    home: join(root, "machine-home"),
    machineConfig: "",
    curation: "",
    catalogueFile: "",
    repoRoot: root,
    repoDir: join(root, ".machine_code"),
    localDir: join(root, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(root, ".machine_code", "local", "runs"),
  };
}

const REF = { provider: "github", repo: "test/repo", number: 7 };

function fakeIssue(overrides = {}) {
  return {
    ref: REF,
    title: "Do the thing",
    state: "open",
    kind: "feature",
    body: "",
    acceptance: ["it works"],
    labels: [],
    ...overrides,
  };
}

test("bold verdict/outcome labels parse", () => {
  assert.equal(parseReviewVerdict("Verdict: **changes_requested**."), "changes_requested");
  assert.equal(parseReviewVerdict("**Verdict:** approved"), undefined); // label must lead the match
  assert.equal(parseReviewVerdict("Verdict: approved"), "approved");
  assert.equal(parseBuildOutcome("Outcome: **completed**"), "completed");
  assert.equal(parseBuildOutcome("Outcome: maybe"), undefined);
});

test("featureStageLite resolves without git", () => {
  const ready = fakeIssue({
    body: "<!-- mc:plan\n" + JSON.stringify({ v: 1, status: "ready", role: "build" }) + "\n-->",
  });
  assert.equal(featureStageLite(ready, []), "ready");
  assert.equal(featureStageLite(fakeIssue(), []), "planning");
  assert.equal(featureStageLite(undefined, []), "unknown");
  assert.equal(
    featureStageLite(ready, [{ agent: "build", status: "blocked", phase: "build" }]),
    "blocked",
  );
  assert.equal(
    featureStageLite(ready, [{ agent: "build", status: "completed", commit: "abc123" }]),
    "needs-human-review",
  );
  assert.equal(featureStageLite(ready, [{ agent: "build", status: "completed" }]), "blocked");
});

test("feature panel with no runs: planning stage, branch missing", () => {
  const { dir } = tempRepo();
  try {
    const panel = featurePanel(fakeLayout(dir), fakeIssue(), REF);
    assert.ok(panel);
    assert.equal(panel.number, 7);
    assert.equal(panel.issueState, "open");
    assert.equal(panel.stage, "planning");
    assert.equal(panel.branch, "mc/feature/7-do-the-thing");
    assert.equal(panel.branchExists, false);
    assert.equal(panel.merged, undefined);
    assert.equal(panel.worktreeExists, false);
    assert.equal(panel.dirtyCount, 0);
    assert.equal(panel.build, undefined);
    assert.equal(panel.review, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feature panel tracks worktree dirt and merge state", async () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const spec = await createWorktree({ layout, runId: "r-panel", kind: "feature", issueNumber: 7, issueTitle: "Do the thing" });
    const build = new RunRecorder(layout, { agent: "build", mode: "verified", request: "x", repoRoot: dir, issue: REF });
    build.patchSummary({ worktree: spec.path, branch: spec.branch, baseBranch: spec.baseBranch, baseRef: spec.baseRef });

    let panel = featurePanel(layout, fakeIssue(), REF);
    assert.ok(panel);
    assert.equal(panel.branch, spec.branch);
    assert.equal(panel.branchExists, true);
    // Fresh branch points at the base tip: nothing to merge.
    assert.equal(panel.merged, true);
    assert.equal(panel.worktreeExists, true);
    assert.equal(panel.dirtyCount, 0);

    writeFileSync(join(spec.path, "new.txt"), "uncommitted\n", "utf8");
    panel = featurePanel(layout, fakeIssue(), REF);
    assert.equal(panel.dirtyCount, 1);

    await commitWorktree({ path: spec.path, message: "work" });
    const sha = (await import("node:child_process")).spawnSync("git", ["rev-parse", "HEAD"], { cwd: spec.path, encoding: "utf8" }).stdout.trim();
    build.patchSummary({ commit: sha });
    panel = featurePanel(layout, fakeIssue(), REF);
    assert.equal(panel.dirtyCount, 0);
    assert.equal(panel.merged, false);
    assert.equal(panel.ahead, 1);
    assert.equal(panel.behind, 0);
    assert.ok(panel.commit && panel.commit.length === 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feature panel surfaces bold review verdicts and closed issues", () => {
  const { dir } = tempRepo();
  try {
    const layout = fakeLayout(dir);
    const review = new RunRecorder(layout, { agent: "review", mode: "", request: "x", repoRoot: dir, issue: REF });
    review.finalize("completed", undefined, "Some prose.\n\nVerdict: **changes_requested**.\nDone.");

    const panel = featurePanel(layout, fakeIssue(), REF);
    assert.ok(panel?.review);
    assert.equal(panel.review.status, "completed");
    assert.equal(panel.review.verdict, "changes_requested");

    const closed = featurePanel(layout, fakeIssue({ state: "closed" }), REF);
    assert.equal(closed?.issueState, "closed");
    assert.equal(closed?.stage, "closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
