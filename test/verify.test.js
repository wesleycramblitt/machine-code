/**
 * Acceptance gates: declared verify commands win; an empty list falls back to
 * the repo's compile/test profiles, then to a non-blocking status check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGates } from "../dist/verify.js";

const packet = (acceptance) => ({ id: "x", goal: "g", context: [], constraints: [], acceptance });

test("declared verify commands become required gates", () => {
  const gates = resolveGates(packet([{ command: "typescript:test" }]), new Map());
  assert.deepEqual(gates.map((gate) => gate.command), ["typescript:test"]);
  assert.equal(gates[0].required, true);
});

test("an empty verify list uses the compile and test profile gates", () => {
  const commands = new Map([
    ["typescript:typecheck", {}],
    ["typescript:test", {}],
  ]);
  const gates = resolveGates(packet([]), commands);
  assert.deepEqual(gates.map((gate) => gate.command), ["typescript:typecheck", "typescript:test"]);
  assert.ok(gates.every((gate) => gate.required));
});

test("no profile commands falls back to a non-blocking status gate", () => {
  const gates = resolveGates(packet([]), new Map());
  assert.deepEqual(gates.map((gate) => gate.command), ["core:status"]);
  assert.equal(gates[0].required, false);
});
