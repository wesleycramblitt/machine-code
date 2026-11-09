/**
 * Acceptance gates: declared verify commands win; an empty list falls back to
 * a non-blocking status check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGates } from "../dist/verify.js";

const packet = (acceptance) => ({ id: "x", goal: "g", context: [], constraints: [], acceptance });

test("declared verify commands become required gates", () => {
  const gates = resolveGates(packet([{ command: "core:status" }]));
  assert.deepEqual(gates.map((gate) => gate.command), ["core:status"]);
  assert.equal(gates[0].required, true);
});

test("no acceptance gates falls back to a non-blocking status gate", () => {
  const gates = resolveGates(packet([]));
  assert.deepEqual(gates.map((gate) => gate.command), ["core:status"]);
  assert.equal(gates[0].required, false);
});
