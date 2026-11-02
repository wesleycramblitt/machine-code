/**
 * Phase 4 tests: reserved-issue invariants, duplicate canonicalisation,
 * planning-anchor resolution, Task-only run association, and the issue tool's
 * hierarchy + capability enforcement. Uses an in-memory provider (no gh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseIssueRef,
  parseReservedMarker,
  parseApprovalMarker,
  parseAcceptance,
} from "../dist/issues/provider.js";import {
  ensureEpicReserved,
  ensureFeatureReserved,
  ensureReserved,
  auditHierarchy,
  resolvePlanningAnchor,
  validateRunIssue,
  isReservedFor,
  isReservedTask,
} from "../dist/issues/reserved.js";
import { issueTool } from "../dist/tools/issues.js";
import { parsePlanMarker } from "../dist/plan/schema.js";
import { RunRecorder } from "../dist/state/runs.js";
import { resolveRunTarget } from "../dist/issues/work.js";

class FakeProvider {
  constructor() {
    this.kind = "github";
    this.next = 1;
    this.issues = new Map();
  }
  reservedFrom(body, explicit) {
    if (explicit) return explicit;
    const marker = parseReservedMarker(body ?? "");
    if (!marker) return undefined;
    return {
      for: { provider: "github", repo: "o/r", number: Number(marker.for.split("#")[1]) },
      kind: marker.kind,
    };
  }
  async available() { return true; }
  async get(ref) { return this.issues.get(ref.number) ?? null; }
  async list() { return [...this.issues.values()]; }
  async children(ref) {
    return [...this.issues.values()].filter((i) => i.parent?.number === ref.number);
  }
  async hierarchy(ref) {
    const chain = [];
    let cur = this.issues.get(ref.number);
    while (cur?.parent) { const p = this.issues.get(cur.parent.number); if (!p) break; chain.push(p); cur = p; }
    return chain;
  }
  async blockers(ref) { return this.issues.get(ref.number)?.blockedBy ?? []; }
  async create(input) {
    const number = this.next++;
    const issue = {
      ref: { provider: "github", repo: "o/r", number },
      title: input.title,
      body: input.body,
      state: "open",
      kind: input.kind,
      labels: input.labels ?? [],
      parent: input.parent,
      children: [],
      blockedBy: input.blockedBy ?? [],
      blocking: [],
      acceptance: parseAcceptance(input.body),
      approval: parseApprovalMarker(input.body),
      reserved: this.reservedFrom(input.body),
      createdAt: `2026-01-0${Math.min(9, number)}T00:00:00Z`,
    };
    this.issues.set(number, issue);
    if (input.parent) {
      const parent = this.issues.get(input.parent.number);
      if (parent) parent.children.push(issue.ref);
    }
    return issue;
  }
  async update(ref, patch) {
    const issue = this.issues.get(ref.number);
    if (!issue) throw new Error("missing");
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.blockedBy !== undefined) issue.blockedBy = patch.blockedBy;
    return issue;
  }
  async close(ref) { const i = this.issues.get(ref.number); if (i) i.state = "closed"; }
  async reopen(ref) { const i = this.issues.get(ref.number); if (i) i.state = "open"; }
  async linkParent(child, parent) {
    const c = this.issues.get(child.number);
    if (!c) return;
    c.parent = parent ?? undefined;
    if (parent) this.issues.get(parent.number)?.children.push(child);
  }
  addRaw(fields) {
    const number = this.next++;
    const issue = {
      ref: { provider: "github", repo: "o/r", number },
      title: fields.title ?? `Issue ${number}`,
      body: fields.body ?? "",
      state: "open",
      kind: fields.kind ?? "task",
      labels: fields.labels ?? [],
      parent: fields.parent,
      children: [],
      blockedBy: [],
      blocking: [],
      acceptance: [],
      reserved: this.reservedFrom(fields.body, fields.reserved),
      createdAt: fields.createdAt ?? `2026-01-0${Math.min(9, number)}T00:00:00Z`,
    };
    this.issues.set(number, issue);
    if (fields.parent) this.issues.get(fields.parent.number)?.children.push(issue.ref);
    return issue;
  }
}

const ref = (n) => ({ provider: "github", repo: "o/r", number: n });

/* ------------------------------------------------------------- parsing */

test("parseIssueRef accepts bare numbers, owner/repo#n, and URLs", () => {
  assert.deepEqual(parseIssueRef("31", "o/r"), ref(31));
  assert.deepEqual(parseIssueRef("o/r#31"), ref(31));
  assert.deepEqual(parseIssueRef("https://github.com/o/r/issues/31"), ref(31));
  assert.throws(() => parseIssueRef("31"), /owner\/repo/);
  assert.throws(() => parseIssueRef("nope"), /cannot parse/);
});

test("marker and acceptance parsers", () => {
  const body = [
    '<!-- mc:reserved {"for":"o/r#10","kind":"epic-pr"} -->',
    '<!-- mc:approval {"mode":"agent","reason":"tests"} -->',
    "",
    "## Acceptance criteria",
    "- one",
    "- two",
  ].join("\n");
  assert.deepEqual(parseReservedMarker(body), { for: "o/r#10", kind: "epic-pr" });
  assert.equal(parseApprovalMarker(body), "agent");
  assert.deepEqual(parseAcceptance(body), ["one", "two"]);
  assert.equal(parseReservedMarker("no marker"), null);
});

/* ------------------------------------------------- reserved invariants */

test("ensureEpicReserved creates Feature 0 and Task 0 once", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const first = await ensureEpicReserved(p, epic.ref);
  assert.equal(first.feature0.title, "Feature 0: Planning & Review");
  assert.equal(first.task0.title, "Task 0: Planning & Review");
  assert.equal(first.feature0.parent.number, epic.ref.number);
  assert.equal(first.task0.parent.number, first.feature0.ref.number);
  assert.ok(isReservedFor(first.feature0, epic.ref, "epic-pr"));
  assert.ok(isReservedTask(first.task0));

  const second = await ensureEpicReserved(p, epic.ref);
  assert.equal(second.feature0.ref.number, first.feature0.ref.number);
  assert.equal(second.task0.ref.number, first.task0.ref.number);
  assert.equal(p.issues.size, 3, "no duplicates created");
});

test("ensureFeatureReserved creates exactly one Task 0", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const feature = await p.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });
  const a = await ensureFeatureReserved(p, feature.ref);
  const b = await ensureFeatureReserved(p, feature.ref);
  assert.equal(a.ref.number, b.ref.number);
  assert.equal(p.issues.size, 3);
});

test("duplicate reserved issues: marker wins, empty duplicates close, ones with runs stay", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const marked = p.addRaw({
    title: "Feature 0: Planning & Review",
    body: '<!-- mc:reserved {"for":"o/r#1","kind":"epic-pr"} -->',
    kind: "feature",
    parent: epic.ref,
    labels: ["mc:reserved"],
    createdAt: "2026-01-05T00:00:00Z",
  });
  const dupEmpty = p.addRaw({
    title: "Feature 0: Planning & Review",
    kind: "feature",
    parent: epic.ref,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const dupWithRuns = p.addRaw({
    title: "Feature 0: Planning & Review",
    kind: "feature",
    parent: epic.ref,
    createdAt: "2026-01-02T00:00:00Z",
  });
  const runCounts = new Map([[dupWithRuns.ref.number, 2]]);
  const result = await ensureReserved(p, epic.ref, "epic-pr", { runCounts });
  assert.equal(result.issue.ref.number, marked.ref.number, "marker match is canonical");
  assert.deepEqual(result.duplicatesClosed, [dupEmpty.ref.number]);
  assert.deepEqual(result.duplicatesWithRuns, [dupWithRuns.ref.number]);
  assert.equal(p.issues.get(dupEmpty.ref.number).state, "closed");
  assert.equal(p.issues.get(dupWithRuns.ref.number).state, "open");
});

test("auditHierarchy reports missing reserved issues", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const audit = await auditHierarchy(p, epic.ref);
  assert.deepEqual(audit.missing, [{ parent: epic.ref, kind: "epic-pr" }]);
  assert.deepEqual(audit.duplicates, []);
});

/* ------------------------------------------------------------- anchors */

test("resolvePlanningAnchor maps Epic/Feature to reserved Task 0", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const feature = await p.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });
  const task = await p.create({ title: "Task", body: "", kind: "task", parent: feature.ref });

  const epicAnchor = await resolvePlanningAnchor(p, epic.ref);
  const epicReserved = await ensureEpicReserved(p, epic.ref);
  assert.equal(epicAnchor.number, epicReserved.task0.ref.number);

  const featureAnchor = await resolvePlanningAnchor(p, feature.ref);
  const featureReserved = await ensureFeatureReserved(p, feature.ref);
  assert.equal(featureAnchor.number, featureReserved.ref.number);

  const taskAnchor = await resolvePlanningAnchor(p, task.ref);
  assert.equal(taskAnchor.number, task.ref.number);
});

test("validateRunIssue enforces Task-only and reserved rules", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const feature = await p.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });
  const task = await p.create({ title: "Task", body: "", kind: "task", parent: feature.ref });
  const task0 = await ensureFeatureReserved(p, feature.ref);

  await assert.rejects(validateRunIssue(p, epic.ref), /Tasks only/);
  await assert.rejects(validateRunIssue(p, feature.ref), /Tasks only/);
  await assert.rejects(validateRunIssue(p, task0.ref), /reserved Task 0/);
  assert.equal((await validateRunIssue(p, task.ref)).ref.number, task.ref.number);
  assert.equal((await validateRunIssue(p, task0.ref, { allowReserved: true })).ref.number, task0.ref.number);
});

/* ------------------------------------------------------------ issue tool */

function toolCtx(provider, capabilities, root) {
  const layout = {
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
  const recorder = new RunRecorder(layout, { agent: "architect", mode: "", request: "r", repoRoot: root });
  return { recorder, layout, ctx: { provider, repo: "o/r", capabilities, recorder, layout, defaultApproval: "human" } };
}

test("issue tool gates actions by capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, [], root);
    const read = await issueTool(ctx).execute("c1", { action: "list" });
    assert.equal(read.isError, true);
    assert.match(read.content[0].text, /issue:read/);
    const write = await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "X" });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /issue:create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool requires issue:create for new issues and issue:plan for edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-access-"));
  try {
    const p = new FakeProvider();
    const readOnly = toolCtx(p, ["issue:read"], root).ctx;
    const create = await issueTool(readOnly).execute("c1", { action: "create", kind: "epic", title: "X" });
    assert.equal(create.isError, true);
    assert.match(create.content[0].text, /issue_create_forbidden/);

    const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
    const edit = await issueTool(readOnly).execute("c1", {
      action: "edit",
      issue: String(epic.ref.number),
      title: "Changed",
    });
    assert.equal(edit.isError, true);
    assert.match(edit.content[0].text, /issue:plan/);

    const planner = toolCtx(p, ["issue:read", "issue:plan"], root).ctx;
    const allowed = await issueTool(planner).execute("c1", {
      action: "edit",
      issue: String(epic.ref.number),
      title: "Changed",
    });
    assert.equal(allowed.isError, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool creates an Epic with its reserved chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss2-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan", "issue:write", "issue:hierarchy:write"], root);
    const result = await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Propulsion" });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /reserved: Feature 0 #/);
    assert.equal(p.issues.size, 3);
    const epic = [...p.issues.values()].find((i) => i.kind === "epic");
    assert.equal((await p.children(epic.ref)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool records dependencies on create and edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-deps-"));
  try {
    const p = new FakeProvider();
    const blocker = p.addRaw({ title: "Blocker", kind: "task" });
    const dependent = p.addRaw({ title: "Dependent", kind: "task" });
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);

    const created = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Dependent epic",
      depends_on: [String(blocker.ref.number)],
    });
    assert.equal(created.isError, undefined);
    const epic = [...p.issues.values()].find((issue) => issue.title === "Dependent epic");
    assert.ok(epic);
    assert.deepEqual(epic.blockedBy, [blocker.ref]);

    const edited = await issueTool(ctx).execute("c1", {
      action: "edit",
      issue: String(dependent.ref.number),
      blocked_by: [String(blocker.ref.number)],
    });
    assert.equal(edited.isError, undefined);
    assert.deepEqual(p.issues.get(dependent.ref.number).blockedBy, [blocker.ref]);

    const crossRepo = await issueTool(ctx).execute("c1", {
      action: "edit",
      issue: String(dependent.ref.number),
      blocked_by: ["other/repo#1"],
    });
    assert.equal(crossRepo.isError, true);
    assert.match(crossRepo.content[0].text, /same repository/);

    const missing = await issueTool(ctx).execute("c1", {
      action: "edit",
      issue: String(dependent.ref.number),
      blocked_by: ["999"],
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /was not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool writes and replaces mc:plan markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-plan-"));
  try {
    const p = new FakeProvider();
    const task = await p.create({
      title: "Plan me",
      body: "## Acceptance criteria\n- gate passes",
      kind: "task",
    });
    const { ctx } = toolCtx(p, ["issue:read", "issue:plan"], root);
    const ready = await issueTool(ctx).execute("c1", {
      action: "plan",
      issue: String(task.ref.number),
      status: "ready",
      plan_role: "build",
      verification: "verified",
      plan_review: "human",
    });
    assert.equal(ready.isError, undefined);
    const parsed = parsePlanMarker(p.issues.get(task.ref.number).body);
    assert.equal(parsed.plan.status, "ready");
    assert.equal(parsed.plan.planReview, "human");

    const draft = await issueTool(ctx).execute("c1", {
      action: "plan",
      issue: String(task.ref.number),
      status: "draft",
    });
    assert.equal(draft.isError, undefined);
    const body = p.issues.get(task.ref.number).body;
    assert.equal((body.match(/mc:plan/g) ?? []).length, 1, "replaces, not duplicates");
    assert.equal(parsePlanMarker(body).plan.status, "draft");

    const noAcceptance = await p.create({ title: "No acceptance", body: "", kind: "task" });
    const refused = await issueTool(ctx).execute("c1", {
      action: "plan",
      issue: String(noAcceptance.ref.number),
      status: "ready",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /acceptance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool rejects invalid hierarchy links", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss3-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:hierarchy:write"], root);
    const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
    const task = await p.create({ title: "Task", body: "", kind: "task" });
    const result = await issueTool(ctx).execute("c1", { action: "link", issue: String(task.ref.number), parent: String(epic.ref.number) });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid hierarchy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue close respects approval: human requests, agent closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss4-"));
  try {
    const p = new FakeProvider();
    const humanIssue = await p.create({ title: "Human", body: '<!-- mc:approval {"mode":"human"} -->', kind: "task" });
    const agentIssue = await p.create({ title: "Agent", body: '<!-- mc:approval {"mode":"agent"} -->', kind: "task" });
    const { ctx, layout } = toolCtx(p, ["issue:read", "issue:close"], root);
    // Acceptance evidence is required before closure.
    for (const target of [humanIssue, agentIssue]) {
      const rec = new RunRecorder(layout, { agent: "review", mode: "", request: "review", repoRoot: root, issue: target.ref });
      rec.event("acceptance_verified", { issue: target.ref.number, by: "human", criteria: [] });
      rec.finalize("completed");
    }
    const human = await issueTool(ctx).execute("c1", { action: "close", issue: String(humanIssue.ref.number) });
    assert.match(human.content[0].text, /approval is human/);
    assert.equal(p.issues.get(humanIssue.ref.number).state, "open");
    const agent = await issueTool(ctx).execute("c1", { action: "close", issue: String(agentIssue.ref.number) });
    assert.match(agent.content[0].text, /closed #/);
    assert.equal(p.issues.get(agentIssue.ref.number).state, "closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-issue fills Epic → Feature → Task and reuses exact open children", async () => {
  const provider = new FakeProvider();
  const epic = provider.addRaw({ kind: "epic", title: "Propulsion" });
  const first = await resolveRunTarget({
    provider,
    ref: epic.ref,
    request: "Implement the thermal model",
    agent: "build",
    autoCreate: true,
  });
  assert.equal(first.issue.kind, "task");
  assert.equal(first.created.length, 2, "a feature and a task were created");
  assert.equal(first.issue.parent.number, first.created[0].ref.number);
  assert.equal(first.created[0].parent.number, epic.ref.number);

  const second = await resolveRunTarget({
    provider,
    ref: epic.ref,
    request: "Implement the thermal model",
    agent: "build",
    autoCreate: true,
  });
  assert.equal(second.issue.ref.number, first.issue.ref.number);
  assert.equal(second.created.length, 0, "the exact-title open task is reused");
});
