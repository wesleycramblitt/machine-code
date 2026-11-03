/**
 * Availability probes: free metadata, opt-in free completion, and cooldown
 * reconciliation. No test may perform a paid completion probe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyProbeResult, probeTarget } from "../dist/availability/probe.js";
import { loadAvailability, saveAvailability } from "../dist/availability.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const metadataConfig = {
  probe: "metadata",
  intervalMs: 300_000,
  timeoutMs: 5_000,
  freeCompletionMaxPerHour: 2,
};

const freeTarget = {
  key: "openrouter/test-model",
  providerID: "openrouter",
  modelID: "test/model",
  free: true,
};

function state() {
  return { providers: {}, models: {}, freeProbeTimes: [] };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function withFetch(fn, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = fn;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = previous;
  });
}

test("metadata probe is free and confirms a listed OpenRouter model", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    const calls = [];
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return response({ data: [{ id: "test/model" }] });
    }, async () => {
      const result = await probeTarget(freeTarget, metadataConfig, state());
      assert.equal(result.status, "ready");
      assert.equal(result.source, "metadata");
    });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].url), /\/models\/user$/);
    assert.equal(calls[0].init.method, undefined);
    assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("OpenCode metadata probe uses the gateway model list", async () => {
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "test-key";
  try {
    const calls = [];
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return response({ object: "list", data: [{ id: "test-model" }] });
    }, async () => {
      const result = await probeTarget(
        {
          key: "opencode-go/test-model",
          providerID: "opencode-go",
          modelID: "test-model",
          free: true,
        },
        metadataConfig,
        state(),
      );
      assert.equal(result.status, "ready");
      assert.equal(result.source, "metadata");
    });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].url), /opencode\.ai\/inference\/go\/v1\/models$/);
    assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
});

test("metadata probe reports a model missing from the key's list", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    await withFetch(async () => response({ data: [{ id: "other/model" }] }), async () => {
      const result = await probeTarget(freeTarget, metadataConfig, state());
      assert.equal(result.status, "unavailable");
      assert.match(result.message, /not listed/);
    });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("429 becomes cooling and honors Retry-After", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    await withFetch(async () => response({ error: "rate limited" }, 429, { "retry-after": "60" }), async () => {
      const result = await probeTarget(freeTarget, metadataConfig, state());
      assert.equal(result.status, "cooling");
      assert.equal(result.retryAfterMs, 60_000);
    });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("paid rows never send a completion probe", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    const calls = [];
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return response({ data: [{ id: "test/model" }] });
    }, async () => {
      const result = await probeTarget({ ...freeTarget, free: false }, { ...metadataConfig, probe: "free-models" }, state());
      assert.equal(result.status, "ready");
      assert.equal(result.source, "metadata");
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(String(calls[0].url), /chat\/completions/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("free completion probe is opt-in, one token, and budgeted", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    const calls = [];
    const first = state();
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return String(url).endsWith("/chat/completions")
        ? response({ choices: [] })
        : response({ data: [{ id: "test/model" }] });
    }, async () => {
      const result = await probeTarget(freeTarget, { ...metadataConfig, probe: "free-models" }, first);
      assert.equal(result.status, "ready");
      assert.equal(result.source, "free-completion");
      assert.equal(first.freeProbeTimes.length, 1);
    });
    const completion = calls.find((call) => String(call.url).endsWith("/chat/completions"));
    assert.ok(completion);
    assert.equal(completion.init.method, "POST");
    assert.equal(JSON.parse(completion.init.body).max_tokens, 1);

    const exhausted = state();
    exhausted.freeProbeTimes = [Date.now(), Date.now()];
    const before = calls.length;
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return response({ data: [{ id: "test/model" }] });
    }, async () => {
      const result = await probeTarget(freeTarget, { ...metadataConfig, probe: "free-models" }, exhausted);
      assert.equal(result.source, "metadata");
      assert.match(result.message, /budget exhausted/);
    });
    assert.equal(calls.length, before + 1);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("metadata evidence does not clear a rate-limit cooldown", () => {
  const current = state();
  current.models[freeTarget.key] = {
    cooldownUntil: Date.now() + 60_000,
    tier: 2,
    lastErrorKind: "free-limit",
  };
  applyProbeResult(current, {
    ...freeTarget,
    status: "ready",
    source: "metadata",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  });
  assert.ok(current.models[freeTarget.key].cooldownUntil > Date.now());

  applyProbeResult(current, {
    ...freeTarget,
    status: "ready",
    source: "free-completion",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  });
  assert.equal(current.models[freeTarget.key].cooldownUntil, 0);
  assert.equal(current.models[freeTarget.key].lastErrorKind, undefined);
});

test("probe results clear or extend the model cooldown", () => {
  const current = state();
  current.models[freeTarget.key] = { cooldownUntil: Date.now() + 60_000, tier: 2 };
  applyProbeResult(current, {
    ...freeTarget,
    status: "ready",
    source: "metadata",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  });
  assert.equal(current.models[freeTarget.key].cooldownUntil, 0);
  assert.equal(current.models[freeTarget.key].tier, 0);

  applyProbeResult(current, {
    ...freeTarget,
    status: "cooling",
    source: "metadata",
    retryAfterMs: 120_000,
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  });
  assert.ok(current.models[freeTarget.key].cooldownUntil > Date.now() + 100_000);
  assert.equal(current.models[freeTarget.key].lastProbeResult, "cooling");
});

test("concurrent probes for the same model are coalesced", async () => {
  const config = { ...metadataConfig, probe: "off" };
  const first = probeTarget(freeTarget, config, state());
  const second = probeTarget(freeTarget, config, state());
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.status, "skipped");
});

test("availability state stores free probe timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-avail-"));
  try {
    const current = state();
    current.freeProbeTimes = [Date.now()];
    saveAvailability(root, current);
    const loaded = loadAvailability(root);
    assert.equal(loaded.freeProbeTimes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
