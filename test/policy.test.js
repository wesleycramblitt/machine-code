/**
 * Effective policy precedence and editability:
 * built-in defaults ← machine [selection] ← machine [agents.<role>] ← repo policy.
 * Axis tables merge per axis so a repo override does not erase global floors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMachineConfig, loadPolicy, ConfigError, DEFAULT_AGENT_POLICY } from "../dist/config.js";

function setup(machineConfig, repoPolicy = "") {
  const root = mkdtempSync(join(tmpdir(), "mc-policy-"));
  const machine = join(root, "config.toml");
  const repo = join(root, "policy.toml");
  writeFileSync(machine, machineConfig, "utf8");
  writeFileSync(repo, repoPolicy, "utf8");
  return { root, layout: { machineConfig: machine, policyFile: repo } };
}

test("machine selection defaults, per-role overrides, and repo precedence", () => {
  const { root, layout } = setup(
    [
      "[selection]",
      'tier = "paid"',
      "min_capability = 7.2",
      "min_context = 30000",
      "[selection.axes]",
      "reasoning = 7.0",
      "[selection.weights]",
      "reasoning = 0.4",
      "",
      "[agents.build]",
      "min_capability = 7.4",
      "[agents.build.axes]",
      "code = 6.1",
      "",
      "[providers.opencode-go]",
      "cost_multiplier = 0.5",
      "",
    ].join("\n"),
    [
      "[agents.build]",
      "min_capability = 7.6",
      "[agents.build.axes]",
      "code = 6.3",
      "",
    ].join("\n"),
  );
  try {
    const machine = loadMachineConfig(layout);
    assert.equal(machine.selection.tier, "paid");
    assert.equal(machine.providers["opencode-go"].costMultiplier, 0.5);

    const policy = loadPolicy(layout);
    assert.equal(policy.agents.general.minCapability, 7.2);
    assert.equal(policy.agents.general.minContext, 30_000);
    assert.deepEqual(policy.agents.general.minAxes, { reasoning: 7 });
    assert.deepEqual(policy.agents.general.axisWeights, { reasoning: 0.4 });

    assert.equal(policy.agents.build.minCapability, 7.6, "repo wins on the composite");
    assert.deepEqual(policy.agents.build.minAxes, { reasoning: 7, code: 6.3 }, "axes merge per axis");
    assert.equal(policy.agents.review.minCapability, 7.2, "global default applies to unnamed roles");
    assert.equal(DEFAULT_AGENT_POLICY.minCapability, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid tier and negative multiplier are rejected", () => {
  const badMode = setup('[selection]\ntier = "fastest"\n');
  try {
    assert.throws(() => loadMachineConfig(badMode.layout), ConfigError);
  } finally {
    rmSync(badMode.root, { recursive: true, force: true });
  }
  const badCost = setup("[providers.p]\ncost_multiplier = -1\n");
  try {
    assert.throws(() => loadMachineConfig(badCost.layout), ConfigError);
  } finally {
    rmSync(badCost.root, { recursive: true, force: true });
  }
});
