/**
 * Ollama is a keyless local provider. Discovery needs a running daemon, but
 * registration and provider status must work without network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProviderDefinitions } from "../dist/data.js";
import { createModelsCollection, providerStatuses } from "../dist/models.js";

test("ollama is registered as a keyless local provider", () => {
  const defs = loadProviderDefinitions();
  assert.equal(defs.ollama?.discovery, "ollama");
  assert.equal(defs.ollama?.keyless, true);
  assert.deepEqual(defs.ollama?.envKeys, []);
  assert.equal(defs.ollama?.baseUrl, "http://127.0.0.1:11434/v1");
  const status = providerStatuses(createModelsCollection()).find((entry) => entry.id === "ollama");
  assert.equal(status?.configured, true);
  assert.equal(status?.source, "local");
  assert.equal(status?.funded, false);
});
