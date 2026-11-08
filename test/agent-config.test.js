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
import { capabilitiesFor, hasCapability } from "../dist/policy/capabilities.js";
import { agentDef } from "../dist/agents.js";
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
  const engineer = resolveAgentConfig({ role: "engineer" });
  assert.equal(engineer.preset, "implement");
  assert.equal(engineer.delegate, false);
  assert.equal(engineer.ask, true);
  assert.equal(engineer.verification, "verified");
  assert.equal(engineer.artifactScripts, true);

  const review = resolveAgentConfig({ role: "review" });
  assert.equal(review.preset, "review");
  assert.equal(review.delegate, false);

  const general = resolveAgentConfig({ role: "research" });
  assert.equal(general.preset, "research");
  assert.equal(general.ask, true);
  assert.equal(general.ambiguity, "strict", "research defaults to strict ambiguity");
});

test("override precedence: run flag > repo policy > machine; presets no longer steer", () => {
  // run overrides win
  assert.equal(
    resolveAgentConfig({
      role: "build",
      agentPolicy: { ambiguity: "adaptive" },
      machineOverrides: { ambiguity: "precise" },
      runOverrides: { ambiguity: "strict" },
    }).ambiguity,
    "strict",
  );
  // repo policy beats machine
  assert.equal(
    resolveAgentConfig({
      role: "build",
      agentPolicy: { ambiguity: "adaptive" },
      machineOverrides: { ambiguity: "precise" },
    }).ambiguity,
    "adaptive",
  );
  // machine beats the preset default
  assert.equal(
    resolveAgentConfig({ role: "build", machineOverrides: { ambiguity: "adaptive" } }).ambiguity,
    "adaptive",
  );
  // preset overrides are ignored: the role default always wins
  assert.equal(
    resolveAgentConfig({ role: "engineer", agentPolicy: { preset: "plan" }, machineOverrides: { preset: "review" } })
      .preset,
    "implement",
  );
  assert.equal(resolveAgentConfig({ role: "engineer", runOverrides: { preset: "review" } }).preset, "implement");
});

test("verification is direct|verified; redundant normalizes to verified", () => {
  const verified = resolveAgentConfig({ role: "engineer", runOverrides: { verification: "verified" } });
  assert.equal(verified.verification, "verified");
  assert.equal(verified.delegate, false, "engineer cannot delegate regardless of verification");
  const redundant = resolveAgentConfig({ role: "engineer", runOverrides: { verification: "redundant" } });
  assert.equal(redundant.verification, "verified");
  const direct = resolveAgentConfig({ role: "review", runOverrides: { verification: "direct" } });
  assert.equal(direct.verification, "direct");
});


test("roles no longer declare orchestration modes", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-modes-"));
  try {
    const layout = fakeLayout(root);
    for (const role of ["research", "engineer", "review"]) {
      assert.deepEqual(agentDef(layout, role).modes, []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ask is disabled in autonomous mode regardless of the ask flag", () => {
  const base = resolveAgentConfig({ role: "research" });
  assert.equal(askEnabled(base), true);
  const autonomous = resolveAgentConfig({ role: "research", runOverrides: { ambiguity: "autonomous" } });
  assert.equal(autonomous.ask, true);
  assert.equal(askEnabled(autonomous), false);
  assert.match(ambiguityPrompt("strict"), /STRICT/);
  assert.match(ambiguityPrompt("autonomous"), /AUTONOMOUS/);
});

/* --------------------------------------------------------- capabilities */

test("capability matrix: engineer, review, research", () => {
  const engineer = capabilitiesFor("engineer", { ...PRESETS.implement });
  assert.ok(hasCapability(engineer, "code:write"));
  assert.ok(hasCapability(engineer, "artifact:provision"));

  const review = capabilitiesFor("review", { ...PRESETS.review });
  assert.ok(hasCapability(review, "review:write"));
  assert.ok(!hasCapability(review, "code:write"));

  const general = capabilitiesFor("research", { ...PRESETS.assistant });
  assert.ok(hasCapability(general, "code:read"));
  assert.ok(hasCapability(general, "knowledge:write"));
  assert.ok(!hasCapability(general, "code:write"));
});

test("capabilities carry no issue grants", () => {
  const root = tempDir("access");
  try {
    const layout = fakeLayout(root);
    for (const role of ["engineer", "research", "review"]) {
      const resolved = resolveAgent(layout, role);
      assert.ok(!resolved.def.tools.includes("issue"), `${role} has no issue tool`);
      assert.ok(!resolved.def.tools.includes("issue_graph"), `${role} has no issue_graph tool`);
      for (const cap of resolved.capabilities) {
        assert.ok(!cap.startsWith("issue:"), `${role} capability ${cap} is not issue-scoped`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------ tool registration */

test("tools are capability-gated and no role has the task tool", () => {
  const root = tempDir("tools");
  try {
    const layout = fakeLayout(root);
    const engineer = resolveAgent(layout, "engineer");
    assert.ok(!engineer.def.tools.includes("task"));
    assert.ok(engineer.def.tools.includes("ask"), "ask is available unless autonomous");
    assert.ok(engineer.def.tools.includes("write"));
    assert.ok(engineer.def.tools.includes("artifact"));

    const engineerAsk = resolveAgent(layout, "engineer", { runOverrides: { ask: true } });
    assert.ok(engineerAsk.def.tools.includes("ask"), "engineer may be configured to ask");

    const engineerAuto = resolveAgent(layout, "engineer", { runOverrides: { ambiguity: "autonomous" } });
    assert.ok(!engineerAuto.def.tools.includes("ask"), "autonomous runs never get ask");

    const generalAuto = resolveAgent(layout, "research", { runOverrides: { ambiguity: "autonomous" } });
    assert.ok(!generalAuto.def.tools.includes("ask"), "autonomous runs never get ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composed prompt states worktree, verification, approval, and ambiguity", () => {
  const root = tempDir("prompt");
  try {
    const layout = fakeLayout(root);
    const resolved = resolveAgent(layout, "engineer", { runOverrides: { ambiguity: "strict" } });
    assert.match(resolved.prompt, /Config: worktree (on|off) · verification \S+ · approval (human|agent)\./);
    assert.doesNotMatch(resolved.prompt, /preset/);
    assert.match(resolved.prompt, /Ambiguity policy STRICT/);
    assert.match(resolved.prompt, /core:map/);
    assert.match(resolved.prompt, /context note/);
    const off = resolveAgent(layout, "engineer", { runOverrides: { worktree: false } });
    assert.match(off.prompt, /Config: worktree off ·/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
