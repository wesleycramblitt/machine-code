/**
 * Plan-file tracking: plan_ref parsing, line replacement, and main-branch
 * commits. Uses temp git repos — no network, no gh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendPlanTracking,
  commitPlanFile,
  findPlanFiles,
  parsePlanRef,
  planTrackingLine,
  removePlanTracking,
  replacePlanLines,
  trackIssueInPlan,
  untrackIssueInPlans,
} from "../dist/plan/tracking.js";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "mc-plan-track-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(
    join(root, "plans", "tui.md"),
    ["# TUI", "", "- X needs to do A, B, and C", "- Y needs polish", "", "# Later", "", "- Z can wait", ""].join("\n"),
    "utf8",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
}

test("parsePlanRef accepts file:start and file:start-end", () => {
  assert.deepEqual(parsePlanRef("plans/tui.md:3"), {
    ref: { file: "plans/tui.md", start: 3, end: 3 },
  });
  assert.deepEqual(parsePlanRef("plans/tui.md:3-5"), {
    ref: { file: "plans/tui.md", start: 3, end: 5 },
  });
  assert.match(parsePlanRef("tui.md").error ?? "", /must look like/);
  assert.match(parsePlanRef("plans/tui.md:0").error ?? "", /invalid range/);
  assert.match(parsePlanRef("plans/tui.md:5-3").error ?? "", /invalid range/);
  assert.match(parsePlanRef("other/tui.md:3").error ?? "", /under plans\//);
  assert.match(parsePlanRef("plans/../x.md:3").error ?? "", /under plans\/|invalid range/);
});

test("replacePlanLines swaps the range for the tracking line", () => {
  const root = tempRepo();
  try {
    const line = planTrackingLine("feature", 120, "Do A, B, C");
    const done = replacePlanLines(root, "plans/tui.md", 3, 3, line);
    assert.equal(done.replaced, true);
    const body = readFileSync(join(root, "plans/tui.md"), "utf8");
    assert.match(body, /- \[ \] Feature #120: Do A, B, C/);
    assert.doesNotMatch(body, /X needs to do/);
    assert.match(body, /Y needs polish/);
    // Multi-line ranges collapse to the single tracking line.
    const line2 = planTrackingLine("feature", 121, "Polish Y");
    assert.equal(replacePlanLines(root, "plans/tui.md", 4, 4, line2).replaced, true);
    // Out of bounds is reported, not thrown.
    assert.equal(replacePlanLines(root, "plans/tui.md", 99, 99, line).replaced, false);
    assert.equal(replacePlanLines(root, "plans/missing.md", 1, 1, line).replaced, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacePlanLines keeps headings in place", () => {
  const root = tempRepo();
  try {
    const line = planTrackingLine("feature", 120, "Do A, B, C");
    // Lines 1-3 are a heading, a blank, and a plan item.
    const done = replacePlanLines(root, "plans/tui.md", 1, 3, line);
    assert.equal(done.replaced, true);
    const result = readFileSync(join(root, "plans/tui.md"), "utf8").split("\n");
    assert.equal(result[0], "# TUI");
    assert.match(result[1] ?? "", /- \[ \] Feature #120/);
    assert.doesNotMatch(result.join("\n"), /X needs to do/);
    // A range of only headings replaces nothing.
    const onlyHeadings = replacePlanLines(root, "plans/tui.md", 1, 1, line);
    assert.equal(onlyHeadings.replaced, false);
    assert.match(onlyHeadings.error ?? "", /only headings/);
    assert.equal(readFileSync(join(root, "plans/tui.md"), "utf8").split("\n")[0], "# TUI");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trackIssueInPlan replaces source lines and commits on main", async () => {
  const root = tempRepo();
  try {
    const result = await trackIssueInPlan(root, {
      kind: "feature",
      number: 120,
      title: "Do A, B, and C",
      planRef: "plans/tui.md:3",
    });
    assert.match(result.note, /Replaced plans\/tui\.md:3-3/);
    assert.equal(result.committed, true);
    const body = readFileSync(join(root, "plans/tui.md"), "utf8");
    assert.match(body, /- \[ \] Feature #120: Do A, B, and C/);
    assert.doesNotMatch(body, /X needs to do A, B, and C/);
    assert.match(git(root, ["log", "--oneline", "-1"]), /track feature #120/);
    // Second call for the same issue is a no-op for content but still fine.
    const again = await trackIssueInPlan(root, {
      kind: "feature",
      number: 120,
      title: "Do A, B, and C",
      planFile: "plans/tui.md",
    });
    assert.equal(again.committed, false, "nothing new to commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trackIssueInPlan appends without a plan_ref and commits", async () => {
  const root = tempRepo();
  try {
    const result = await trackIssueInPlan(root, {
      kind: "epic",
      number: 7,
      title: "TUI epic",
      planFile: "plans/tui.md",
    });
    assert.match(result.note, /Tracked in plans\/tui\.md/);
    assert.equal(result.committed, true);
    // A bad plan_ref degrades to an append with a skip note, never a throw.
    const bad = await trackIssueInPlan(root, {
      kind: "feature",
      number: 121,
      title: "Bad ref",
      planRef: "nope",
    });
    assert.match(bad.note, /skipped/);
    assert.equal(bad.committed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrackIssueInPlans removes lines and commits", async () => {
  const root = tempRepo();
  try {
    appendPlanTracking(root, "plans/tui.md", planTrackingLine("feature", 120, "Do A"));
    appendPlanTracking(root, "plans/tui.md", planTrackingLine("feature", 121, "Do B"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "tracked"]);
    const result = await untrackIssueInPlans(root, 120);
    assert.deepEqual(result.files, ["plans/tui.md"]);
    assert.equal(result.committed, true);
    const body = readFileSync(join(root, "plans/tui.md"), "utf8");
    assert.doesNotMatch(body, /#120/);
    assert.match(body, /#121/);
    const missing = await untrackIssueInPlans(root, 999);
    assert.deepEqual(missing.files, []);
    assert.equal(missing.committed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitPlanFile is a no-op without changes", async () => {
  const root = tempRepo();
  try {
    const clean = await commitPlanFile(root, "plans/tui.md", "plans: nothing");
    assert.equal(clean.committed, false);
    const missing = await commitPlanFile(root, "plans/nope.md", "plans: nothing");
    assert.equal(missing.committed, false);
    assert.deepEqual(findPlanFiles(root), ["plans/tui.md"]);
    removePlanTracking(root, "plans/tui.md", 12345);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class CloseFakeProvider {
  constructor(issues) {
    this.kind = "github";
    this.issues = new Map(issues.map((issue) => [issue.ref.number, issue]));
  }
  async get(ref) { return this.issues.get(ref.number) ?? null; }
  async children(ref) {
    return [...this.issues.values()].filter((i) => i.parent?.number === ref.number);
  }
  async close(ref) { const i = this.issues.get(ref.number); if (i) i.state = "closed"; }
}

function closeLayout(root) {
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

test("closeCompletedFeature untracks the plan line on close", async () => {
  const { closeCompletedFeature } = await import("../dist/orchestrator/closure.js");
  const { RunRecorder } = await import("../dist/state/runs.js");
  const root = tempRepo();
  try {
    appendPlanTracking(root, "plans/tui.md", planTrackingLine("feature", 7, "Do the thing"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "tracked"]);
    const layout = closeLayout(root);
    const issue = {
      ref: { provider: "github", repo: "o/r", number: 7 },
      title: "Do the thing",
      body: "",
      state: "open",
      kind: "feature",
      labels: [],
      children: [],
      acceptance: ["it works"],
    };
    const provider = new CloseFakeProvider([issue]);
    const recorder = new RunRecorder(layout, {
      agent: "build",
      mode: "verified",
      request: "x",
      repoRoot: root,
      issue: issue.ref,
    });
    const result = await closeCompletedFeature({ provider, layout, issue, runId: recorder.id, by: "human" });
    assert.equal(result.status, "closed");
    assert.deepEqual(result.untrackedPlans, ["plans/tui.md"]);
    assert.doesNotMatch(readFileSync(join(root, "plans/tui.md"), "utf8"), /#7\b/);
    assert.match(git(root, ["log", "--oneline", "-1"]), /untrack closed #7/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
