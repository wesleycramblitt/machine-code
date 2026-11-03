/**
 * Phase 6 tests: context assembly priority, provenance, dedupe, budget,
 * explicit artifact references, and plan/skill sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assembleContext } from "../dist/context/assemble.js";
import { parseArtifactReferences, parseSkillFrontMatter } from "../dist/context/references.js";
import { writePacket } from "../dist/packet.js";

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

function machine(overrides = {}) {
  return {
    priceCaps: {},
    vetoes: [],
    notify: {},
    git: {},
    agents: {},
    issues: { provider: "github", policy: "optional", cacheTtlSeconds: 30 },
    context: { maxChars: 24_000, planFile: undefined, knowledgeIndex: undefined },
    ...overrides,
  };
}

function issue(n, kind, title, extra = {}) {
  return {
    ref: { provider: "github", repo: "o/r", number: n },
    title,
    body: extra.body ?? "",
    state: "open",
    kind,
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: extra.acceptance ?? [],
    approval: extra.approval,
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
  async hierarchy(ref) {
    const chain = [];
    let cur = this.map.get(ref.number);
    while (cur?.parent) {
      const p = this.map.get(cur.parent.number);
      if (!p) break;
      chain.push(p);
      cur = p;
    }
    return chain;
  }
  async children(ref) { return [...this.map.values()].filter((i) => i.parent?.number === ref.number); }
  async blockers() { return []; }
}

function hierarchyProvider() {
  const epic = issue(10, "epic", "Propulsion system");
  const feature = issue(20, "feature", "Combustion chamber", { parent: epic.ref });
  const task = issue(31, "task", "Thermal model", {
    parent: feature.ref,
    acceptance: ["thermal model converges"],
    body: "Implement the thermal model.",
  });
  return new FakeProvider([epic, feature, task]);
}

test("artifact reference + skill front-matter parsers", () => {
  const refs = parseArtifactReferences(
    '<!-- mc:context {"packets":["p1"],"knowledge":["knowledge/a.md"],"skills":["reference"],"tools":["scripts/x.sh"],"junk":1} -->',
  );
  assert.deepEqual(refs, { packets: ["p1"], files: [], knowledge: ["knowledge/a.md"], skills: ["reference"], tools: ["scripts/x.sh"], scripts: [] });
  assert.deepEqual(parseArtifactReferences("none"), { packets: [], files: [], knowledge: [], skills: [], tools: [], scripts: [] });
  const skill = parseSkillFrontMatter("---\nname: reference\ndescription: research\n---\n# body", "x");
  assert.deepEqual(skill, { name: "reference", description: "research", path: "x" });
});

test("no inputs yields only the tool/command index", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx0-"));
  try {
    const bundle = await assembleContext({ layout: fakeLayout(root), machine: machine() });
    assert.deepEqual(bundle.sources.map((s) => s.kind), ["tool"]);
    assert.match(bundle.text, /core:status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured knowledge index is inherited into context", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-knowledge-"));
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "knowledge", "index.md"), "# Repo knowledge\n\nStart here.\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine({
        context: { maxChars: 24_000, planFile: undefined, knowledgeIndex: "knowledge/index.md" },
      }),
    });
    const source = bundle.sources.find(
      (item) => item.kind === "knowledge" && item.ref === "knowledge/index.md",
    );
    assert.ok(source, "knowledge index is a context source");
    assert.match(bundle.text, /Repo knowledge/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task → feature → epic inheritance with provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx1-"));
  try {
    const provider = hierarchyProvider();
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      provider,
      issue: { provider: "github", repo: "o/r", number: 31 },
    });
    const kinds = bundle.sources.map((s) => s.kind);
    assert.deepEqual(kinds.slice(0, 3), ["task", "feature", "epic"]);
    assert.equal(bundle.sources[0].origin, "explicit");
    assert.equal(bundle.sources[1].origin, "inherited");
    assert.equal(bundle.sources[2].depth, 2);
    assert.match(bundle.text, /Thermal model/);
    assert.match(bundle.text, /Combustion chamber/);
    assert.match(bundle.text, /Propulsion system/);
    assert.match(bundle.text, /origin="inherited"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit packet is the highest-priority source", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx2-"));
  try {
    const layout = fakeLayout(root);
    writePacket(layout, {
      id: "pkt-1",
      mode: "verified",
      goal: "fix parser",
      context: ["src/parser.ts"],
      constraints: [],
      acceptance: [{ command: "typescript:test" }],
    });
    const bundle = await assembleContext({
      layout,
      machine: machine(),
      provider: hierarchyProvider(),
      issue: { provider: "github", repo: "o/r", number: 31 },
      packetId: "pkt-1",
    });
    assert.equal(bundle.sources[0].kind, "packet");
    assert.match(bundle.text, /fix parser/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mc:context knowledge references load, missing ones warn, duplicates dedupe", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx3-"));
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "knowledge", "thermal.md"), "# Thermal notes\nuse leapfrog", "utf8");
    const body = [
      '<!-- mc:context {"knowledge":["knowledge/thermal.md","knowledge/thermal.md","knowledge/missing.md"]} -->',
      "Task body",
    ].join("\n");
    const provider = hierarchyProvider();
    provider.map.get(31).body = body;
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      provider,
      issue: { provider: "github", repo: "o/r", number: 31 },
    });
    const knowledge = bundle.sources.filter((s) => s.kind === "knowledge");
    assert.equal(knowledge.length, 2, "one loaded + one missing warning (duplicate removed)");
    assert.ok(knowledge.some((s) => s.warning?.includes("missing")));
    assert.match(bundle.text, /use leapfrog/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget truncates blocks and keeps higher priority first", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx4-"));
  try {
    const provider = hierarchyProvider();
    provider.map.get(31).body = "T".repeat(20_000);
    provider.map.get(20).body = "F".repeat(20_000);
    provider.map.get(10).body = "E".repeat(20_000);
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      provider,
      issue: { provider: "github", repo: "o/r", number: 31 },
      budgetChars: 4000,
    });
    assert.ok(bundle.text.length < 5000, "stays near the budget");
    assert.ok(bundle.sources.some((s) => s.truncated));
    assert.equal(bundle.sources[0].kind, "task");
    assert.ok(!bundle.text.includes("E".repeat(1000)), "lowest priority is dropped or heavily clipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan files and skill descriptions are included last", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx5-"));
  try {
    writeFileSync(join(root, "plan.md"), "# Legacy plan\nDo not include me.", "utf8");
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "next.md"), "# Next plan\nShip it.", "utf8");
    mkdirSync(join(root, ".machine_code", "plans"), { recursive: true });
    writeFileSync(join(root, ".machine_code", "plans", "internal.md"), "# Internal plan\nKeep it local.", "utf8");
    mkdirSync(join(root, ".machine_code", "skills", "reference"), { recursive: true });
    writeFileSync(
      join(root, ".machine_code", "skills", "reference", "SKILL.md"),
      "---\nname: reference\ndescription: research and curation\n---\n# Reference\n",
      "utf8",
    );
    const bundle = await assembleContext({ layout: fakeLayout(root), machine: machine() });
    const kinds = bundle.sources.map((s) => s.kind);
    assert.ok(kinds.includes("plan"));
    assert.ok(kinds.includes("skill"));
    assert.match(bundle.text, /Next plan/);
    assert.match(bundle.text, /Internal plan/);
    assert.doesNotMatch(bundle.text, /Legacy plan/);
    assert.match(bundle.text, /reference: research and curation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context exclusions drop whole sections and individual sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-exclude-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "next.md"), "# Next plan\nShip it.", "utf8");
    mkdirSync(join(root, ".machine_code", "plans"), { recursive: true });
    writeFileSync(join(root, ".machine_code", "plans", "internal.md"), "# Internal plan\nKeep it local.", "utf8");

    const all = await assembleContext({ layout: fakeLayout(root), machine: machine() });
    assert.match(all.text, /Next plan/);
    assert.match(all.text, /Internal plan/);

    const noPlans = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      exclude: { sections: ["plans"] },
    });
    assert.doesNotMatch(noPlans.text, /Next plan/);
    assert.doesNotMatch(noPlans.text, /Internal plan/);

    const onePlan = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      exclude: { items: ["plan:plans/next.md"] },
    });
    assert.doesNotMatch(onePlan.text, /Next plan/);
    assert.match(onePlan.text, /Internal plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact references cascade Task → Feature → Epic, including files/tools/scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-artifacts-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".machine_code", "tools"), { recursive: true });
    mkdirSync(join(root, ".machine_code", "scripts"), { recursive: true });
    writeFileSync(join(root, "src", "thermal.ts"), "export const thermal = 1;\n", "utf8");
    writeFileSync(
      join(root, ".machine_code", "tools", "bench.toml"),
      'name = "bench"\ndescription = "fast benchmark"\ncommand = ".machine_code/scripts/bench-run.sh"\n',
      "utf8",
    );
    writeFileSync(join(root, ".machine_code", "scripts", "release-check.sh"), "#!/usr/bin/env bash\n# release guard\n", "utf8");
    writeFileSync(join(root, ".machine_code", "scripts", "bench-run.sh"), "#!/usr/bin/env bash\n# bench runner\n", "utf8");
    const provider = hierarchyProvider();
    provider.map.get(20).body = '<!-- mc:context {"files":["src/thermal.ts"],"tools":["bench"],"scripts":["release-check"]} -->';
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      provider,
      issue: { provider: "github", repo: "o/r", number: 31 },
    });
    const kinds = bundle.sources.map((source) => source.kind);
    assert.ok(kinds.includes("file"));
    assert.ok(kinds.includes("tool"));
    assert.ok(kinds.includes("script"));
    const file = bundle.sources.find((source) => source.kind === "file");
    assert.equal(file.origin, "inherited");
    assert.equal(file.depth, 1);
    assert.match(bundle.text, /export const thermal/);
    assert.match(bundle.text, /fast benchmark/);
    assert.match(bundle.text, /release guard/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork context keeps the whole parent chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-context-"));
  try {
    mkdirSync(join(root, ".machine_code"), { recursive: true });
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      parentRuns: [
        { id: "child-parent", request: "Try now" },
        { id: "grandparent", request: "original task", finalText: "original result" },
      ],
    });
    assert.match(bundle.text, /parent run: child-parent/);
    assert.match(bundle.text, /grandparent run: grandparent/);
    assert.match(bundle.text, /objective: original task/);
    assert.match(bundle.text, /result: original result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
