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

test("free usage limits cool every free offer, not just the first model", () => {
  const classified = classifyError(
    new Error(
      '429: {"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode; subscribe to OpenCode Go to keep going."}',
    ),
  );
  assert.equal(classified.kind, "free-limit");
  assert.equal(classified.retryable, true);
  assert.ok(classified.cooldownMs >= 30 * 60_000 - 1000);

  const state = empty();
  applyClassification(state, "opencode", "opencode/deepseek-v4.1-flash-free", classified, {
    freeKeys: ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"],
  });
  assert.equal(isModelCooling(state, "opencode/deepseek-v4.1-flash-free"), true);
  assert.equal(isModelCooling(state, "opencode/glm-5.3-flash-free"), true);
  assert.equal(isProviderCooling(state, "opencode"), false, "paid models stay usable");
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
