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
  assert.deepEqual(defaultSkillsFor({ agent: "review", verification: "verified" }), []);
  assert.deepEqual(defaultSkillsFor({ agent: "unknown" }), []);
});

test("default skill bodies load without issue declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code", "verified-testing"],
    });
    assert.match(bundle.text, /Be clean/);
    assert.ok(bundle.sources.some((s) => s.kind === "skill" && s.ref === "clean-code"));
    // Missing defaults are skipped silently: no warning source.
    assert.ok(!bundle.sources.some((s) => s.ref === "verified-testing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue-declared skills win ties over defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-tie-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const provider = new FakeProvider([
      issue(1, '<!-- mc:context {"skills":["clean-code"]} -->'),
    ]);
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      provider,
      issue: { provider: "github", repo: "o/r", number: 1 },
      defaultSkills: ["clean-code"],
    });
    const bodies = bundle.sources.filter((s) => s.kind === "skill" && s.ref === "clean-code");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].depth, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composer exclusions drop default skill bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-exc-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const excluded = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
      exclude: { items: ["skill:clean-code"] },
    });
    assert.doesNotMatch(excluded.text, /Be clean/);
    const sectionOff = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      defaultSkills: ["clean-code"],
      exclude: { sections: ["skills"] },
    });
    assert.doesNotMatch(sectionOff.text, /Be clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewContext surfaces default skill bodies for the TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-defskill-prev-"));
  try {
    writeSkill(root, "clean-code", "# Clean Code\nBe clean.");
    const preview = previewContext(fakeLayout(root), [], undefined, "", {
      defaultSkills: ["clean-code", "verified-testing"],
    });
    assert.ok(preview.sources.some((s) => s.kind === "skill" && s.ref === "clean-code"));
    assert.ok(preview.artifacts.skills.includes("clean-code"));
    // Missing default leaves no source behind.
    assert.ok(!preview.sources.some((s) => s.ref === "verified-testing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
