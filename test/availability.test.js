/**
 * Provider health: rate-limit classification and tier-scheduled cooldowns.
 * A 429 carries cooldownMs 0 ("use the tier schedule"), so the caller must not
 * skip cooling it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  applyClassification,
  loadAvailability,
  isProviderCooling,
  isModelCooling,
  isProviderDisabled,
  clearModelCooldown,
  clearFreeProviderCooldowns,
  resetModelTier,
  resetProviderTier,
  saveAvailability,
} from "../dist/availability.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const empty = () => ({ providers: {}, models: {} });

test("429 classifies as a retryable rate limit and still cools the target", () => {
  const model = classifyError(new Error("429 Too Many Requests"));
  assert.equal(model.kind, "rate-limit-model");
  assert.equal(model.retryable, true);
  assert.equal(model.cooldownMs, 0);
  const state = empty();
  applyClassification(state, "opencode-go", "opencode-go/gpt-5", model);
  assert.equal(isModelCooling(state, "opencode-go/gpt-5"), true);

  const provider = classifyError(new Error("provider rate limit exceeded for organization"));
  assert.equal(provider.kind, "rate-limit-provider");
  assert.equal(provider.target, "provider");
  const state2 = empty();
  applyClassification(state2, "opencode-go", "opencode-go/gpt-5", provider);
  assert.equal(isProviderCooling(state2, "opencode-go"), true);
});

test("free usage limits cool only the model unless the error names all free offers", () => {
  const classified = classifyError(
    new Error(
      '429: {"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode; subscribe to OpenCode Go to keep going."}',
    ),
  );
  assert.equal(classified.kind, "free-limit");
  assert.equal(classified.target, "model");
  assert.equal(classified.retryable, true);
  assert.ok(classified.cooldownMs >= 30 * 60_000 - 1000);

  const state = empty();
  applyClassification(state, "opencode", "opencode/deepseek-v4.1-flash-free", classified, {
    freeKeys: ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"],
  });
  assert.equal(isModelCooling(state, "opencode/deepseek-v4.1-flash-free"), true);
  assert.equal(isModelCooling(state, "opencode/glm-5.3-flash-free"), false, "sibling free model stays usable");
  assert.equal(isProviderCooling(state, "opencode"), false, "paid models stay usable");

  const allFree = classifyError(
    new Error("429: Free usage limit reached for all free models on this provider"),
  );
  assert.equal(allFree.target, "free-models");
  const state2 = empty();
  applyClassification(state2, "opencode", "opencode/deepseek-v4.1-flash-free", allFree, {
    freeKeys: ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"],
  });
  assert.equal(isModelCooling(state2, "opencode/deepseek-v4.1-flash-free"), true);
  assert.equal(isModelCooling(state2, "opencode/glm-5.3-flash-free"), true);
});

test("OpenRouter upstream provider errors cool the model, not the provider", () => {
  const error = classifyError(
    new Error(
      '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"xingchen-agi/xing4.0-29b-a4b:free is temporarily rate-limited upstream.","provider_name":"Phala","limit_source":"upstream_provider_shared_pool"}}',
    ),
  );
  assert.equal(error.kind, "rate-limit-model");
  assert.equal(error.target, "model");
  const state = empty();
  applyClassification(state, "openrouter", "openrouter/xingchen-agi/xing4.0-29b-a4b:free", error);
  assert.equal(isModelCooling(state, "openrouter/xingchen-agi/xing4.0-29b-a4b:free"), true);
  assert.equal(isProviderCooling(state, "openrouter"), false, "other OpenRouter free models stay usable");
});

test("repeated rate limits escalate the cooldown tier", () => {
  const state = empty();
  const classified = classifyError(new Error("rate limit exceeded"));
  applyClassification(state, "p", "p/m", classified);
  const first = state.models["p/m"].cooldownUntil - Date.now();
  applyClassification(state, "p", "p/m", classified);
  const second = state.models["p/m"].cooldownUntil - Date.now();
  assert.equal(state.models["p/m"].tier, 2);
  assert.ok(second > first, "second cooldown is longer");

  clearModelCooldown(state, "p/m");
  state.models["p/m"].tier = 0;
});

test("410 Gone is an EOL model: cooled for a week, retryable once", () => {
  const eol = classifyError(
    new Error('410 {"title":"Gone","detail":"The model has reached its end of life and is no longer available."}'),
  );
  assert.equal(eol.kind, "missing-model");
  assert.equal(eol.retryable, true);
  assert.equal(eol.target, "model");
  assert.ok(eol.cooldownMs >= 7 * 24 * 60 * 60_000 - 1000);
  const state = empty();
  applyClassification(state, "nvidia", "nvidia/z-ai/glm-5.3", eol);
  assert.equal(isModelCooling(state, "nvidia/z-ai/glm-5.3"), true);
});

test("an upstream unavailable model is cooled for an hour, not one minute", () => {
  const unavailable = classifyError(
    new Error('400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}'),
  );
  assert.equal(unavailable.kind, "missing-model");
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.target, "model");
  assert.ok(unavailable.cooldownMs >= 60 * 60_000 - 1000);
  const state = empty();
  applyClassification(state, "opencode-go", "opencode-go/minimax", unavailable);
  assert.equal(isModelCooling(state, "opencode-go/minimax"), true);
});

test("funds errors disable the provider; auth marks needs-auth", () => {
  const funds = classifyError(new Error("insufficient funds"), 402);
  assert.equal(funds.disableProvider, true);
  const state = empty();
  applyClassification(state, "p", "p/m", funds);
  assert.equal(isProviderDisabled(state, "p"), true);

  const auth = classifyError(new Error("invalid api key"), 401);
  const state2 = empty();
  applyClassification(state2, "q", "q/m", auth);
  assert.equal(state2.providers.q.needsAuth, true);
});

test("free provider cooldowns reset at run start", () => {
  const state = empty();
  state.providers.opencode = { cooldownUntil: Date.now() + 60_000, tier: 3 };
  clearFreeProviderCooldowns(state, ["opencode"]);
  assert.equal(isProviderCooling(state, "opencode"), false);
  assert.equal(state.providers.opencode.tier, 0);
});

test("availability state round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-avail-"));
  try {
    const state = empty();
    applyClassification(state, "p", "p/m", classifyError(new Error("429")));
    saveAvailability(dir, state);
    const loaded = loadAvailability(dir);
    assert.ok(loaded.models["p/m"].cooldownUntil > Date.now());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("success resets escalated model and provider tiers", () => {
  const state = empty();
  state.models["p/m"] = { cooldownUntil: Date.now() + 60_000, tier: 4 };
  state.providers.p = { cooldownUntil: Date.now() + 3_600_000, tier: 5 };
  resetModelTier(state, "p/m");
  resetProviderTier(state, "p");
  assert.equal(state.models["p/m"].tier, 0);
  assert.equal(state.providers.p.tier, 0);
  // Missing entries are a no-op, not a crash.
  resetModelTier(state, "q/nonexistent");
  resetProviderTier(state, "q");
});
