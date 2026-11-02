/**
 * Phase 3 tests: agent configuration resolution, the capability matrix,
 * capability-gated tool registration, prompt composition, and delegation
 * gating in the task tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveAgentConfig,
  resolveAgent,
  askEnabled,
  ambiguityPrompt,
  PRESETS,
} from "../dist/agents/config.js";
import { capabilitiesFor, hasCapability, issueAccessFromCapabilities } from "../dist/policy/capabilities.js";
import { agentDef } from "../dist/agents.js";
import { taskTool } from "../dist/tools/task.js";
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

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `mc-3-${prefix}-`));
}

/* ------------------------------------------------------ config resolution */

test("role presets resolve to the documented defaults", () => {
  const planner = resolveAgentConfig({ role: "planner" });
  assert.equal(planner.preset, "plan");
  assert.equal(planner.issueAccess, "create");

  const architect = resolveAgentConfig({ role: "architect" });
  assert.deepEqual(architect, {
    preset: "orchestrate",
    delegate: true,
    verification: "verified",
    issues: "optional",
    issueAccess: "read",
    ask: true,
    approval: "human",
    ambiguity: "precise",
  });
  const build = resolveAgentConfig({ role: "build" });
  assert.equal(build.preset, "implement");
  assert.equal(build.delegate, false);
  assert.equal(build.ask, false);
  assert.equal(build.verification, "verified");
  assert.equal(build.issueAccess, "read");

  const general = resolveAgentConfig({ role: "general" });
  assert.equal(general.preset, "assistant");
  assert.equal(general.issues, "disabled");
  assert.equal(general.ask, true);
  assert.equal(general.issueAccess, "none");

  const sudo = resolveAgentConfig({ role: "sudo" });
  assert.equal(sudo.preset, "unrestricted");
  assert.equal(sudo.delegate, true);
  assert.equal(sudo.issues, "optional");
  assert.equal(sudo.issueAccess, "read");
});

test("override precedence: run flag > repo policy > machine > preset", () => {
  // run overrides win
  assert.equal(
    resolveAgentConfig({
      role: "architect",
      agentPolicy: { preset: "plan" },
      machineOverrides: { ambiguity: "adaptive" },
      runOverrides: { ambiguity: "strict" },
    }).ambiguity,
    "strict",
  );
  // repo policy beats machine
  assert.equal(
    resolveAgentConfig({
      role: "architect",
      agentPolicy: { preset: "plan" },
      machineOverrides: { preset: "orchestrate" },
    }).preset,
    "plan",
  );
  // machine beats preset
  assert.equal(
    resolveAgentConfig({ role: "architect", machineOverrides: { preset: "plan" } }).preset,
    "plan",
  );
});

test("verification is an explicit agent override, not a global mode", () => {
  const verified = resolveAgentConfig({ role: "build", runOverrides: { verification: "verified" } });
  assert.equal(verified.verification, "verified");
  assert.equal(verified.delegate, false, "build cannot delegate regardless of verification");
  const redundant = resolveAgentConfig({ role: "build", runOverrides: { verification: "redundant" } });
  assert.equal(redundant.verification, "redundant");
});


test("roles own their mode vocabulary and default mode", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-modes-"));
  try {
    const layout = fakeLayout(root);
    assert.deepEqual(agentDef(layout, "general").modes, []);
    assert.deepEqual(agentDef(layout, "sudo").modes, []);
    assert.deepEqual(agentDef(layout, "build").modes, []);
    const architect = agentDef(layout, "architect");
    assert.deepEqual(architect.modes, ["direct", "verified", "redundant"]);
    assert.equal(architect.defaultMode, "verified");
    assert.deepEqual(architect.modeConfig.verified, { verification: "verified", review: false });
    assert.deepEqual(architect.modeConfig.redundant, { verification: "redundant", review: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ask is disabled in autonomous mode regardless of the ask flag", () => {
  const base = resolveAgentConfig({ role: "general" });
  assert.equal(askEnabled(base), true);
  const autonomous = resolveAgentConfig({ role: "general", runOverrides: { ambiguity: "autonomous" } });
  assert.equal(autonomous.ask, true);
  assert.equal(askEnabled(autonomous), false);
  assert.match(ambiguityPrompt("strict"), /STRICT/);
  assert.match(ambiguityPrompt("autonomous"), /AUTONOMOUS/);
});

/* --------------------------------------------------------- capabilities */

test("capability matrix matches the design (architect plan/orchestrate)", () => {
  const plan = capabilitiesFor("architect", { ...PRESETS.plan });
  assert.ok(hasCapability(plan, "artifact:write"));
  assert.ok(!hasCapability(plan, "issue:write"));
  assert.ok(!hasCapability(plan, "issue:plan"));
  assert.ok(!hasCapability(plan, "issue:create"));
  assert.ok(hasCapability(plan, "issue:read"));
  assert.ok(!hasCapability(plan, "code:write"));
  assert.ok(!hasCapability(plan, "run:spawn"));
  assert.ok(!hasCapability(plan, "issue:close"));
  assert.ok(hasCapability(plan, "pr:read"));
  assert.ok(!hasCapability(plan, "pr:merge"));

  const orch = capabilitiesFor("architect", { ...PRESETS.orchestrate });
  assert.ok(hasCapability(orch, "run:spawn"));
  assert.ok(hasCapability(orch, "run:coordinate"));
  assert.ok(hasCapability(orch, "issue:close"));
  assert.ok(hasCapability(orch, "pr:create"));
  assert.ok(hasCapability(orch, "pr:merge"));
  assert.ok(!hasCapability(orch, "code:write"));
});

test("capability matrix: build, review, general, sudo", () => {
  const build = capabilitiesFor("build", { ...PRESETS.implement });
  assert.ok(hasCapability(build, "code:write"));
  assert.ok(hasCapability(build, "issue:read"));
  assert.ok(!hasCapability(build, "issue:write"));
  assert.ok(!hasCapability(build, "issue:create"));
  assert.ok(!hasCapability(build, "run:spawn"));
  assert.ok(!hasCapability(build, "issue:close"));

  const review = capabilitiesFor("review", { ...PRESETS.review });
  assert.ok(hasCapability(review, "review:write"));
  assert.ok(hasCapability(review, "issue:read"));
  assert.ok(!hasCapability(review, "code:write"));
  assert.ok(!hasCapability(review, "issue:close"));

  const general = capabilitiesFor("general", { ...PRESETS.assistant });
  assert.ok(hasCapability(general, "code:read"));
  assert.ok(!hasCapability(general, "issue:read"));

  const planner = capabilitiesFor("planner", { ...PRESETS.plan });
  assert.ok(hasCapability(planner, "issue:create"));
  assert.ok(hasCapability(planner, "issue:plan"));
  assert.ok(hasCapability(planner, "issue:read"));
  assert.ok(!hasCapability(planner, "code:write"));

  const sudo = capabilitiesFor("sudo", { ...PRESETS.unrestricted });
  assert.ok(hasCapability(sudo, "code:write"));
  assert.ok(hasCapability(sudo, "issue:close"));
  assert.ok(hasCapability(sudo, "run:spawn"));
  assert.ok(hasCapability(sudo, "pr:merge"));
});

test("issue_access is one resolved level and derives capabilities", () => {
  const root = tempDir("access");
  try {
    const layout = fakeLayout(root);
    const planner = resolveAgent(layout, "planner");
    assert.equal(planner.config.issueAccess, "create");
    assert.ok(hasCapability(planner.capabilities, "issue:create"));
    assert.ok(hasCapability(planner.capabilities, "issue:plan"));
    assert.ok(planner.def.tools.includes("issue"));

    const architect = resolveAgent(layout, "architect");
    assert.equal(architect.config.issueAccess, "read");
    assert.ok(!hasCapability(architect.capabilities, "issue:create"));

    const build = resolveAgent(layout, "build");
    assert.equal(build.config.issueAccess, "read");
    assert.ok(hasCapability(build.capabilities, "issue:read"));
    assert.ok(!hasCapability(build.capabilities, "issue:create"));
    assert.ok(!hasCapability(build.capabilities, "issue:plan"));

    const general = resolveAgent(layout, "general");
    assert.equal(general.config.issueAccess, "none");
    assert.ok(!general.def.tools.includes("issue"));
    assert.ok(!hasCapability(general.capabilities, "issue:read"));

    const planOnly = resolveAgent(layout, "planner", { runOverrides: { issueAccess: "plan" } });
    assert.equal(planOnly.config.issueAccess, "plan");
    assert.ok(hasCapability(planOnly.capabilities, "issue:plan"));
    assert.ok(!hasCapability(planOnly.capabilities, "issue:create"));

    assert.equal(issueAccessFromCapabilities(planner.capabilities), "create");
    assert.equal(issueAccessFromCapabilities(["issue:read", "issue:write"]), "plan");
    assert.equal(issueAccessFromCapabilities(build.capabilities), "read");
    assert.equal(issueAccessFromCapabilities(planOnly.capabilities), "plan");
    assert.equal(issueAccessFromCapabilities(general.capabilities), "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------ tool registration */

test("tools are capability-gated: plan has no task, orchestrate does", () => {
  const root = tempDir("tools");
  try {
    const layout = fakeLayout(root);
    const plan = resolveAgent(layout, "architect", { runOverrides: { preset: "plan" } });
    assert.ok(!plan.def.tools.includes("task"), "architect.plan cannot delegate");
    assert.ok(plan.def.tools.includes("ask"));
    assert.ok(!plan.def.tools.includes("write"), "read-only roles never hold write");

    const orch = resolveAgent(layout, "architect", { runOverrides: { preset: "orchestrate" } });
    assert.ok(orch.def.tools.includes("task"), "architect.orchestrate can delegate");

    const build = resolveAgent(layout, "build");
    assert.ok(!build.def.tools.includes("task"));
    assert.ok(!build.def.tools.includes("ask"), "build asks are off by default");
    assert.ok(build.def.tools.includes("write"));

    const buildAsk = resolveAgent(layout, "build", { runOverrides: { ask: true } });
    assert.ok(buildAsk.def.tools.includes("ask"), "build may be configured to ask");

    const generalAuto = resolveAgent(layout, "general", { runOverrides: { ambiguity: "autonomous" } });
    assert.ok(!generalAuto.def.tools.includes("ask"), "autonomous runs never get ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composed prompt states preset and ambiguity", () => {
  const root = tempDir("prompt");
  try {
    const layout = fakeLayout(root);
    const resolved = resolveAgent(layout, "architect", { runOverrides: { preset: "plan", ambiguity: "strict" } });
    assert.match(resolved.prompt, /preset plan/);
    assert.match(resolved.prompt, /Ambiguity policy STRICT/);
    assert.match(resolved.prompt, /core:map/);
    assert.match(resolved.prompt, /context note/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- delegation gating */

function taskCtx(root, overrides = {}) {
  const layout = fakeLayout(root);
  const recorder = new RunRecorder(layout, { agent: "architect", mode: "", request: "parent", repoRoot: root });
  return {
    recorder,
    ctx: {
      layout,
      recorder,
      parentRole: "architect",
      parentCapabilities: ["run:spawn", "run:coordinate"],
      machine: { priceCaps: {}, vetoes: [], notify: {}, git: {}, agents: {} },
      policy: { agents: {} },
      models: {},
      catalogue: [],
      configuredProviders: new Set(),
      commands: new Map(),
      root,
      toolRoot: root,
      home: layout.home,
      ...overrides,
    },
  };
}

test("task delegation is denied without capability or for the wrong role", async () => {
  const root = tempDir("task-deny");
  try {
    const a = taskCtx(root, { parentCapabilities: [] });
    const deniedCap = await taskTool(a.ctx).execute("c1", { agent: "build", prompt: "do it" });
    assert.equal(deniedCap.isError, true);
    assert.match(deniedCap.content[0].text, /run:spawn/);

    const b = taskCtx(root, { parentRole: "build" });
    const deniedRole = await taskTool(b.ctx).execute("c1", { agent: "build", prompt: "do it" });
    assert.equal(deniedRole.isError, true);
    assert.match(deniedRole.content[0].text, /role build cannot delegate/);

    const c = taskCtx(root, { parentRole: "sudo" });
    const sudoBuild = await taskTool(c.ctx).execute("c1", { agent: "build", prompt: "do it" });
    assert.equal(sudoBuild.isError, true);
    assert.match(sudoBuild.content[0].text, /sudo may only spawn sudo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task status/result require coordinate capability and a real child", async () => {
  const root = tempDir("task-inspect");
  try {
    const a = taskCtx(root, { parentCapabilities: ["run:spawn"] });
    const noCoord = await taskTool(a.ctx).execute("c1", { action: "status", runId: "nope" });
    assert.equal(noCoord.isError, true);
    assert.match(noCoord.content[0].text, /run:coordinate/);

    const b = taskCtx(root);
    const missing = await taskTool(b.ctx).execute("c1", { action: "result", runId: "no-such-run" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /no such child run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
