/**
 * Phase 4 tests: Epic/Feature hierarchy, planning-anchor resolution,
 * Feature-only run association, and the issue tool's hierarchy + capability
 * enforcement. Uses an in-memory provider (no gh).
 *
 * Model: IssueKind = epic|feature only. No reserved issues, no Task 0, no
 * `reserved` field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseIssueRef,
  parseApprovalMarker,
  parseAcceptance,
} from "../dist/issues/provider.js";
import { validateRunIssue } from "../dist/issues/work.js";
import { issueGraphTool, issueTool } from "../dist/tools/issues.js";
import { parseArtifactReferences } from "../dist/context/references.js";
import { RunStateStore } from "../dist/context/state.js";
import { parsePlanMarker } from "../dist/plan/schema.js";
import { RunRecorder } from "../dist/state/runs.js";
import { isGenericTaskRequest, issueRunRequest, resolveRunTarget } from "../dist/issues/work.js";

class FakeProvider {
  constructor() {
    this.kind = "github";
    this.next = 1;
    this.issues = new Map();
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
    const parsed = parsePlanMarker(input.body ?? "");
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
      acceptance: parseAcceptance(input.body ?? ""),
      approval: parseApprovalMarker(input.body ?? ""),
      plan: parsed.plan,
      planError: parsed.error,
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
    if (patch.removeBlockedBy !== undefined) {
      const gone = new Set(patch.removeBlockedBy.map((r) => r.number));
      issue.blockedBy = issue.blockedBy.filter((r) => !gone.has(r.number));
    }
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
    const parsed = parsePlanMarker(fields.body ?? "");
    const issue = {
      ref: { provider: "github", repo: "o/r", number },
      title: fields.title ?? `Issue ${number}`,
      body: fields.body ?? "",
      state: "open",
      kind: fields.kind ?? "feature",
      labels: fields.labels ?? [],
      parent: fields.parent,
      children: [],
      blockedBy: [],
      blocking: [],
      acceptance: parseAcceptance(fields.body ?? ""),
      approval: parseApprovalMarker(fields.body ?? ""),
      plan: parsed.plan,
      planError: parsed.error,
      createdAt: fields.createdAt ?? `2026-01-0${Math.min(9, number)}T00:00:00Z`,
    };
    this.issues.set(number, issue);
    if (fields.parent) this.issues.get(fields.parent.number)?.children.push(issue.ref);
    return issue;
  }
}

const ref = (n) => ({ provider: "github", repo: "o/r", number: n });

const CONTEXT = "## Context\nParent scope, relevant files and symbols, and constraints for this issue.";

function issueBody(kind, extra = "") {
  if (kind === "epic") {
    return `${CONTEXT}\n\n## Goal\nGoal\n\n## Scope\nScope${extra ? `\n${extra}` : ""}`;
  }
  return `${CONTEXT}\n\n## Goal\nGoal\n\n## Scope\nScope\n\n## Deliverable\nOne file-level change.\n\n## Acceptance criteria\n- one${extra ? `\n${extra}` : ""}`;
}

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
    '<!-- mc:approval {"mode":"agent"} -->',
    "",
    "## Acceptance criteria",
    "- one",
    "- two",
  ].join("\n");
  assert.equal(parseApprovalMarker(body), "agent");
  assert.deepEqual(parseAcceptance(body), ["one", "two"]);
  assert.equal(parseApprovalMarker("no marker"), undefined);

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
  assert.deepEqual(
    parseAcceptance("## Acceptance criteria\n1. one\n2) two\n- [ ] three\n- [x] four"),
    ["one", "two", "three", "four"],
  );
});

test("validateRunIssue enforces Feature-only runs with an Epic opt-in", async () => {
  const p = new FakeProvider();
  const epic = await p.create({ title: "Epic", body: "", kind: "epic" });
  const feature = await p.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });

  assert.equal((await validateRunIssue(p, feature.ref)).ref.number, feature.ref.number);
  await assert.rejects(validateRunIssue(p, epic.ref), /Features/);
  assert.equal((await validateRunIssue(p, epic.ref, { allowEpic: true })).ref.number, epic.ref.number);
  const legacy = p.addRaw({ title: "Legacy task", kind: "task" });
  await assert.rejects(validateRunIssue(p, legacy.ref), /no longer exists as a kind/);
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

test("graph action rejects incomplete feature bodies before creating anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-graph-accept-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const result = await issueTool(ctx).execute("g0", {
      action: "graph",
      graph: {
        epic: { key: "epic", title: "Epic" },
        features: [{ key: "f", title: "Feature" }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /acceptance criteria/);
    assert.equal(p.issues.size, 0, "no partial graph is created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create rejects issue bodies without the required context shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-context-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const epic = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: "## Goal\nEpic\n\n## Scope\nScope",
    });
    assert.equal(epic.isError, true);
    assert.match(epic.content[0].text, /missing ## Context/);
    assert.equal(p.issues.size, 0);

    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      title: "Feature",
      body: `${CONTEXT}\n\n## Goal\nGoal\n\n## Scope\nScope`,
    });
    assert.equal(feature.isError, true);
    assert.match(feature.content[0].text, /missing ## Deliverable/);

    const created = await issueTool(ctx).execute("c3", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    assert.equal(created.isError, undefined);
    const edited = await issueTool(ctx).execute("c4", {
      action: "edit",
      issue: "#1",
      body: "## Goal\nEpic\n\n## Scope\nScope",
    });
    assert.equal(edited.isError, true);
    assert.match(edited.content[0].text, /missing ## Context/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool repairs flat graph arguments and status aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-normalize-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const graphTool = issueGraphTool(ctx);
    const graph = graphTool.prepareArguments({
      epic: JSON.stringify({ key: "e", title: "Epic", body: issueBody("epic") }),
      features: JSON.stringify([{ key: "f", title: "Feature", body: issueBody("feature") }]),
    });
    assert.equal(graph.epic.key, "e");
    assert.equal(graph.features.length, 1);
    const checked = await graphTool.execute("g0", { ...graph, dry_run: true });
    assert.equal(checked.isError, undefined);
    assert.match(checked.content[0].text, /graph valid/);

    const tool = issueTool(ctx);
    const tree = tool.prepareArguments({ action: "tree", status: "open" });
    assert.equal(tree.state, "open");
    assert.equal(tree.status, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool drops null-string optionals before validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-nulls-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const tool = issueTool(ctx);
    // The exact weak-model shape from a stalled plan run: every absent
    // optional serialized as the string "null". Only action + state survive.
    const repaired = tool.prepareArguments({
      action: "tree",
      blocked_by: null,
      body: "null",
      depth: 2,
      dry_run: "null",
      issue: "null",
      kind: "null",
      limit: 100,
      parent: "null",
      plan_review: "null",
      plan_role: "null",
      plan_status: "null",
      reason: "null",
      result_review: "null",
      state: "open",
      status: "null",
      title: "null",
      verification: "null",
      worktree: "null",
    });
    assert.deepEqual(repaired, { action: "tree", blocked_by: null, depth: 2, limit: 100, state: "open" });

    // Null-like entries inside string arrays are dropped; emptied arrays go too.
    const blocked = tool.prepareArguments({ action: "create", blocked_by: ["null"], depends_on: ["1", "null"] });
    assert.deepEqual(blocked, { action: "create", depends_on: ["1"] });

    // The same repair applies inside graph items.
    const graphTool = issueGraphTool(ctx);
    const graph = graphTool.prepareArguments({
      epic: { key: "e", title: "Epic", body: issueBody("epic"), verification: "null" },
      features: [{ key: "f1", title: "F", body: issueBody("feature"), result_review: "null" }],
    });
    assert.equal(graph.epic.verification, undefined);
    assert.equal(graph.features[0].result_review, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue_graph accepts flat args and dry_run validates without creating", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-graph-tool-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const args = {
      epic: { key: "epic", title: "Epic", body: issueBody("epic") },
      features: [{ key: "f", title: "Feature", body: issueBody("feature") }],
      dry_run: true,
    };
    const check = await issueGraphTool(ctx).execute("g0", args);
    assert.equal(check.isError, undefined);
    assert.match(check.content[0].text, /graph valid/);
    assert.equal(p.issues.size, 0);

    const created = await issueGraphTool(ctx).execute("g1", { ...args, dry_run: false });
    assert.equal(created.isError, undefined);
    assert.match(created.content[0].text, /created graph/);
    assert.ok(p.issues.size >= 2, "graph nodes were created without reserved anchors");
    assert.ok(![...p.issues.values()].some((issue) => /Planning & Review/.test(issue.title)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue create records explicit context_files and does not infer them", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-context-files-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/tui.ts"), "export const value = 1;\n");
    const p = new FakeProvider();
    const epic = await p.create({ title: "Epic", body: issueBody("epic"), kind: "epic" });
    const feature = await p.create({ title: "Feature", body: issueBody("feature"), kind: "feature", parent: epic.ref });
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const other = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Second feature",
      body: `${issueBody("feature")}\n\n## Relevant files\n\nChange \`src/tui.ts\`.\n`,
      context_files: ["src/tui.ts"],
    });
    assert.equal(other.isError, undefined);
    const created = [...p.issues.values()].find((issue) => issue.title === "Second feature");
    assert.deepEqual(parseArtifactReferences(created.body).files, ["src/tui.ts"]);

    const bodyOnly = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Feature without explicit files",
      body: `${issueBody("feature")}\n\n## Relevant files\n\nChange \`src/tui.ts\`.\n`,
    });
    assert.equal(bodyOnly.isError, undefined);
    const inferred = [...p.issues.values()].find((issue) => issue.title === "Feature without explicit files");
    assert.deepEqual(parseArtifactReferences(inferred.body).files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tree reports legacy issues that lack required context", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-context-tree-"));
  try {
    const p = new FakeProvider();
    const epic = p.addRaw({
      title: "Legacy epic",
      kind: "epic",
      body: "## Goal\nLegacy\n\n## Scope\nLegacy scope",
    });
    const { ctx } = toolCtx(p, ["issue:read"], root);
    const tree = await issueTool(ctx).execute("c1", { action: "tree", issue: `#${epic.ref.number}`, depth: 1 });
    assert.equal(tree.isError, undefined);
    assert.match(tree.content[0].text, /Context incomplete: 1 issue/);
    assert.match(tree.content[0].text, /Repair them with action=edit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph action creates the Epic, Features, and dependencies in one call", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-graph-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const result = await issueTool(ctx).execute("g1", {
      action: "graph",
      graph: {
        epic: { key: "epic", title: "Epic", body: issueBody("epic", "## Feature plan\nDeliver as Features.") },
        features: [
          { key: "a", title: "Feature A", body: issueBody("feature", "## Problem\nA") },
          { key: "b", title: "Feature B", body: issueBody("feature", "## Problem\nB"), blocked_by: ["a"] },
        ],
      },
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /created graph/);
    const features = [...p.issues.values()].filter((issue) => issue.kind === "feature");
    assert.equal(features.length, 2);
    const a = features.find((issue) => issue.title === "Feature A");
    const b = features.find((issue) => issue.title === "Feature B");
    assert.ok(a && b);
    assert.equal(b.blockedBy[0].number, a.ref.number);

    for (const f of features) {
      const planned = await issueTool(ctx).execute("c3", { action: "plan", issue: `#${f.ref.number}`, status: "ready" });
      assert.equal(planned.isError, undefined);
    }
    const tree = await issueTool(ctx).execute("c4", { action: "tree", depth: 3 });
    assert.equal(tree.isError, undefined);
    assert.match(tree.content[0].text, /Graph complete/);
    assert.match(tree.content[0].text, /Create a named Epic\/Feature only when the request asks/);
    assert.doesNotMatch(tree.content[0].text, /Context incomplete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tree without an issue shows every root", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-tree-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const created = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    assert.equal(created.isError, undefined);
    const result = await issueTool(ctx).execute("c2", { action: "tree", depth: 3 });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /#1 epic open Epic/);
    assert.doesNotMatch(text, /Feature 0/);
    assert.doesNotMatch(text, /Task 0/);
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
    const created = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    assert.equal(created.isError, undefined);
    const block = state.renderBlock();
    assert.match(block, /Issues:/);
    assert.match(block, /#1 epic open "Epic"/);
    assert.doesNotMatch(block, /\[reserved\]/, "no reserved anchors exist to remember");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner creates link no reserved anchor; the run tracks the Epic", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-plan-link-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root, "planner");
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    assert.equal(p.issues.size, 1, "no reserved chain is created");
    const epic = [...p.issues.values()].find((issue) => issue.kind === "epic");
    assert.ok(epic);

    await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Feature",
      body: issueBody("feature"),
    });
    assert.equal(p.issues.size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task kinds are rejected; work is tracked as Features", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-no-task-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    const result = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "task",
      parent: "#1",
      title: "Task",
      body: issueBody("feature"),
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no longer tracked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a Feature with acceptance auto-writes a ready plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-autoplan-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: "#1",
      title: "Feature",
      body: issueBody("feature", "## Acceptance criteria\n- two\n"),
    });
    assert.equal(feature.isError, undefined);
    assert.match(feature.content[0].text, /plan ready/);
    const created = [...p.issues.values()].find((issue) => issue.title === "Feature");
    assert.equal(created.acceptance.length, 2);
    assert.equal(created.plan?.status, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph rejects a feature-sized Feature before creating anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-graph-size-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    const result = await issueTool(ctx).execute("g0", {
      action: "graph",
      graph: {
        epic: { key: "epic", title: "Epic", body: issueBody("epic") },
        features: [{
          key: "f",
          title: "Oversized Feature",
          body: issueBody("feature").replace("- one", "- one\n- two\n- three\n- four\n- five\n- six\n- seven\n- eight\n- nine"),
        }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /smaller Features/);
    assert.match(result.content[0].text, /at most 8/i);
    assert.equal(p.issues.size, 0, "no partial graph is created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating an oversized Feature is rejected before it exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-oversized-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: "#1",
      title: "Oversized Feature",
      body: issueBody("feature").replace("- one", "- one\n- two\n- three\n- four\n- five\n- six\n- seven\n- eight\n- nine"),
    });
    assert.equal(feature.isError, true);
    assert.match(feature.content[0].text, /too large/);
    assert.match(feature.content[0].text, /split it into smaller Features/);
    assert.equal([...p.issues.values()].some((issue) => issue.title === "Oversized Feature"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a Feature without acceptance is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-autoplan-none-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);
    await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Epic",
      body: issueBody("epic"),
    });
    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: "#1",
      title: "Feature",
      body: `${CONTEXT}\n\n## Goal\nGoal\n\n## Scope\nScope\n\n## Deliverable\nOne file-level change.\n`,
    });
    assert.equal(feature.isError, true);
    assert.match(feature.content[0].text, /missing acceptance criteria/);
    assert.equal([...p.issues.values()].some((issue) => issue.title === "Feature"), false);
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

test("issue tool creates an Epic with no reserved chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss2-"));
  try {
    const p = new FakeProvider();
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan", "issue:write", "issue:hierarchy:write"], root);
    const result = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Propulsion",
      body: issueBody("epic"),
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Next: create Features/);
    assert.equal(p.issues.size, 1);
    const epic = [...p.issues.values()].find((i) => i.kind === "epic");
    assert.equal((await p.children(epic.ref)).length, 0);

    const feature = await issueTool(ctx).execute("c2", {
      action: "create",
      kind: "feature",
      parent: `#${epic.ref.number}`,
      title: "Gates",
      body: issueBody("feature"),
    });
    assert.equal(feature.isError, undefined);
    assert.match(feature.content[0].text, /plan ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool records dependencies on create and edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-deps-"));
  try {
    const p = new FakeProvider();
    const blocker = p.addRaw({ title: "Blocker", kind: "feature" });
    const dependent = p.addRaw({ title: "Dependent", kind: "feature" });
    const { ctx } = toolCtx(p, ["issue:read", "issue:create", "issue:plan"], root);

    const created = await issueTool(ctx).execute("c1", {
      action: "create",
      kind: "epic",
      title: "Dependent epic",
      body: issueBody("epic"),
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

test("issue tool writes and replaces mc:plan markers on Features", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-iss-plan-"));
  try {
    const p = new FakeProvider();
    const feature = await p.create({
      title: "Plan me",
      body: issueBody("feature"),
      kind: "feature",
    });
    const { ctx } = toolCtx(p, ["issue:read", "issue:plan"], root);
    const ready = await issueTool(ctx).execute("c1", {
      action: "plan",
      issue: String(feature.ref.number),
      status: "ready",
      plan_role: "build",
      verification: "verified",
      plan_review: "human",
    });
    assert.equal(ready.isError, undefined);
    const parsed = parsePlanMarker(p.issues.get(feature.ref.number).body);
    assert.equal(parsed.plan.status, "ready");
    assert.equal(parsed.plan.planReview, "human");

    const draft = await issueTool(ctx).execute("c1", {
      action: "plan",
      issue: String(feature.ref.number),
      status: "draft",
    });
    assert.equal(draft.isError, undefined);
    const body = p.issues.get(feature.ref.number).body;
    assert.equal((body.match(/mc:plan/g) ?? []).length, 1, "replaces, not duplicates");
    assert.equal(parsePlanMarker(body).plan.status, "draft");

    const epic = await p.create({ title: "Epic", body: issueBody("epic"), kind: "epic" });
    const refused = await issueTool(ctx).execute("c1", {
      action: "plan",
      issue: String(epic.ref.number),
      status: "ready",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Feature issues only/);
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
    const feature = await p.create({ title: "Feature", body: "", kind: "feature" });
    const result = await issueTool(ctx).execute("c1", { action: "link", issue: String(epic.ref.number), parent: String(feature.ref.number) });
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
    const humanIssue = await p.create({ title: "Human", body: `${issueBody("feature")}\n<!-- mc:approval {"mode":"human"} -->`, kind: "feature" });
    const agentIssue = await p.create({ title: "Agent", body: `${issueBody("feature")}\n<!-- mc:approval {"mode":"agent"} -->`, kind: "feature" });
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

test("planner targets resolve to the Epic; builds attach to Features", async () => {
  const provider = new FakeProvider();
  const epic = await provider.create({ title: "Epic", body: "", kind: "epic" });
  const feature = await provider.create({ title: "Feature", body: "", kind: "feature", parent: epic.ref });

  const epicTarget = await resolveRunTarget({ provider, ref: epic.ref, request: "plan", agent: "planner" });
  assert.equal(epicTarget.issue.kind, "epic");
  assert.equal(epicTarget.issue.ref.number, epic.ref.number);
  assert.equal(epicTarget.scope?.ref.number, epic.ref.number);

  const featureTarget = await resolveRunTarget({ provider, ref: feature.ref, request: "plan", agent: "planner" });
  assert.equal(featureTarget.issue.kind, "epic");
  assert.equal(featureTarget.issue.ref.number, epic.ref.number);
  assert.equal(featureTarget.scope?.ref.number, feature.ref.number);

  const buildTarget = await resolveRunTarget({ provider, ref: feature.ref, request: "build", agent: "build" });
  assert.equal(buildTarget.issue.kind, "feature");
  assert.equal(buildTarget.issue.ref.number, feature.ref.number);
  assert.equal(buildTarget.scope?.ref.number, feature.ref.number);
});

test("auto-issue fills Epic → Feature and reuses exact open children", async () => {
  const provider = new FakeProvider();
  const epic = provider.addRaw({ kind: "epic", title: "Propulsion" });
  const first = await resolveRunTarget({
    provider,
    ref: epic.ref,
    request: "Implement the thermal model",
    agent: "build",
    autoCreate: true,
  });
  assert.equal(first.issue.kind, "feature");
  assert.equal(first.created.length, 1, "a feature was created");
  assert.equal(first.issue.parent.number, epic.ref.number);

  const second = await resolveRunTarget({
    provider,
    ref: epic.ref,
    request: "Implement the thermal model",
    agent: "build",
    autoCreate: true,
  });
  assert.equal(second.issue.ref.number, first.issue.ref.number);
  assert.equal(second.created.length, 0, "the exact-title open feature is reused");
});

test("issueRunRequest derives a concrete objective from the feature packet", async () => {
  const { issueRunRequest: runRequest } = await import("../dist/issues/work.js");
  const issue = {
    ref: { provider: "github", repo: "o/r", number: 100 },
    title: "Improve run tab hierarchy and integrate orchestrator kickoff",
    body: [
      "## Context",
      "",
      "Parent scope and constraints.",
      "",
      "## Scope",
      "",
      "Improve run tab readability for orchestrator items.",
      "",
      "## Acceptance criteria",
      "",
      "- Run tab displays the hierarchy.",
    ].join("\n"),
    state: "open",
    kind: "feature",
    labels: ["mc:feature"],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: ["Run tab displays the hierarchy."],
  };
  const request = runRequest(issue);
  assert.match(request, /^Implement o\/r#100: Improve run tab hierarchy/);
  assert.match(request, /Scope: Improve run tab readability/);
  assert.match(request, /Acceptance:\n- Run tab displays the hierarchy/);
  assert.equal(isGenericTaskRequest("Build the task."), true);
  assert.equal(isGenericTaskRequest("Do the issue"), true);
  assert.equal(isGenericTaskRequest("Implement #100 in the run tab"), false);
});

test("gh relation objects and arrays both normalize to node lists", async () => {
  const { relationItems } = await import("../dist/issues/github.js");
  assert.deepEqual(relationItems([{ number: 1 }]), [{ number: 1 }]);
  assert.deepEqual(relationItems({ nodes: [{ number: 2 }], totalCount: 1 }), [{ number: 2 }]);
  assert.deepEqual(relationItems(null), []);
});
