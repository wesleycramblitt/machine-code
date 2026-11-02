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
      "min_fit = 7.1",
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
      "min_fit = 7.2",
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
    assert.equal(policy.agents.build.minFit, 7.2, "repo wins on the role-weighted floor");
    assert.deepEqual(policy.agents.build.minAxes, { reasoning: 7, code: 6.3 }, "axes merge per axis");
    assert.equal(policy.agents.review.minCapability, 7.2, "global default applies to unnamed roles");
    assert.equal(policy.agents.general.minFit, 6, "min_fit falls back to the built-in default");
    assert.equal(DEFAULT_AGENT_POLICY.minCapability, 0);
    assert.equal(DEFAULT_AGENT_POLICY.minFit, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("free floors parse and merge per axis across policy layers", () => {
  const { root, layout } = setup(
    [
      "[agents.build]",
      "min_fit = 6.0",
      "[agents.build.free]",
      "min_fit = 5.25",
      "[agents.build.free.axes]",
      "reasoning = 4.5",
      "",
    ].join("\n"),
    [
      "[agents.build.free]",
      "min_fit = 5.0",
      "[agents.build.free.axes]",
      "general = 2.5",
      "",
    ].join("\n"),
  );
  try {
    const policy = loadPolicy(layout);
    assert.equal(policy.agents.build.freeMinFit, 5.0, "repo free min_fit wins");
    assert.deepEqual(
      policy.agents.build.freeMinAxes,
      { reasoning: 4.5, code: 5, agentic: 5, general: 2.5 },
      "free axes merge with the defaults per axis",
    );
    assert.equal(policy.agents.general.freeMinFit, 5.5, "built-in free floor applies to unnamed roles");
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

test("issue access is a policy override layer", () => {
  const { root, layout } = setup('', '[agents.build]\nissue_access = "plan"\n');
  try {
    const policy = loadPolicy(layout);
    assert.equal(policy.agents.build.issueAccess, "plan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("availability probe settings parse durations and clamp the free budget", () => {
  const { root, layout } = setup(
    [
      "[availability]",
      'probe = "free-models"',
      'interval = "90s"',
      "timeout_ms = 2500",
      "free_completion_max_per_hour = -3",
      "",
    ].join("\n"),
  );
  try {
    const machine = loadMachineConfig(layout);
    assert.equal(machine.availability.probe, "free-models");
    assert.equal(machine.availability.intervalMs, 90_000);
    assert.equal(machine.availability.timeoutMs, 2_500);
    assert.equal(machine.availability.freeCompletionMaxPerHour, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("theme colors are machine-configurable and unknown keys are ignored", () => {
  const { root, layout } = setup('[theme]\nheader_bg = "#010203"\nfooter_bg = "#111111"\nback_bg = "#aa0000"\nnonsense = "#fff"\n');
  try {
    const machine = loadMachineConfig(layout);
    assert.equal(machine.theme.header_bg, "#010203");
    assert.equal(machine.theme.footer_bg, "#111111");
    assert.equal(machine.theme.back_bg, "#aa0000");
    assert.equal(machine.theme.nonsense, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
