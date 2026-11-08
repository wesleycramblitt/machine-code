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
import { previewContext } from "../dist/context/preview.js";
import { trimContextText } from "../dist/context/render.js";
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

test("over-budget context drops lowest-priority bands first with named omissions", async () => {
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
    // One whole file is omitted by name, the other is trimmed with an
    // explicit marker — never a silent middle-cut.
    assert.ok(bundle.warnings.some((warning) => /omitted file:big-/.test(warning)), "omission names the dropped file");
    const trimmed = bundle.sources.find((source) => source.kind === "file" && source.truncated);
    assert.ok(trimmed, "the surviving over-budget file is marked truncated");
    assert.match(trimmed.warning ?? "", /trimmed/);
    assert.ok(bundle.warnings.some((warning) => /trimmed file:big-/.test(warning)));
    assert.doesNotMatch(bundle.text, /…\[context truncated\]/);
    assert.match(bundle.text, /…\[trimmed file:big-/);
    assert.ok(bundle.text.length <= 4000, "assembled context fits the budget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner index and explicit packet survive file trimming", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-survive-"));
  try {
    const layout = fakeLayout(root);
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), "# Plan index\nSURVIVE PLAN\n", "utf8");
    writePacket(layout, {
      id: "pkt-9",
      mode: "verified",
      goal: "survive trimming",
      context: [],
      constraints: [],
      acceptance: [{ command: "typescript:test" }],
    });
    writeFileSync(join(root, "big-c.md"), "C".repeat(20_000), "utf8");
    writeFileSync(join(root, "big-d.md"), "D".repeat(20_000), "utf8");
    const bundle = await assembleContext({
      layout,
      machine: machine(),
      agent: "planner",
      packetId: "pkt-9",
      include: { files: ["big-c.md", "big-d.md"] },
      budgetChars: 6000,
    });
    assert.match(bundle.text, /survive trimming/);
    assert.match(bundle.text, /SURVIVE PLAN/);
    assert.ok(bundle.sources.some((source) => source.kind === "packet" && source.ref === "pkt-9"));
    assert.ok(bundle.sources.some((source) => source.kind === "plan" && source.ref === "plans/index.md"));
    assert.ok(bundle.warnings.some((warning) => /omitted file:big-c\.md/.test(warning)));
    assert.ok(bundle.warnings.some((warning) => /omitted file:big-d\.md/.test(warning)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files section counts only files, and priority is role-aware", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-roles-"));
  try {
    const layout = fakeLayout(root);
    mkdirSync(join(root, "plans"), { recursive: true });
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), `# Plan index\n${"plan\n".repeat(400)}`, "utf8");
    writeFileSync(join(root, "knowledge", "deep.md"), `# Deep\n${"fact\n".repeat(400)}`, "utf8");
    writeFileSync(join(root, "work.md"), `${"work\n".repeat(400)}`, "utf8");
    // files section counts only kind:file
    const full = await assembleContext({
      layout,
      machine: machine(),
      agent: "research",
      include: { files: ["work.md"], knowledge: ["knowledge/deep.md"] },
    });
    assert.ok(full.sections.files > 0, "files section records working files");
    assert.ok(full.sections.knowledge > 0, "knowledge section records knowledge");
    // research keeps knowledge over files when over budget
    const tight = await assembleContext({
      layout,
      machine: machine(),
      agent: "research",
      include: { files: ["work.md"], knowledge: ["knowledge/deep.md"] },
      budgetChars: 3000,
    });
    assert.match(tight.text, /Deep/, "research keeps knowledge");
    assert.ok(tight.warnings.some((w) => /omitted file:work\.md/.test(w)), "research drops files first");
    // planner keeps the inherited plan index over working files
    const planTight = await assembleContext({
      layout,
      machine: machine(),
      agent: "planner",
      include: { files: ["work.md"] },
      budgetChars: 3000,
    });
    assert.match(planTight.text, /Plan index/, "planner keeps the plan index");
    assert.ok(planTight.warnings.some((w) => /omitted file:work\.md/.test(w)), "planner drops files first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context bundle records per-section chars", async () => {  const root = mkdtempSync(join(tmpdir(), "mc-ctx-sections-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), "# Plan index\nShip it.", "utf8");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      agent: "planner",
      machine: machine(),
      include: { files: ["src/a.ts"] },
    });
    for (const section of ["packets", "plans", "knowledge", "skills", "scripts", "tools", "references", "files", "parents", "system"]) {
      assert.equal(typeof bundle.sections[section], "number", `sections.${section} is recorded`);
    }
    assert.ok(bundle.sections.files > 0);
    assert.ok(bundle.sections.plans > 0);
    assert.equal(bundle.sections.system, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview chars match assembled chars within rounding for the same inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-parity-"));
  try {
    const layout = fakeLayout(root);
    mkdirSync(join(root, "plans"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "knowledge"), { recursive: true });
    mkdirSync(join(root, ".machine_code", "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), `# Plan index\n\n${"plan detail\n".repeat(50)}END\n`, "utf8");
    writeFileSync(join(root, "src", "a.ts"), `export const a = 1;\n${"// detail\n".repeat(50)}END\n`, "utf8");
    writeFileSync(join(root, "knowledge", "index.md"), `# Knowledge\n\n${"fact\n".repeat(50)}END\n`, "utf8");
    const skillBody = "---\nname: alpha\ndescription: alpha things\n---\n# Alpha\n\nbody text\n";
    writeFileSync(join(root, ".machine_code", "skills", "alpha", "SKILL.md"), skillBody, "utf8");
    const opts = {
      layout,
      agent: "planner",
      machine: machine({
        context: { maxChars: 64_000, planFile: undefined, knowledgeIndex: "knowledge/index.md" },
      }),
      include: { files: ["src/a.ts"] },
      defaultSkills: ["alpha"],
    };
    const bundle = await assembleContext(opts);
    const preview = previewContext(layout, "", {
      agent: "planner",
      files: ["src/a.ts"],
      knowledgeIndex: "knowledge/index.md",
      defaultSkills: ["alpha"],
    });
    const slack = Math.max(256, bundle.chars * 0.02);
    assert.ok(
      Math.abs(preview.chars - bundle.chars) <= slack,
      `preview ${preview.chars} ≈ assembled ${bundle.chars}`,
    );
    assert.deepEqual(
      Object.keys(preview.sections).sort(),
      ["files", "knowledge", "packets", "parents", "plans", "references", "scripts", "skills", "system", "tools"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trimContextText drops the lowest-priority tail with named omissions", async () => {
  const block = (kind, ref, body) =>
    `<context-block kind="${kind}" source="${ref}" origin="explicit" depth="0">\n${body}\n</context-block>`;
  const text = [
    "<context>",
    "Blocks.",
    block("packet", "pkt-1", "keep me"),
    block("file", "src/a.ts", "also kept"),
    block("tool", "3 commands", `dropped body ${"x".repeat(500)}`),
    "</context>",
  ].join("\n");
  const out = trimContextText(text, text.length - 50);
  assert.ok(out.length <= text.length - 50);
  assert.match(out, /keep me/);
  assert.match(out, /also kept/);
  assert.doesNotMatch(out, /dropped body/);
  assert.match(out, /omitted for the model budget: 3 commands/);
  assert.doesNotMatch(out, /…\[context truncated\]/);
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

test("preview and assemble agree on skill-body size for identical inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-skillparity-"));
  try {
    mkdirSync(join(root, ".machine_code", "skills", "alpha"), { recursive: true });
    const body = `---\nname: alpha\ndescription: alpha things\n---\n# Alpha body\n\n${"detail\n".repeat(200)}END\n`;
    writeFileSync(join(root, ".machine_code", "skills", "alpha", "SKILL.md"), body, "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["alpha"],
    });
    const assembled = bundle.sources.find((item) => item.kind === "skill" && item.ref === "alpha");
    assert.ok(assembled, "skill body is a context source");
    const preview = previewContext(fakeLayout(root), "", { defaultSkills: ["alpha"] });
    const previewed = preview.sources.find((item) => item.kind === "skill" && item.ref === "alpha");
    assert.ok(previewed, "skill body is a preview source");
    // Neither path caps skill bodies: both report the full on-disk size.
    assert.equal(assembled.bytes, Buffer.byteLength(body, "utf8"));
    assert.equal(previewed.chars, assembled.bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret files are warned (not inlined) in both preview and assemble", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-secret-"));
  try {
    writeFileSync(join(root, ".env"), "SUPER=sekret\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: [".env"] },
    });
    const assembled = bundle.sources.find((item) => item.kind === "file" && item.ref === ".env");
    assert.ok(assembled, "secret file is a warned source");
    assert.equal(assembled.bytes, 0);
    assert.match(assembled.warning ?? "", /secret/);
    assert.doesNotMatch(bundle.text, /sekret/);
    const preview = previewContext(fakeLayout(root), "", { files: [".env"] });
    const previewed = preview.sources.find((item) => item.kind === "file" && item.ref === ".env");
    assert.ok(previewed, "secret file is a warned preview source");
    assert.equal(previewed.chars, 0);
    assert.equal(previewed.exists, false);
    assert.ok(preview.warnings.some((warning) => /secret/.test(warning)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview and assemble share depth/provenance semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-depth-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "plans", "index.md"), "# Plan index\nShip it.", "utf8");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      agent: "planner",
      machine: machine(),
      include: { files: ["src/a.ts"] },
    });
    const file = bundle.sources.find((item) => item.kind === "file" && item.ref === "src/a.ts");
    assert.ok(file);
    assert.equal(file.origin, "explicit");
    assert.equal(file.depth, 0);
    const plan = bundle.sources.find((item) => item.kind === "plan" && item.ref === "plans/index.md");
    assert.ok(plan);
    assert.equal(plan.origin, "inherited");
    assert.equal(plan.depth, 3);
    const preview = previewContext(fakeLayout(root), "", { agent: "planner", files: ["src/a.ts"] });
    const previewFile = preview.sources.find((item) => item.kind === "file" && item.ref === "src/a.ts");
    assert.ok(previewFile);
    assert.equal(previewFile.origin, "explicit");
    assert.equal(previewFile.depth, 0);
    const previewPlan = preview.sources.find((item) => item.kind === "plan" && item.ref === "plans/index.md");
    assert.ok(previewPlan);
    assert.equal(previewPlan.origin, "inherited");
    assert.equal(previewPlan.depth, 3);
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

test("file range includes assemble only that range with provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-range-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "loop.ts"), ["one", "two", "three", "four", "five", "six"].join("\n") + "\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/loop.ts:2-4"] },
    });
    const source = bundle.sources.find((item) => item.kind === "file" && item.ref === "src/loop.ts:2-4");
    assert.ok(source, "range is a context source under its path:lines ref");
    assert.equal(source.origin, "explicit");
    assert.equal(source.warning, undefined);
    assert.match(bundle.text, /\[source: src\/loop\.ts:2-4\]/);
    assert.match(bundle.text, /\[parent: src\/loop\.ts; expand with the read tool\]/);
    assert.match(bundle.text, /\ntwo\nthree\nfour\n/);
    assert.doesNotMatch(bundle.text, /one/);
    assert.doesNotMatch(bundle.text, /five/);
    assert.doesNotMatch(bundle.text, /six/);
    // A single line is a one-line range.
    const single = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/loop.ts:5"] },
    });
    assert.match(single.text, /\[source: src\/loop\.ts:5-5\]/);
    assert.match(single.text, /\nfive\n/);
    assert.doesNotMatch(single.text, /four/);
    // Whole-file includes still inline the full body with no range header.
    const whole = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/loop.ts"] },
    });
    const wholeSource = whole.sources.find((item) => item.kind === "file" && item.ref === "src/loop.ts");
    assert.ok(wholeSource, "whole-file include keeps its plain path ref");
    assert.match(whole.text, /\none\ntwo\nthree\nfour\nfive\nsix\n/);
    assert.doesNotMatch(whole.text, /\[source: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing and out-of-range file ranges warn instead of going silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-range-warn-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "loop.ts"), ["one", "two", "three"].join("\n") + "\n", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/loop.ts:99-120", "src/missing.ts:1-10"] },
    });
    const warned = bundle.sources.filter((item) => item.kind === "file");
    assert.equal(warned.length, 2, "both bad ranges are warning sources");
    assert.ok(warned.every((item) => item.bytes === 0 && typeof item.warning === "string" && item.warning.length > 0));
    assert.ok(warned.some((item) => /out of range/.test(item.warning ?? "")), "past-EOF start warns");
    assert.ok(warned.some((item) => /missing/.test(item.warning ?? "")), "missing parent warns");
    assert.doesNotMatch(bundle.text, /\[source: src\/loop\.ts:99-120\]/);
    // A past-EOF end still yields the lines that exist, with the header
    // naming the lines actually included.
    const clamped = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { files: ["src/loop.ts:2-99"] },
    });
    assert.match(clamped.text, /\[source: src\/loop\.ts:2-3\]/);
    assert.match(clamped.text, /\ntwo\nthree\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview counts range chars the same as assembly", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-ctx-range-parity-"));
  try {
    const layout = fakeLayout(root);
    mkdirSync(join(root, "src"), { recursive: true });
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1} with padding content to give the file real weight`);
    writeFileSync(join(root, "src", "loop.ts"), lines.join("\n") + "\n", "utf8");
    const bundle = await assembleContext({
      layout,
      machine: machine(),
      include: { files: ["src/loop.ts:2-4"] },
    });
    const preview = previewContext(layout, "", { files: ["src/loop.ts:2-4"] });
    const previewed = preview.sources.find((item) => item.kind === "file" && item.ref === "src/loop.ts:2-4");
    assert.ok(previewed, "range is a preview source under its path:lines ref");
    const assembled = bundle.sources.find((item) => item.kind === "file" && item.ref === "src/loop.ts:2-4");
    assert.ok(assembled, "range is an assembled source");
    assert.equal(previewed.chars, assembled.bytes, "preview measures the snippet body, not the whole file");
    assert.ok(previewed.chars > 0 && previewed.chars < 600, "a 3-line snippet costs a 3-line snippet");
    assert.equal(previewed.exists, true);
    const wholeSource = previewContext(layout, "", { files: ["src/loop.ts"] }).sources.find(
      (item) => item.kind === "file",
    );
    assert.ok(wholeSource);
    assert.ok(previewed.chars < wholeSource.chars, "range preview is cheaper than the whole file");
    // A bad range is a zero-char warned preview source, like assembly.
    const bad = previewContext(layout, "", { files: ["src/loop.ts:99-120"] });
    const badSource = bad.sources.find((item) => item.kind === "file");
    assert.ok(badSource);
    assert.equal(badSource.chars, 0);
    assert.equal(badSource.exists, false);
    assert.ok(bad.warnings.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
