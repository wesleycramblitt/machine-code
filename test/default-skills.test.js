/**
 * Mode default skills: mapping, body loading, declared-wins ties,
 * exclusions, silent skips, and TUI preview sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assembleContext } from "../dist/context/assemble.js";
import { defaultSkillsFor } from "../dist/context/references.js";
import { roleSkillPresets } from "../dist/agents.js";
import { previewContext } from "../dist/context/preview.js";

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

function writeSkill(root, name, body) {
  mkdirSync(join(root, ".machine_code", "skills", name), { recursive: true });
  writeFileSync(
    join(root, ".machine_code", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`,
    "utf8",
  );
}

function issue(n, body = "") {
  return {
    ref: { provider: "github", repo: "o/r", number: n },
    title: `task ${n}`,
    body,
    state: "open",
    kind: "task",
    labels: [],
    children: [],
    blockedBy: [],
    blocking: [],
    acceptance: [],
  };
}

class FakeProvider {
  constructor(issues) {
    this.kind = "github";
    this.map = new Map(issues.map((i) => [i.ref.number, i]));
  }
  async get(ref) { return this.map.get(ref.number) ?? null; }
  async list() { return [...this.map.values()]; }
  async hierarchy() { return []; }
  async children() { return []; }
  async blockers() { return []; }
}

test("defaultSkillsFor maps agent and verification to skills", () => {
  assert.deepEqual(defaultSkillsFor({ agent: "build", verification: "direct" }), ["clean-code"]);
  assert.deepEqual(defaultSkillsFor({ agent: "build", verification: "verified" }), ["clean-code", "verified-testing"]);
  assert.deepEqual(defaultSkillsFor({ agent: "build", verification: "redundant" }), ["clean-code", "verified-testing"]);
  assert.deepEqual(defaultSkillsFor({ agent: "planner" }), ["clean-code"]);
  assert.deepEqual(defaultSkillsFor({ agent: "research" }), ["clean-code", "plan-curation"]);
  assert.deepEqual(defaultSkillsFor({ agent: "review", verification: "verified" }), []);
  assert.deepEqual(defaultSkillsFor({ agent: "unknown" }), []);
});

test("default skills are description-only without issue declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code", "verified-testing"],
    });
    // The index carries the one-line description plus the pull path, never
    // the body: defaults are on-demand.
    assert.match(bundle.text, /clean-code: clean-code description/);
    assert.match(bundle.text, /pull a body with the skill tool/);
    assert.doesNotMatch(bundle.text, /Be clean/);
    const bodies = bundle.sources.filter((s) => s.kind === "skill" && s.ref === "clean-code");
    assert.equal(bodies.length, 0, "no body source for a default skill");
    // Missing defaults are skipped silently: no warning source.
    assert.ok(!bundle.sources.some((s) => s.ref === "verified-testing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composer include overrides win ties over defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-tie-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
      skillOverrides: { "clean-code": "include" },
    });
    const bodies = bundle.sources.filter((s) => s.kind === "skill" && s.ref === "clean-code");
    assert.equal(bodies.length, 1);
    assert.match(bundle.text, /Be clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composer exclusions drop the default skill description and body", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-exc-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    // Default: description only, no body.
    const plain = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
    });
    assert.match(plain.text, /clean-code: clean-code description/);
    assert.doesNotMatch(plain.text, /Be clean/);
    // Excluding the item hides the description too.
    const excluded = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
      exclude: { items: ["skill:clean-code"] },
    });
    assert.doesNotMatch(excluded.text, /clean-code: clean-code description/);
    const sectionOff = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
      exclude: { sections: ["skills"] },
    });
    assert.doesNotMatch(sectionOff.text, /clean-code: clean-code description/);
    // An explicit include inlines the body; exclusions still win.
    const included = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
      skillOverrides: { "clean-code": "include" },
      exclude: { items: ["skill:clean-code"] },
    });
    assert.doesNotMatch(included.text, /Be clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewContext surfaces default skills as descriptions for the TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-prev-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const preview = previewContext(fakeLayout(root), "", {
      defaultSkills: ["clean-code", "verified-testing"],
    });
    // Defaults appear in the aggregate description index, not as body sources.
    assert.ok(preview.sources.some((s) => s.kind === "skill" && /skills$/.test(s.ref)));
    assert.ok(!preview.sources.some((s) => s.kind === "skill" && s.ref === "clean-code"));
    // Missing default leaves no source behind.
    assert.ok(!preview.sources.some((s) => s.ref === "verified-testing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("research runs activate the plan-curation skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-research-"));
  try {
    writeSkill(root, "plan-curation", "# Plan curation\nUse typed checklist items.");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      agent: "research",
      defaultSkills: defaultSkillsFor({ agent: "research" }),
      skillPresets: roleSkillPresets("research"),
    });
    assert.match(bundle.text, /Use typed checklist items/);
    assert.ok(bundle.sources.some((source) => source.kind === "skill" && source.ref === "plan-curation"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
