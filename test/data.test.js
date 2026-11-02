/**
 * Data files are the source of truth: providers, funding defaults, roles,
 * presets, and prompts. Code must not carry a second copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProviderDefinitions, fundedProviderIds } from "../dist/data.js";
import { AGENT_NAMES, AGENT_META, agentDef, rolePreset } from "../dist/agents.js";
import { PRESETS, ROLE_PRESET } from "../dist/agents/config.js";

const layout = { repoDir: "/nonexistent/.machine_code" };

test("provider data defines funding, extras, and endpoints", () => {
  const defs = loadProviderDefinitions();
  assert.equal(defs.openrouter.funded, true);
  assert.equal(defs.opencode.funded, true);
  assert.equal(defs["opencode-go"].funded, true);
  assert.equal(defs.deepinfra.discovery, "openai-compatible");
  assert.equal(defs.deepinfra.baseUrl, "https://api.deepinfra.com/v1/openai");
  assert.deepEqual(defs.deepinfra.envKeys, ["DEEPINFRA_API_KEY"]);
  assert.equal(defs.nvidia.funded, undefined);
  assert.equal(defs.nvidia.disabled, true);
  assert.deepEqual(defs.anthropic.envKeys, ["ANTHROPIC_API_KEY"]);
});

test("machine funding overrides data in both directions", () => {
  const base = fundedProviderIds({});
  assert.ok(base.has("openrouter"));
  assert.ok(base.has("opencode-go"));
  assert.equal(base.has("nvidia"), false);

  const overridden = fundedProviderIds({
    openrouter: { funded: false },
    nvidia: { funded: true },
  });
  assert.equal(overridden.has("openrouter"), false);
  assert.equal(overridden.has("nvidia"), true);
});

test("roles, prompts, tools, and presets come from data", () => {
  assert.deepEqual([...AGENT_NAMES], ["general", "architect", "planner", "build", "review", "sudo"]);
  assert.equal(rolePreset("architect"), "orchestrate");
  assert.equal(rolePreset("planner"), "plan");
  assert.equal(ROLE_PRESET.build, "implement");
  assert.equal(PRESETS.orchestrate.delegate, true);
  assert.equal(PRESETS.assistant.issues, "disabled");

  const architect = agentDef(layout, "architect");
  assert.match(architect.prompt, /Architect agent/);
  assert.ok(architect.readonly);
  assert.ok(architect.tools.includes("task"));
  assert.deepEqual(AGENT_META.architect.modes, ["direct", "verified", "redundant"]);

  const planner = agentDef(layout, "planner");
  assert.match(planner.prompt, /Planner agent/);
  assert.equal(planner.issueAccess, "create");
  assert.ok(planner.tools.includes("issue"));
  assert.ok(!planner.tools.includes("write"));

  const build = agentDef(layout, "build");
  assert.match(build.prompt, /Build agent/);
  assert.equal(build.readonly, false);
  assert.ok(build.tools.includes("write"));
  assert.ok(build.tools.includes("edit"));
});
