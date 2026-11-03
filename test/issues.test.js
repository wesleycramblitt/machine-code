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
import { RunStateStore } from "../dist/context/state.js";
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
      plan: parsePlanMarker(input.body).plan,
      planError: parsePlanMarker(input.body).error,
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
    if (patch.body !== undefined) {
      issue.body = patch.body;
      issue.acceptance = parseAcceptance(patch.body);
      const parsed = parsePlanMarker(patch.body);
      issue.plan = parsed.plan;
      issue.planError = parsed.error;
    }
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

  const plain = [
    "Scope:",
    "- not acceptance",
    "",
    "Acceptance criteria:",
    "- gate passes",
    "- typed errors",
    "",
    "Out of scope:",
    "- not acceptance either",
  ].join("\n");
  assert.deepEqual(parseAcceptance(plain), ["gate passes", "typed errors"]);
  assert.deepEqual(
    parseAcceptance("**Acceptance criteria:**\n- one\n\n**Out of scope:**\n- two"),
    ["one"],
  );
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

function toolCtx(provider, capabilities, root, agent = "build") {
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
  const recorder = new RunRecorder(layout, { agent, mode: "", request: "r", repoRoot: root });
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

test("empty issue list tells the planner to create the Epic", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-empty-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const result = await issueTool(ctx).execute("c1", { action: "list" });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /no issues/);
    assert.match(text, /create the Epic/);
    assert.match(text, /Do not list again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty issue list does not tell a read-only role to create", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-empty-read-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read"], root);
    const result = await issueTool(ctx).execute("c1", { action: "list" });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /read-only issue access/);
    assert.doesNotMatch(text, /create the Epic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tree without an issue shows every root and its reserved anchors", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-tree-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const created = await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Epic" });
    assert.equal(created.isError, undefined);
    const result = await issueTool(ctx).execute("c2", { action: "tree", depth: 3 });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /#1 epic open Epic/);
    assert.match(text, /Feature 0: Planning & Review/);
    assert.match(text, /Task 0: Planning & Review/);
    assert.doesNotMatch(text, /argument_missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty tree without an issue gives the planner a create hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-tree-empty-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const result = await issueTool(ctx).execute("c1", { action: "tree" });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /no open issues/);
    assert.match(text, /create/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue creation is remembered in run state", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-state-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const state = new RunStateStore({ runDir: join(root, "state"), runId: "r", goal: "plan" });
    ctx.state = state;
    const created = await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Epic" });
    assert.equal(created.isError, undefined);
    const block = state.renderBlock();
    assert.match(block, /Issues:/);
    assert.match(block, /#1 epic open "Epic"/);
    assert.match(block, /Feature 0: Planning & Review/);
    assert.match(block, /Task 0: Planning & Review/);
    assert.match(block, /\[reserved\]/, "reserved anchors are remembered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner creation links the run to the new Epic's reserved Task 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-plan-link-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root, "planner");
    await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Epic" });
    const epic = [...p.issues.values()].find((issue) => issue.kind === "epic");
    const feature0 = [...p.issues.values()].find((issue) => issue.reserved?.kind === "epic-pr");
    const task0 = [...p.issues.values()].find(
      (issue) => issue.reserved?.kind === "feature-pr" && issue.parent?.number === feature0.ref.number,
    );
    assert.equal(ctx.recorder.current.issue.number, task0.ref.number);

    await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Feature",
    });
    assert.equal(ctx.recorder.current.issue.number, task0.ref.number, "the Epic anchor is not replaced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner creating a Feature under an existing Epic links to the Epic's Task 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-plan-feature-"));
  try {
    const p = new FakeProvider();
    const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root, "planner");
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Feature",
    });
    const feature0 = [...p.issues.values()].find((issue) => issue.reserved?.kind === "epic-pr");
    const epicTask0 = [...p.issues.values()].find(
      (issue) => issue.reserved?.kind === "feature-pr" && issue.parent?.number === feature0.ref.number,
    );
    assert.equal(ctx.recorder.current.issue.number, epicTask0.ref.number);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner creating a Task links to that Feature's reserved Task 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-plan-task-"));
  try {
    const p = new FakeProvider();
    const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
    const feature = await p.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root, "planner");
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "task",
      parent: `#${feature.ref.number}`,
      title: "Task",
      body: "## Acceptance criteria\n- one\n",
    });
    const task0 = [...p.issues.values()].find(
      (issue) => issue.reserved?.kind === "feature-pr" && issue.parent?.number === feature.ref.number,
    );
    assert.equal(ctx.recorder.current.issue.number, task0.ref.number);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task cannot be created under the reserved Feature 0 anchor", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-reserved-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const created = await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Epic" });
    assert.equal(created.isError, undefined);
    const feature0 = [...p.issues.values()].find((issue) => issue.reserved?.kind === "epic-pr");
    assert.ok(feature0, "Epic creation reserves Feature 0");
    const result = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "task",
      parent: `#${feature0.ref.number}`,
      title: "Task",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /reserved planning anchor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a Task with acceptance auto-writes a ready plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-autoplan-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Epic" });
    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: "#1",
      title: "Feature",
    });
    assert.equal(feature.isError, undefined);
    const featureIssue = [...p.issues.values()].find((issue) => issue.title === "Feature");
    const task = await issueTool(ctx).execute("c3", {
      action: "create",
      kind: "task",
      parent: `#${featureIssue.ref.number}`,
      title: "Task",
      body: "## Acceptance criteria\n- one\n- two\n",
    });
    assert.equal(task.isError, undefined);
    assert.match(task.content[0].text, /plan ready/);
    const created = [...p.issues.values()].find((issue) => issue.title === "Task");
    assert.equal(created.acceptance.length, 2);
    assert.equal(created.plan?.status, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a Task without acceptance leaves it unplanned", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-autoplan-none-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    await issueTool(ctx).execute("c1", { action: "create", kind: "epic", title: "Epic" });
    await issueTool(ctx).execute("c2", { action: "create", kind: "feature", parent: "#1", title: "Feature" });
    const featureIssue = [...p.issues.values()].find((issue) => issue.title === "Feature");
    const task = await issueTool(ctx).execute("c3", {
      action: "create",
      kind: "task",
      parent: `#${featureIssue.ref.number}`,
      title: "Task",
      body: "No criteria yet.",
    });
    assert.equal(task.isError, undefined);
    assert.match(task.content[0].text, /add acceptance criteria/);
    const created = [...p.issues.values()].find((issue) => issue.title === "Task");
    assert.equal(created.plan, undefined);
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
    assert.match(result.content[0].text, /Feature 0: Planning & Review/);
    assert.match(result.content[0].text, /Task 0: Planning & Review/);
    assert.match(result.content[0].text, /coordination anchors/);
    assert.equal(p.issues.size, 3);
    const epic = [...p.issues.values()].find((i) => i.kind === "epic");
    assert.equal((await p.children(epic.ref)).length, 1);

    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Gates",
    });
    assert.equal(feature.isError, undefined);
    assert.match(feature.content[0].text, /reserved: Task 0 #/);
    assert.match(feature.content[0].text, /Task 0: Planning & Review/);
    assert.match(feature.content[0].text, /coordination anchor/);
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

test("planner and review targets resolve Epic/Feature to reserved Task 0", async () => {
  const provider = new FakeProvider();
  const epic = await provider.create({ title: "Epic", body: "", kind: "epic" });
  const feature = await provider.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });
  const task = await provider.create({ title: "Task", body: "", kind: "task", parent: feature.ref });

  for (const agent of ["planner", "review"]) {
    const epicTarget = await resolveRunTarget({ provider, ref: epic.ref, request: "plan", agent });
    assert.equal(epicTarget.issue.kind, "task");
    assert.equal(epicTarget.issue.reserved?.kind, "feature-pr");

    const featureTarget = await resolveRunTarget({ provider, ref: feature.ref, request: "plan", agent });
    assert.equal(featureTarget.issue.kind, "task");
    assert.equal(featureTarget.issue.reserved?.kind, "feature-pr");

    const taskTarget = await resolveRunTarget({ provider, ref: task.ref, request: "plan", agent });
    assert.equal(taskTarget.issue.ref.number, task.ref.number);
  }
});

test("auto-issue refuses to create work under reserved anchors", async () => {
  const provider = new FakeProvider();
  const epic = await provider.create({ title: "Epic", body: "", kind: "epic" });
  const reserved = await ensureEpicReserved(provider, epic.ref);
  await assert.rejects(
    resolveRunTarget({
      provider,
      ref: reserved.feature0.ref,
      request: "Implement",
      agent: "build",
      autoCreate: true,
    }),
    /reserved Planning & Review anchor/,
  );
  await assert.rejects(
    resolveRunTarget({
      provider,
      ref: reserved.task0.ref,
      request: "Implement",
      agent: "build",
      autoCreate: true,
    }),
    /reserved Planning & Review anchor/,
  );
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

test("gh relation objects and arrays both normalize to node lists", async () => {
  const { relationItems } = await import("../dist/issues/github.js");
  assert.deepEqual(relationItems([{ number: 1 }]), [{ number: 1 }]);
  assert.deepEqual(relationItems({ nodes: [{ number: 2 }], totalCount: 1 }), [{ number: 2 }]);
  assert.deepEqual(relationItems(null), []);
});
