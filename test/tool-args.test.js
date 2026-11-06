import { test } from "node:test";
import assert from "node:assert/strict";

import { looksLikeSerializedArgs, repairToolArguments } from "../dist/tools/args.js";

const contextSchema = {
  type: "object",
  properties: {
    action: {},
    kind: {},
    text: {},
    refs: {},
    id: {},
  },
};

const searchSchema = {
  type: "object",
  properties: {
    mode: {},
    pattern: {},
    path: {},
    paths: {},
    limit: {},
  },
};

test("repairToolArguments recovers context note calls serialized as attributes", () => {
  const args = {
    action: 'note">\nkind: next">\nInvestigate run 20261105-041337-ig70 and TUI ask-answer capability.',
  };
  assert.equal(looksLikeSerializedArgs(args), true);
  assert.deepEqual(repairToolArguments(args, contextSchema), {
    action: "note",
    kind: "next",
    text: "Investigate run 20261105-041337-ig70 and TUI ask-answer capability.",
  });
});

test("repairToolArguments handles one-field-per-line attribute syntax", () => {
  const args = {
    action: 'note">\nkind">\nnext">\ntext">\nInvestigate run 20261105-041337-ig70 and TUI ask-answer capability.',
  };
  assert.deepEqual(repairToolArguments(args, contextSchema), {
    action: "note",
    kind: "next",
    text: "Investigate run 20261105-041337-ig70 and TUI ask-answer capability.",
  });
});

test("repairToolArguments recovers a search call", () => {
  const args = { mode: 'text">\npattern">\n20261105-041337-ig70' };
  assert.deepEqual(repairToolArguments(args, searchSchema), {
    mode: "text",
    pattern: "20261105-041337-ig70",
  });
});

test("repairToolArguments leaves ordinary arguments alone", () => {
  const args = { action: "note", kind: "next", text: "Edit src/tui.ts" };
  assert.equal(looksLikeSerializedArgs(args), false);
  assert.equal(repairToolArguments(args, contextSchema), args);
});

test("repairToolArguments drops null strings on non-string fields", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
      symbol: { type: "string" },
      mode: { anyOf: [{ type: "string", const: "a" }, { type: "string", const: "b" }] },
    },
  };
  const args = { path: "src/a.ts", limit: "null", symbol: "null", mode: "a" };
  assert.deepEqual(repairToolArguments(args, schema), { path: "src/a.ts", symbol: "null", mode: "a" });
});

test("repairToolArguments coerces numeric strings for number fields", () => {
  const schema = { type: "object", properties: { limit: { type: "number" }, path: {} } };
  assert.deepEqual(repairToolArguments({ limit: "60", path: "src/a.ts" }, schema), {
    limit: 60,
    path: "src/a.ts",
  });
  // Non-numeric strings are left for schema validation to name.
  const bad = { limit: "many", path: "src/a.ts" };
  assert.equal(repairToolArguments(bad, schema), bad);
});

test("repairToolArguments leaves string-typed and unknown-shape fields alone", () => {
  const schema = { type: "object", properties: { pattern: { type: "string" } } };
  const args = { pattern: "null" };
  assert.equal(repairToolArguments(args, schema), args);
  const shapeless = { limit: "null" };
  assert.equal(repairToolArguments(shapeless, { type: "object", properties: {} }), shapeless);
});
