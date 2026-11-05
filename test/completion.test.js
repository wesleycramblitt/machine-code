/**
 * Phase 8 tests: acceptance evidence, parent completion checks, and the
 * reserved-issue close/reopen cascade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkCompletion, acceptanceEvidence, cascadeReserved } from "../dist/issues/completion.js";
import { RunRecorder } from "../dist/state/runs.js";
import { parseReservedMarker } from "../dist/issues/provider.js";

function fakeLayout(root) {
  return {
    home: join(root, "home"),
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

function issue(n, kind, title, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number: n },
    title,
    body: "",
    state: "open",
    kind,
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: [],
    ...extra,
  };
}

class FakeProvider {
  constructor(issues) {
    this.kind = "github";
    this.map = new Map(issues.map((i) => [i.ref.number, i]));
  }
  async get(ref) { return this.map.get(ref.number) ?? null; }
  async list() { return [...this.map.values()]; }
  async children(ref) { return [...this.map.values()].filter((i) => i.parent?.number === ref.number); }
  async hierarchy(ref) {
    const chain = [];
    let cur = this.map.get(ref.number);
    while (cur?.parent) { const p = this.map.get(cur.parent.number); if (!p) break; chain.push(p); cur = p; }
    return chain;
  }
  async blockers() { return []; }
  async create(input) {
    const number = Math.max(...this.map.keys(), 0) + 1;
    const i = issue(number, input.kind, input.title, {
      body: input.body,
      parent: input.parent,
      reserved: (() => {
        const m = parseReservedMarker(input.body ?? "");
        return m ? { for: { provider: "github", repo: "o/r", number: Number(m.for.split("#")[1]) }, kind: m.kind } : undefined;
      })(),
    });
    this.map.set(number, i);
    return i;
  }
  async update(ref, patch) { const i = this.map.get(ref.number); if (patch.title !== undefined) i.title = patch.title; return i; }
  async close(ref) { const i = this.map.get(ref.number); if (i) i.state = "closed"; }
  async reopen(ref) { const i = this.map.get(ref.number); if (i) i.state = "open"; }
  async linkParent(child, parent) { const c = this.map.get(child.number); if (c) c.parent = parent; }
}

const ref = (n) => ({ provider: "github", repo: "o/r", number: n });

test("completion requires closed deliverable children and acceptance evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-comp-"));
  try {
    const layout = fakeLayout(root);
    const epic = issue(10, "epic", "Epic");
    const feature = issue(20, "feature", "Feature", { parent: epic.ref });
    const t1 = issue(31, "task", "Task A", { parent: feature.ref });
    const t2 = issue(32, "task", "Task B", { parent: feature.ref });
    const feature0 = issue(11, "feature", "Feature 0: Planning & Review", {
      parent: epic.ref,
      labels: ["mc:reserved"],
      reserved: { for: epic.ref, kind: "epic-pr" },
    });
    const task0 = issue(21, "task", "Task 0: Planning & Review", {
      parent: feature.ref,
      labels: ["mc:reserved"],
      reserved: { for: feature.ref, kind: "feature-pr" },
    });
    const provider = new FakeProvider([epic, feature, t1, t2, feature0, task0]);

    const open = await checkCompletion(provider, layout, feature);
    assert.equal(open.ok, false);
    assert.deepEqual(open.openChildren, [31, 32]);
    assert.equal(open.acceptance.verified, false);

    t1.state = "closed";
    t2.state = "closed";
    const noAcceptance = await checkCompletion(provider, layout, feature);
    assert.equal(noAcceptance.ok, false);
    assert.match(noAcceptance.reason, /acceptance/);

    const recorder = new RunRecorder(layout, { agent: "review", mode: "", request: "review", repoRoot: root, issue: feature.ref });
    recorder.event("acceptance_verified", { issue: 20, by: "human", criteria: [] });
    recorder.finalize("completed");
    assert.equal((await acceptanceEvidence(layout, feature.ref)).verified, true);
    const ok = await checkCompletion(provider, layout, feature);
    assert.equal(ok.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task with an open PR cannot close", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-comp-pr-"));
  try {
    const layout = fakeLayout(root);
    const task = issue(31, "task", "Task A");
    const provider = new FakeProvider([task]);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "build", repoRoot: root, issue: task.ref });
    recorder.event("acceptance_verified", { issue: 31, by: "human", criteria: [] });
    recorder.patchSummary({ prNumber: 7, prState: "open", branch: "mc/task/31", baseBranch: "mc/feature/30" });
    recorder.finalize("completed");
    const blocked = await checkCompletion(provider, layout, task);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /PR #7 is still open/);

    const run = recorder.current;
    const merged = RunRecorder.reopen(layout, run);
    merged.patchSummary({ prState: "merged" });
    assert.equal((await checkCompletion(provider, layout, task)).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing a parent cascades to reserved anchors; reopening restores them", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-casc-"));
  try {
    const epic = issue(10, "epic", "Epic");
    const feature0 = issue(11, "feature", "Feature 0: Planning & Review", {
      parent: epic.ref,
      labels: ["mc:reserved"],
      reserved: { for: epic.ref, kind: "epic-pr" },
    });
    const task00 = issue(12, "task", "Task 0: Planning & Review", {
      parent: feature0.ref,
      labels: ["mc:reserved"],
      reserved: { for: feature0.ref, kind: "feature-pr" },
    });
    const feature = issue(20, "feature", "Feature", { parent: epic.ref });
    const task0 = issue(21, "task", "Task 0: Planning & Review", {
      parent: feature.ref,
      labels: ["mc:reserved"],
      reserved: { for: feature.ref, kind: "feature-pr" },
    });
    const provider = new FakeProvider([epic, feature0, task00, feature, task0]);

    const closed = await cascadeReserved(provider, epic, "close");
    assert.deepEqual(closed.sort((a, b) => a - b), [11, 12]);
    assert.equal(provider.map.get(11).state, "closed");
    assert.equal(provider.map.get(12).state, "closed");
    assert.equal(provider.map.get(21).state, "open", "other features' anchors untouched");

    const reopened = await cascadeReserved(provider, epic, "reopen");
    assert.deepEqual(reopened.sort((a, b) => a - b), [11, 12]);
    assert.equal(provider.map.get(11).state, "open");
    assert.equal(provider.map.get(12).state, "open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
