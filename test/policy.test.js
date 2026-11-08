/**
 * Effective policy precedence and editability:
 * built-in defaults ← machine [selection] ← machine [agents.<role>] ← repo policy.
 * Axis tables merge per axis so a repo override does not erase global floors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      "[agents.engineer]",
      "min_capability = 7.4",
      "min_fit = 7.1",
      "max_turns = 12",
      "[agents.engineer.axes]",
      "code = 6.1",
      "",
      "[providers.opencode-go]",
      "cost_multiplier = 0.5",
      "",
    ].join("\n"),
    [
      "[agents.engineer]",
      "min_capability = 7.6",
      "min_fit = 7.2",
      "[agents.engineer.axes]",
      "code = 6.3",
      "",
    ].join("\n"),
  );
  try {
    const machine = loadMachineConfig(layout);
    assert.equal(machine.selection.tier, "paid");
    assert.equal(machine.providers["opencode-go"].costMultiplier, 0.5);

    const policy = loadPolicy(layout);
    assert.equal(policy.agents.research.minCapability, 7.2);
    assert.equal(policy.agents.research.minContext, 30_000);
    assert.deepEqual(policy.agents.research.minAxes, { reasoning: 7 });
    assert.deepEqual(policy.agents.research.axisWeights, { reasoning: 0.4 });

    assert.equal(policy.agents.engineer.minCapability, 7.6, "repo wins on the composite");
    assert.equal(policy.agents.engineer.minFit, 7.2, "repo wins on the role-weighted floor");
    assert.equal(policy.agents.engineer.maxTurns, 12, "max_turns parses as a per-run cap");
    assert.deepEqual(policy.agents.engineer.minAxes, { reasoning: 7, code: 6.3 }, "axes merge per axis");
    assert.equal(policy.agents.review.minCapability, 7.2, "global default applies to unnamed roles");
    assert.equal(policy.agents.research.minFit, 6, "min_fit falls back to the built-in default");
    assert.equal(DEFAULT_AGENT_POLICY.minCapability, 0);
    assert.equal(DEFAULT_AGENT_POLICY.minFit, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("free floors parse and merge per axis across policy layers", () => {
  const { root, layout } = setup(
    [
      "[agents.engineer]",
      "min_fit = 6.0",
      "[agents.engineer.free]",
      "min_fit = 5.25",
      "[agents.engineer.free.axes]",
      "reasoning = 4.5",
      "",
    ].join("\n"),
    [
      "[agents.engineer.free]",
      "min_fit = 5.0",
      "[agents.engineer.free.axes]",
      "general = 2.5",
      "",
    ].join("\n"),
  );
  try {
    const policy = loadPolicy(layout);
    assert.equal(policy.agents.engineer.freeMinFit, 5.0, "repo free min_fit wins");
    assert.deepEqual(
      policy.agents.engineer.freeMinAxes,
      { reasoning: 4.5, code: 5, agentic: 5, general: 2.5 },
      "free axes merge with the defaults per axis",
    );
    assert.equal(policy.agents.research.freeMinFit, 5.5, "built-in free floor applies to unnamed roles");
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

test("agent overrides accept verification and worktree layers", () => {
  const { root, layout } = setup('', '[agents.engineer]\nverification = "verified"\nworktree = false\n');
  try {
    const policy = loadPolicy(layout);
    assert.equal(policy.agents.engineer.verification, "verified");
    assert.equal(policy.agents.engineer.worktree, false);
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

test("knowledge/index.md becomes the default knowledge index", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-knowledge-"));
  const machine = join(root, "config.toml");
  writeFileSync(machine, "", "utf8");
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge", "index.md"), "# Index\n", "utf8");
  try {
    const config = loadMachineConfig({ machineConfig: machine, repoRoot: root });
    assert.equal(config.context.knowledgeIndex, "knowledge/index.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit knowledge_index and empty string override the default", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-knowledge-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge", "index.md"), "# Index\n", "utf8");
  const machine = join(root, "config.toml");
  try {
    writeFileSync(machine, '[context]\nknowledge_index = "docs/kb.md"\n', "utf8");
    assert.equal(
      loadMachineConfig({ machineConfig: machine, repoRoot: root }).context.knowledgeIndex,
      "docs/kb.md",
    );
    writeFileSync(machine, '[context]\nknowledge_index = ""\n', "utf8");
    assert.equal(
      loadMachineConfig({ machineConfig: machine, repoRoot: root }).context.knowledgeIndex,
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
