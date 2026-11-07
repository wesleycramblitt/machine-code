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
  assert.deepEqual(refs, { packets: ["p1"], files: [], knowledge: ["knowledge/a.md"], references: [], skills: ["reference"], tools: ["scripts/x.sh"], scripts: [] });
  assert.deepEqual(parseArtifactReferences("none"), { packets: [], files: [], knowledge: [], references: [], skills: [], tools: [], scripts: [] });
  const skill = parseSkillFrontMatter("---\nname: reference\ndescription: research\n---\n# body", "x");
  assert.deepEqual(skill, { name: "reference", description: "research", path: "x" });
});

test("plans are included up to the model budget, not a fixed 2 KiB cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-plan-full-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    const long = `# Long plan\n\n${"detail line\n".repeat(400)}END OF PLAN\n`;
    writeFileSync(join(root, "plans", "index.md"), long, "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      agent: "planner",
      machine: machine({ context: { maxChars: 24_000, planFile: undefined, knowledgeIndex: undefined } }),
    });
    const source = bundle.sources.find((item) => item.kind === "plan");
    assert.ok(source, "plan is a context source");
    assert.ok(source.bytes > 4096, "the plan is not silently cut at 2 KiB");
    assert.match(bundle.text, /END OF PLAN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context over budget is reported instead of silently truncated", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-over-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), `# Plan\n\n${"line\n".repeat(300)}END OF PLAN\n`, "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      agent: "planner",
      machine: machine({ context: { maxChars: 1_000, planFile: undefined, knowledgeIndex: undefined } }),
    });
    assert.match(bundle.text, /END OF PLAN/);
    const plan = bundle.sources.find((item) => item.kind === "plan");
    assert.ok(plan);
    assert.equal(plan.truncated, false);
    assert.ok(bundle.warnings.some((warning) => /model input budget/.test(warning)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composer can include explicit files without a heuristic", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-files-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const included = true;\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/a.ts"] },
    });
    const source = bundle.sources.find((item) => item.kind === "file" && item.ref === "src/a.ts");
    assert.ok(source, "explicit file is a context source");
    assert.match(bundle.text, /export const included = true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("included knowledge references load, missing ones warn", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx3-"));
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "knowledge", "thermal.md"), "# Thermal notes\nuse leapfrog", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { knowledge: ["knowledge/thermal.md", "knowledge/missing.md"] },
    });
    const knowledge = bundle.sources.filter((s) => s.kind === "knowledge");
    assert.equal(knowledge.length, 2, "one loaded + one missing warning");
    assert.ok(knowledge.some((s) => s.warning?.includes("missing")));
    assert.match(bundle.text, /use leapfrog/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("included reference citations load from the central store", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-ref-"));
  try {
    const layout = fakeLayout(root);
    const dir = join(layout.home, "references", "demo", "1", "content");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "alpha.md"), "## Alpha {#alpha}\n\nAlpha reference body.\n", "utf8");
    const bundle = await assembleContext({
      layout,
      machine: machine(),
      include: { references: ["demo/1/content/alpha.md#alpha", "demo/1/content/missing.md"] },
    });
    const refs = bundle.sources.filter((s) => s.kind === "reference");
    assert.equal(refs.length, 2, "one loaded + one missing warning");
    assert.ok(refs.some((source) => source.ref === "demo/1/content/alpha.md#alpha"));
    assert.ok(refs.some((source) => source.warning?.includes("missing")));
    assert.match(bundle.text, /Alpha reference body/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("over-budget context is preserved and warned, not silently clipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx4-"));
  try {
    writeFileSync(join(root, "big-a.md"), "A".repeat(20_000), "utf8");
    writeFileSync(join(root, "big-b.md"), "B".repeat(20_000), "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["big-a.md", "big-b.md"] },
      budgetChars: 4000,
    });
    assert.ok(bundle.text.length > 20_000, "curated context is not silently truncated");
    assert.ok(bundle.warnings.some((warning) => /model input budget/.test(warning)));
    assert.ok(bundle.text.includes("A".repeat(1_000)), "sources are still present");
    assert.ok(bundle.sources.every((source) => source.truncated === false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plan index is inherited only by the planner", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx5-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), "# Plan index\nShip it.", "utf8");
    writeFileSync(join(root, "plans", "topic.md"), "# Topic note\nDo not auto-include.", "utf8");

    const planner = await assembleContext({ layout: fakeLayout(root), agent: "planner", machine: machine() });
    assert.ok(planner.sources.some((s) => s.kind === "plan"));
    assert.match(planner.text, /Plan index/);
    assert.doesNotMatch(planner.text, /Do not auto-include/);

    const build = await assembleContext({ layout: fakeLayout(root), agent: "build", machine: machine() });
    assert.ok(!build.sources.some((s) => s.kind === "plan"));
    assert.doesNotMatch(build.text, /Plan index/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit plan includes load for any agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-plans-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), "# Plan index\nShip it.", "utf8");
    writeFileSync(join(root, "plans", "topic.md"), "# Topic note\nExplicitly included.", "utf8");

    const build = await assembleContext({
      layout: fakeLayout(root),
      agent: "build",
      machine: machine(),
      include: { plans: ["plans/topic.md", "plans/missing.md"] },
    });
    const plans = build.sources.filter((s) => s.kind === "plan");
    assert.equal(plans.length, 2, "one loaded + one missing warning");
    assert.ok(plans.some((s) => s.ref === "plans/topic.md" && s.origin === "explicit"));
    assert.ok(plans.some((s) => s.warning?.includes("missing")));
    assert.match(build.text, /Explicitly included/);

    // section:plans exclusion drops explicit plans too
    const excluded = await assembleContext({
      layout: fakeLayout(root),
      agent: "build",
      machine: machine(),
      include: { plans: ["plans/topic.md"] },
      exclude: { sections: ["plans"] },
    });
    assert.ok(!excluded.sources.some((s) => s.kind === "plan"));
    assert.doesNotMatch(excluded.text, /Explicitly included/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context exclusions drop whole sections and individual sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-exclude-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), "# Next plan\nShip it.", "utf8");

    const all = await assembleContext({ layout: fakeLayout(root), agent: "planner", machine: machine() });
    assert.match(all.text, /Next plan/);

    const noPlans = await assembleContext({
      layout: fakeLayout(root),
      agent: "planner",
      machine: machine(),
      exclude: { sections: ["plans"] },
    });
    assert.doesNotMatch(noPlans.text, /Next plan/);

    const onePlan = await assembleContext({
      layout: fakeLayout(root),
      agent: "planner",
      machine: machine(),
      exclude: { items: ["plan:plans/index.md"] },
    });
    assert.doesNotMatch(onePlan.text, /Next plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composer file includes carry provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-artifacts-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "thermal.ts"), "export const thermal = 1;\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/thermal.ts"] },
    });
    const kinds = bundle.sources.map((source) => source.kind);
    assert.ok(kinds.includes("file"));
    const file = bundle.sources.find((source) => source.kind === "file");
    assert.equal(file.origin, "explicit");
    assert.match(bundle.text, /export const thermal/);
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

test("a blocked parent's closing summary is not inherited as truth", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-context-"));
  try {
    mkdirSync(join(root, ".machine_code"), { recursive: true });
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      parentRuns: [
        {
          id: "blocked-parent",
          request: "Build the task.",
          status: "blocked",
          stopReason: "loop",
          error: "repeated identical tool calls detected",
          finalText: "The task details are missing and no concrete task definition was produced.",
        },
      ],
    });
    assert.match(bundle.text, /status: blocked \(loop\)/);
    assert.match(bundle.text, /error: repeated identical tool calls detected/);
    assert.match(bundle.text, /previous attempt stopped early/);
    assert.doesNotMatch(bundle.text, /result: The task details are missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill modes gate bodies but keep descriptions", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-skills-"));
  try {
    for (const name of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(root, ".machine_code", "skills", name), { recursive: true });
      writeFileSync(
        join(root, ".machine_code", "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} things\n---\n# ${name} body\n`,
        "utf8",
      );
    }
    const base = {
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["alpha"],
      skillPresets: { beta: "on-demand", gamma: "exclude" },
    };
    const bundle = await assembleContext(base);
    // alpha default -> include: body inlined.
    assert.match(bundle.text, /# alpha body/);
    // beta preset on-demand -> description only, no body.
    assert.match(bundle.text, /beta: beta things/);
    assert.doesNotMatch(bundle.text, /# beta body/);
    // gamma preset exclude -> nowhere, not even the description.
    assert.doesNotMatch(bundle.text, /gamma/);
    // Composer override wins over the preset.
    const overridden = await assembleContext({ ...base, skillOverrides: { beta: "include", alpha: "exclude" } });
    assert.match(overridden.text, /# beta body/);
    assert.doesNotMatch(overridden.text, /# alpha body/);
    assert.doesNotMatch(overridden.text, /alpha: alpha things/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
