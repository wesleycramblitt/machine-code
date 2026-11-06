/**
 * Acceptance evidence and parent completion checks. All children are
 * deliverables; there are no reserved anchors and no cascade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkCompletion, acceptanceEvidence } from "../dist/issues/completion.js";
import { RunRecorder } from "../dist/state/runs.js";

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
    const f1 = issue(31, "feature", "Feature A", { parent: epic.ref });
    const f2 = issue(32, "feature", "Feature B", { parent: epic.ref });
    const provider = new FakeProvider([epic, feature, f1, f2]);

    const open = await checkCompletion(provider, layout, epic);
    assert.equal(open.ok, false);
    assert.deepEqual(open.openChildren, [20, 31, 32]);
    assert.equal(open.acceptance.verified, false);

    feature.state = "closed";
    f1.state = "closed";
    f2.state = "closed";
    const noAcceptance = await checkCompletion(provider, layout, epic);
    assert.equal(noAcceptance.ok, false);
    assert.match(noAcceptance.reason, /acceptance/);

    const recorder = new RunRecorder(layout, { agent: "review", mode: "", request: "review", repoRoot: root, issue: epic.ref });
    recorder.event("acceptance_verified", { issue: 10, by: "human", criteria: [] });
    recorder.finalize("completed");
    assert.equal((await acceptanceEvidence(layout, epic.ref)).verified, true);
    const ok = await checkCompletion(provider, layout, epic);
    assert.equal(ok.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Feature with an open PR cannot close", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-comp-pr-"));
  try {
    const layout = fakeLayout(root);
    const feature = issue(31, "feature", "Feature A");
    const provider = new FakeProvider([feature]);
    const recorder = new RunRecorder(layout, { agent: "build", mode: "", request: "build", repoRoot: root, issue: feature.ref });
    recorder.event("acceptance_verified", { issue: 31, by: "human", criteria: [] });
    recorder.patchSummary({ prNumber: 7, prState: "open", branch: "mc/feature/31", baseBranch: "main" });
    recorder.finalize("completed");
    const blocked = await checkCompletion(provider, layout, feature);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /PR #7 is still open/);

    const run = recorder.current;
    const merged = RunRecorder.reopen(layout, run);
    merged.patchSummary({ prState: "merged" });
    assert.equal((await checkCompletion(provider, layout, feature)).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

