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
