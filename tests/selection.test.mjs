/**
 * Selection consolidation tests. Every pick site (run preflight, in-loop
 * selector, TUI preview, models dry-run) goes through resolveSelectionContext;
 * these tests pin the three behaviors that broke when each site assembled
 * PickInput by hand: floors applied, stale rows filtered, dead pins loud.
 *
 * No provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSelectionContext,
  pickWithContext,
  pinViability,
  toPickInput,
} from "../dist/select.js";
import { resolveAgent } from "../dist/agents/config.js";
import { agentDef } from "../dist/agents.js";
import { layout } from "../dist/paths.js";
import { loadMachineConfig } from "../dist/config.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const l = layout(ROOT);
const machine = loadMachineConfig(l);

const scores = (reasoning, code, agentic, general, capability) => ({
  reasoning, code, agentic, general, capability,
});

const row = (key, providerID, id, s, extra = {}) => ({
  key,
  providerID,
  id,
  name: id,
  family: "test",
  releaseDate: "2026-01-01",
  context: 200000,
  maxOutput: 16000,
  reasoning: true,
  toolCall: true,
  image: false,
  capabilities: { reasoning: true, toolCall: true, image: false, input: ["text"], output: ["text"], contextWindow: 200000, maxOutputTokens: 16000 },
  kind: "chat",
  pricing: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  scores: scores(s[0], s[1], s[2], s[3], s[4]),
  ...extra,
});

// glm-flash-class row: fit ~6.16, below a 6.75 floor.
const weak = () => row("openrouter/weak/flash", "openrouter", "weak/flash",
  [6.76, 5.85, 6.57, 5.92, 6.7]);
// Strong row: fit ~7.4.
const strong = () => row("openrouter/deep/v4", "openrouter", "deep/v4",
  [9.13, 7.21, 6.2, 5.39, 8.0]);
// Stale row: best fit, but gone from the runtime.
const stale = () => row("openrouter/gone/model", "openrouter", "gone/model",
  [9.5, 9.5, 9.5, 9.5, 9.5]);

const parts = (catalogue, extra = {}) => ({
  agent: "engineer",
  machine,
  catalogue,
  configuredProviders: new Set(["openrouter"]),
  fundedProviders: new Set(["openrouter"]),
  contextChars: 16000,
  ...extra,
});

describe("resolveSelectionContext", () => {
  it("applies floors onto a copy of the role def", () => {
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine,
      floors: { minFit: 6.75, minAxes: { code: 6.0 } },
    });
    assert.equal(ctx.def.minFit, 6.75);
    assert.equal(ctx.def.minAxes.code, 6.0);
    // Role default untouched.
    assert.notEqual(agentDef(l, "engineer").minFit, 6.75);
  });

  it("passes def through untouched when given", () => {
    const def = agentDef(l, "engineer");
    const ctx = resolveSelectionContext({ role: "engineer", layout: l, machine, def });
    assert.equal(ctx.def, def);
    assert.deepEqual(ctx.floors, {});
  });

  it("carries tier and pin", () => {
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine,
      tier: "local", pin: { model: "ollama/qwen3:27b" },
    });
    assert.equal(ctx.tier, "local");
    assert.equal(ctx.requireModel, "ollama/qwen3:27b");
  });
});

describe("pickWithContext floors", () => {
  it("rejects a below-floor model the role default would accept", () => {
    const catalog = [weak(), strong()];
    const plain = pickWithContext(
      resolveSelectionContext({ role: "engineer", layout: l, machine }),
      parts(catalog),
    );
    assert.ok(!("error" in plain));
    const floored = pickWithContext(
      resolveSelectionContext({ role: "engineer", layout: l, machine, floors: { minFit: 6.75 } }),
      parts(catalog),
    );
    assert.ok(!("error" in floored));
    assert.equal(floored.selected.key, "openrouter/deep/v4");
  });
});

describe("pickWithContext runtime filter", () => {
  it("selects a stale row without the filter", () => {
    const result = pickWithContext(
      resolveSelectionContext({ role: "engineer", layout: l, machine }),
      parts([weak(), stale()]),
    );
    assert.ok(!("error" in result));
    assert.equal(result.selected.key, "openrouter/gone/model");
  });

  it("skips a stale row with the filter", () => {
    const result = pickWithContext(
      resolveSelectionContext({
        role: "engineer", layout: l, machine,
        hasRuntimeModel: (providerID, id) => id !== "gone/model",
      }),
      parts([weak(), stale()]),
    );
    assert.ok(!("error" in result));
    assert.equal(result.selected.key, "openrouter/weak/flash");
  });
});

describe("pinViability", () => {
  it("ok:true without a pin", () => {
    const ctx = resolveSelectionContext({ role: "engineer", layout: l, machine });
    assert.deepEqual(pinViability(ctx, parts([weak()])), { ok: true });
  });

  it("no-match pin names the key", () => {
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine, pin: { model: "no-such-model" },
    });
    const v = pinViability(ctx, parts([weak()]));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("no-match"));
  });

  it("tier-clashed pin fails loud with a hint", () => {
    const local = row("ollama/qwen3:27b", "ollama", "qwen3:27b", [6, 6, 6, 6, 6]);
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine, tier: "paid", pin: { model: "ollama/qwen3:27b" },
    });
    const v = pinViability(ctx, parts([local, weak()]));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("local-model"));
    assert.match(v.hint, /--tier local/);
  });

  it("stale pin fails loud with a refresh hint", () => {
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine,
      pin: { model: "openrouter/gone/model" },
      hasRuntimeModel: (providerID, id) => id !== "gone/model",
    });
    const v = pinViability(ctx, parts([stale(), weak()]));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.includes("not-in-runtime-catalog"));
    assert.match(v.hint, /catalogue refresh/);
  });

  it("below-floor pin stays ok (fallback path preserved)", () => {
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine,
      floors: { minFit: 9.9 }, pin: { model: "openrouter/weak/flash" },
    });
    assert.deepEqual(pinViability(ctx, parts([weak(), strong()])), { ok: true });
  });

  it("toPickInput carries tier, pin, and predicate", () => {
    const runtime = () => true;
    const ctx = resolveSelectionContext({
      role: "engineer", layout: l, machine,
      tier: "local", pin: { model: "m", provider: "p" }, hasRuntimeModel: runtime,
    });
    const input = toPickInput(ctx, parts([]));
    assert.equal(input.tier, "local");
    assert.equal(input.requireModel, "m");
    assert.equal(input.requireProvider, "p");
    assert.equal(input.hasRuntimeModel, runtime);
    assert.equal(input.agentDef.minFit, 6.0);
  });
});

describe("resolveAgent floors", () => {
  it("overrides the role def and keeps tools", () => {
    const resolved = resolveAgent(l, "engineer", {
      machineOverrides: machine.agents.engineer,
      floors: { minFit: 6.75 },
    });
    assert.equal(resolved.def.minFit, 6.75);
    assert.ok(resolved.def.tools.includes("finish"));
    assert.ok(resolved.def.tools.includes("inspect"));
  });
});
