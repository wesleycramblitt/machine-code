/**
 * Cross-provider canonical resolution: direct providers publish bare ids while
 * benchmarks key by owner slug. Exact normalized matches must resolve; shared
 * tails must stay ambiguous instead of silently borrowing another owner's data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelSlug,
  buildCanonicalIndex,
  resolveCanonical,
} from "../dist/catalogue/canonical.js";

test("normalizeModelSlug folds punctuation, case, and version dots", () => {
  assert.equal(normalizeModelSlug("GPT-6 Astra"), "gpt-6-astra");
  assert.equal(normalizeModelSlug("claude-opus-5.5"), "claude-opus-5-5");
  assert.equal(normalizeModelSlug("openai/gpt_oss-120b"), "openai-gpt-oss-120b");
  assert.equal(normalizeModelSlug("  --qwen/qwen3.8-max--  "), "qwen-qwen3-8-max");
  assert.equal(
    normalizeModelSlug("deepseek-ai/DeepSeek-V4.1-Flash"),
    normalizeModelSlug("deepseek/deepseek-v4.1-flash"),
  );
  assert.equal(
    normalizeModelSlug("XiaomiMiMo/MiMo-V2.6-Flash"),
    normalizeModelSlug("xiaomi/mimo-v2.6-flash"),
  );
});

test("bare ids resolve to owner slugs, full keys resolve unchanged", () => {
  const index = buildCanonicalIndex([
    "openai/gpt-6-astra",
    "anthropic/claude-opus-5-5",
    "qwen/qwen3-8-max",
  ]);
  assert.equal(resolveCanonical(index, "gpt-6-astra"), "openai/gpt-6-astra");
  assert.equal(resolveCanonical(index, "GPT-6 Astra"), "openai/gpt-6-astra");
  assert.equal(resolveCanonical(index, "claude-opus-5.5"), "anthropic/claude-opus-5-5");
  assert.equal(resolveCanonical(index, "qwen3.8-max"), "qwen/qwen3-8-max");
  assert.equal(resolveCanonical(index, "openai/gpt-6-astra"), "openai/gpt-6-astra");
  assert.equal(resolveCanonical(index, "unknown-model"), undefined);
});

test("ambiguous tails are never guessed", () => {
  const index = buildCanonicalIndex(["openai/shared-model", "other/shared-model"]);
  assert.equal(resolveCanonical(index, "shared-model"), undefined);
  assert.equal(resolveCanonical(index, "openai/shared-model"), "openai/shared-model");
  assert.equal(resolveCanonical(index, "other/shared-model"), "other/shared-model");
});

test("bare and owner-qualified aliases resolve to the qualified key", () => {
  const index = buildCanonicalIndex(["claude-haiku-4-5", "anthropic/claude-haiku-4-5"]);
  assert.equal(resolveCanonical(index, "claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
  assert.equal(resolveCanonical(index, "anthropic/claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
});

test("same-identity aliases keep the first (benchmark-backed) spelling", () => {
  const index = buildCanonicalIndex(["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4.5"]);
  assert.equal(resolveCanonical(index, "claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
  assert.equal(resolveCanonical(index, "claude-haiku-4.5"), "anthropic/claude-haiku-4-5");
});

test("free offer suffixes resolve to the measured base model", () => {
  const index = buildCanonicalIndex(["deepseek/deepseek-v4-1-flash"]);
  assert.equal(resolveCanonical(index, "deepseek-v4.1-flash-free"), "deepseek/deepseek-v4-1-flash");
  assert.equal(resolveCanonical(index, "DeepSeek V4.1 Flash Free"), "deepseek/deepseek-v4-1-flash");
  assert.equal(resolveCanonical(index, "xingchen-agi/xing4.0-29b-a4b:free"), undefined);
});

test("later duplicate keys do not create a false ambiguity", () => {
  const index = buildCanonicalIndex(["openai/gpt-6-astra", "openai/gpt-6-astra"]);
  assert.equal(resolveCanonical(index, "gpt-6-astra"), "openai/gpt-6-astra");
});
