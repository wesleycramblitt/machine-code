/**
 * Tests for the capability-gated pr tool. Runner-owned publishing was removed:
 * features merge directly on approval, so there is no publish pipeline left.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { prTool } from "../dist/tools/pr.js";
import { RunRecorder } from "../dist/state/runs.js";

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
    const missing = await prTool(b.ctx).execute("c1", { action: "create", head: "mc/feature/31-login" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /requires head and base/);

    const good = await prTool(b.ctx).execute("c1", { action: "create", head: "mc/feature/31-login", base: "main" });
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
  await prs.create({ head: "mc/feature/31-login", base: "main", title: "t", body: "" });
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
