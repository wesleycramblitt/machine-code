/**
 * Local .env files are a convenience layer: loaded before provider discovery,
 * never overriding exported shell values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFiles } from "../dist/env.js";

test("loads .env without overriding exported variables", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-env-"));
  const key = "MC_ENV_TEST_VALUE";
  try {
    writeFileSync(join(root, ".env"), `${key}=from-file\nMC_ENV_SECOND=second\n`, "utf8");
    process.env[key] = "from-shell";
    const loaded = loadEnvFiles(root);
    assert.ok(loaded.some((file) => file === join(root, ".env")));
    assert.equal(process.env[key], "from-shell");
    assert.equal(process.env.MC_ENV_SECOND, "second");
  } finally {
    delete process.env[key];
    delete process.env.MC_ENV_SECOND;
    rmSync(root, { recursive: true, force: true });
  }
});
