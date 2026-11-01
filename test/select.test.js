/**
 * Selector behaviour: hard capability filters, per-axis floors, role-weighted
 * capability, and the score terms that decide a pick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pick, scoreCandidate, axisWeights, capabilityFit } from "../dist/select.js";
import { loadPolicy, ConfigError } from "../dist/config.js";

function axes(reasoning = 8, code = 8, agentic = 8, general = 8) {
  const raw = agentic * 0.34 + code * 0.3 + reasoning * 0.24 + general * 0.12;
  // Same calibration as catalogue/scoring.ts at a 128k context.
  const contextTerm = (128_000 / 400_000) * 10;
  const capability = Math.round((raw * 0.9 + contextTerm * 0.1) * 10) / 10;
  return { reasoning, code, agentic, general, capability };
}

function row(key, over = {}) {
  const [providerID, ...rest] = key.split("/");
  const scores = over.scores ?? axes();
  return {
    key,
    providerID,
    id: rest.join("/"),
    name: key,
    family: "",
    releaseDate: "2026-01-01",
    context: over.context ?? 128_000,
    maxOutput: 16_000,
    reasoning: true,
    toolCall: over.toolCall ?? true,
    image: false,
    kind: "chat",
    coding: true,
    canonicalID: null,
    pricing: over.pricing ?? { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
    benchmarks: null,
    scores,
    provenance: { metadata: "generated", benchmark: null, estimated: true, estimatedFields: [], curated: [] },
    ...over,
  };
}

const machine = {
  priceCaps: {},
  selection: { tier: "paid" },
  providers: {},
  vetoes: [],
  maxOutputTokens: undefined,
  defaultMode: undefined,
  notify: {},
  git: {},
  agents: {},
  issues: {},
  context: {},
};
const basePolicy = {
  minContext: 32_000,
  expectedOutputTokens: 2_000,
  minCapability: 7,
  toolCall: true,
};

function pickOne(rows, policy = basePolicy, extra = {}) {
  return pick({
    agent: "general",
    policy,
    machine,
    catalogue: rows,
    configuredProviders: new Set(rows.map((r) => r.providerID)),
    contextChars: 8_000,
    ...extra,
  });
}

test("minCapability is a hard filter", () => {
  const rows = [
    row("p/low", { scores: axes(5, 5, 5, 5) }),
    row("p/high", { scores: axes(9, 9, 9, 9) }),
  ];
  const result = pickOne(rows);
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "p/high");
  assert.ok(result.rejected.some((r) => r.key === "p/low" && r.reason === "below-min-capability"));
});

test("non-coding models (image/video/audio/guard) are rejected", () => {
  const chat = row("p/chat");
  const image = row("p/image", { kind: "image", coding: false });
  const result = pickOne([chat, image]);
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "p/chat");
  assert.ok(result.rejected.some((r) => r.key === "p/image" && r.reason === "non-coding-model"));
});

test("min_fit is role-weighted: build favors code/agentic over general/reasoning", () => {
  const policy = {
    ...basePolicy,
    minCapability: 0,
    minFit: 7.2,
    minAxes: { code: 6.5, agentic: 6.5, reasoning: 5.5, general: 3 },
  };
  const specialist = row("p/specialist", { scores: axes(5.5, 8.5, 8.5, 3.5) });
  const generalist = row("p/generalist", { scores: axes(8, 6.5, 6.5, 6) });
  const result = pickOne([specialist, generalist], policy, { agent: "build" });
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "p/specialist");
  assert.ok(result.rejected.some((r) => r.key === "p/generalist" && r.reason === "below-min-fit"));
});

test("per-axis floors reject spiky models even when the composite passes", () => {
  const spiky = row("p/spiky", { scores: axes(9.5, 4.5, 9, 9) }); // composite ok, code weak
  const balanced = row("p/balanced", { scores: axes(8, 8, 8, 8) });
  assert.ok(spiky.scores.capability >= 7, "composite clears the floor");
  const policy = { ...basePolicy, minAxes: { code: 6 } };
  const result = pickOne([spiky, balanced], policy);
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "p/balanced");
  assert.ok(result.rejected.some((r) => r.key === "p/spiky" && r.reason === "below-min-code"));
});

test("role weights change the winner between code-heavy and reasoning-heavy models", () => {
  const coder = row("p/coder", { scores: axes(5.5, 9.5, 9, 5) });
  const thinker = row("p/thinker", { scores: axes(10, 6, 7, 10) });
  const buildPolicy = { ...basePolicy, axisWeights: { code: 0.5, agentic: 0.3, reasoning: 0.15, general: 0.05 } };
  const archPolicy = { ...basePolicy, axisWeights: { reasoning: 0.5, agentic: 0.3, code: 0.15, general: 0.05 } };
  assert.equal(pickOne([coder, thinker], buildPolicy, { agent: "build" }).selected.key, "p/coder");
  assert.equal(pickOne([coder, thinker], archPolicy, { agent: "architect" }).selected.key, "p/thinker");
});

test("capability is a gradient above the floor: equal price prefers the better model", () => {
  const weak = row("p/weak", { scores: axes(7.5, 7.5, 7.5, 7.5), pricing: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } });
  const strong = row("p/strong", { scores: axes(9, 9, 9, 9), pricing: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } });
  const result = pickOne([weak, strong]);
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "p/strong");

  const input = {
    agent: "general",
    policy: basePolicy,
    machine,
    catalogue: [weak, strong],
    configuredProviders: new Set(["p"]),
    contextChars: 8_000,
  };
  const estimate = { inputTokens: 2_000, outputTokens: 2_000 };
  const a = scoreCandidate(weak, input, estimate);
  const b = scoreCandidate(strong, input, estimate);
  assert.ok(b.fit > a.fit);
  assert.ok(b.terms.capability < a.terms.capability, "better fit is a smaller penalty");
});

test("a materially better model can beat a cheaper one", () => {
  const cheap = row("p/cheap", {
    scores: axes(7.5, 7.5, 7.5, 7.5),
    pricing: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
  });
  const better = row("p/better", {
    scores: axes(9.8, 9.8, 9.8, 9.8),
    pricing: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(pickOne([cheap, better]).selected.key, "p/better");
});

test("hard filters: tool support, min context, provider, pin", () => {
  const noTools = row("p/no-tools", { toolCall: false });
  const small = row("p/small", { context: 16_000 });
  const big = row("p/big");

  const toolResult = pickOne([noTools, small, big]);
  assert.ok(!("error" in toolResult));
  assert.equal(toolResult.selected.key, "p/big");
  assert.ok(toolResult.rejected.some((r) => r.key === "p/no-tools" && r.reason === "no-tool-support"));
  assert.ok(toolResult.rejected.some((r) => r.key === "p/small" && r.reason === "below-min-context"));

  const pinned = pickOne([row("p/a"), row("p/b")], basePolicy, { requireModel: "b" });
  assert.ok(!("error" in pinned));
  assert.equal(pinned.selected.key, "p/b");

  const other = pickOne([big], basePolicy, { requireProvider: "q" });
  assert.ok("error" in other);
});

test("ties go to the lexicographically smaller key", () => {
  const a = row("p/aaa");
  const b = row("p/zzz");
  const result = pickOne([a, b]);
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "p/aaa");
});

test("axis weights default per role and normalize policy overrides", () => {
  const build = axisWeights("build", basePolicy);
  assert.equal(build.code, 0.4);
  assert.equal(build.agentic, 0.35);
  const custom = axisWeights("build", {
    ...basePolicy,
    axisWeights: { code: 3, reasoning: 1, agentic: 0, general: 0 },
  });
  assert.equal(custom.code, 0.75);
  assert.equal(custom.reasoning, 0.25);
  assert.equal(custom.agentic, 0);

  const fit = capabilityFit({ reasoning: 8, code: 6, agentic: 7, general: 5 }, { reasoning: 0, code: 0.5, agentic: 0.5, general: 0 });
  assert.equal(fit, 6.5);
});

test("policy.toml parses axis floors and weights, and rejects out-of-range values", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-policy-"));
  try {
    const file = join(dir, "policy.toml");
    writeFileSync(
      file,
      [
        "[agents.build]",
        "min_capability = 7.3",
        "[agents.build.axes]",
        "code = 6",
        "agentic = 5.5",
        "[agents.build.weights]",
        "code = 0.6",
        "reasoning = 0.4",
        "",
      ].join("\n"),
    );
    const policy = loadPolicy({ policyFile: file });
    assert.equal(policy.agents.build.minCapability, 7.3);
    assert.deepEqual(policy.agents.build.minAxes, { code: 6, agentic: 5.5 });
    assert.deepEqual(policy.agents.build.axisWeights, { code: 0.6, reasoning: 0.4 });
    assert.equal(policy.agents.general.minCapability, 0, "neutral floor defaults to off");
    assert.equal(policy.agents.general.minFit, 6, "role-weighted floor uses the default");

    writeFileSync(file, "[agents.build.axes]\ncode = 11\n");
    assert.throws(() => loadPolicy({ policyFile: file }), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("free tier admits only zero-price rows; paid admits both", () => {
  const paid = row("p/paid", { pricing: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } });
  const free = row("p/free", {
    free: true,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const paidPick = pickOne([paid, free]);
  assert.ok(!("error" in paidPick));
  // Paid mode may choose a free model; it is simply the cheaper eligible row.
  assert.equal(paidPick.selected.key, "p/free");
  assert.equal(paidPick.tier, "paid");

  const onlyFree = pickOne([paid, free], basePolicy, { tier: "free" });
  assert.ok(!("error" in onlyFree));
  assert.equal(onlyFree.selected.key, "p/free");
  assert.ok(onlyFree.rejected.some((r) => r.key === "p/paid" && r.reason === "not-free"));

  const none = pickOne([paid], basePolicy, { tier: "free" });
  assert.ok("error" in none);
});

test("paid tier uses free rows but rejects unfunded paid providers", () => {
  const unfundedPaid = row("u/paid", {
    pricing: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
  });
  const fundedPaid = row("f/paid", {
    pricing: { input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0 },
  });
  const unfundedFree = row("u/free", {
    free: true,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const noFunding = pickOne([unfundedPaid, fundedPaid], basePolicy, {
    fundedProviders: new Set(["f"]),
  });
  assert.ok(!("error" in noFunding));
  assert.equal(noFunding.selected.key, "f/paid");
  assert.ok(noFunding.rejected.some((r) => r.key === "u/paid" && r.reason === "unfunded-provider"));

  const freeFromUnfunded = pickOne([unfundedPaid, unfundedFree], basePolicy, {
    fundedProviders: new Set(),
  });
  assert.ok(!("error" in freeFromUnfunded));
  assert.equal(freeFromUnfunded.selected.key, "u/free");
});

test("provider cost multipliers change the effective winner", () => {
  const a = row("a/m", { pricing: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } });
  const b = row("b/m", { pricing: { input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0 } });
  const discounted = { ...machine, providers: { a: { costMultiplier: 0.1 } } };
  const result = pickOne([a, b], basePolicy, { machine: discounted });
  assert.ok(!("error" in result));
  assert.equal(result.selected.key, "a/m", "0.1x list makes a/m cheaper than b/m");
});


