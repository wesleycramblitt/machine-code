import { test } from "node:test";
import assert from "node:assert/strict";

import { forkSettingsFromRun } from "../dist/tui/fork.js";

const defaults = {
  preset: "assistant",
  delegate: false,
  verification: "verified",
  artifactScripts: false,
  ask: true,
  approval: "human",
  ambiguity: "precise",
};

const row = (key, providerID, free) => ({
  key,
  providerID,
  id: key.split("/").slice(1).join("/"),
  pricing: { input: free ? 0 : 3, output: free ? 0 : 9 },
  free,
});

test("fork settings preserve a new run's saved selection and agent config", () => {
  const summary = {
    agent: "build",
    preset: "implement",
    verification: "redundant",
    ask: false,
    approval: "agent",
    ambiguity: "adaptive",
    settings: {
      tier: "paid",
      model: "p/strong",
      minFit: 7.5,
      minAxes: { reasoning: 7, code: 7, agentic: 7, general: 7 },
    },
    request: "implement the task",
    packetId: "demo",
  };
  const result = forkSettingsFromRun({
    summary,
    events: [{ t: "", type: "model_select", key: "p/strong" }],
    catalogue: { models: [row("p/strong", "p", false)] },
    defaults,
    configuredProviders: new Set(["p"]),
  });

  assert.equal(result.agent, "build");
  assert.equal(result.preset, "implement");
  assert.equal(result.verification, "redundant");
  assert.equal(result.ask, false);
  assert.equal(result.approval, "agent");
  assert.equal(result.ambiguity, "adaptive");
  assert.equal(result.tier, "paid");
  assert.equal(result.model, "p/strong");
  assert.equal(result.minFit, 7.5);
  assert.equal(result.floors, "strict");
  assert.equal(result.prompt, "implement the task");
  assert.equal(result.packet, "demo");
});

test("fork settings keep auto-selection when the snapshot has no model pin", () => {
  const summary = {
    agent: "research",
    settings: {
      tier: "free",
      minFit: 0,
      minAxes: { reasoning: 0, code: 0, agentic: 0, general: 0 },
    },
    request: "answer",
  };
  const result = forkSettingsFromRun({
    summary,
    events: [{ t: "", type: "model_select", key: "p/free" }],
    catalogue: { models: [row("p/free", "p", true)] },
    defaults,
  });

  assert.equal(result.model, undefined);
  assert.equal(result.tier, "free");
  assert.equal(result.floors, "off");
  assert.equal(result.minFit, 0);
});

test("old runs fall back to the first successful model and free tier", () => {
  const summary = {
    agent: "research",
    request: "old run",
  };
  const result = forkSettingsFromRun({
    summary,
    events: [
      { t: "", type: "model_select", error: "429", key: "p/bad" },
      { t: "", type: "model_select", key: "p/free" },
    ],
    catalogue: { models: [row("p/free", "p", true)] },
    defaults,
  });

  assert.equal(result.model, "p/free");
  assert.equal(result.tier, "free");
  assert.equal(result.floors, "role");
  assert.equal(result.minFit, undefined);
  assert.equal(result.preset, "assistant");
});

test("fork settings skip a model whose provider is not configured", () => {
  const summary = { agent: "research", request: "old run" };
  const result = forkSettingsFromRun({
    summary,
    events: [
      { t: "", type: "model_select", key: "p/offline" },
      { t: "", type: "model_select", key: "q/free" },
    ],
    catalogue: {
      models: [row("p/offline", "p", true), row("q/free", "q", true)],
    },
    defaults,
    configuredProviders: new Set(["q"]),
  });

  assert.equal(result.model, "q/free");
});

test("fork settings drop an unavailable model and validate bad values", () => {
  const summary = {
    agent: "not-an-agent",
    preset: "nope",
    verification: "nope",
    approval: "nope",
    ambiguity: "nope",
    settings: { tier: "paid", model: "p/gone" },
    request: "x",
  };
  const result = forkSettingsFromRun({
    summary,
    events: [],
    catalogue: { models: [] },
    defaults,
    configuredProviders: new Set(["p"]),
  });

  assert.equal(result.agent, "research");
  assert.equal(result.model, undefined);
  assert.equal(result.preset, "assistant");
  assert.equal(result.verification, "verified");
  assert.equal(result.approval, "human");
  assert.equal(result.ambiguity, "precise");
  assert.equal(result.tier, "paid");
});
