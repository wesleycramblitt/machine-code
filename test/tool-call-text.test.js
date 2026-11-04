import { test } from "node:test";
import assert from "node:assert/strict";

import { hasToolCallMarkup } from "../dist/state/tool-call-text.js";

test("detects tool-call markup returned as plain text", () => {
  const text =
    "I'll work this through methodically. Let me first survey what's already built." +
    "<tool_call>core:map --path src/context" +
    "<tool_call>core:map --path src/map" +
    "<tool_call>read<param_key>symbol</param_key><param_value>src/context/assemble.ts</param_value></tool_call>";
  assert.equal(hasToolCallMarkup(text), true);
});

test("detects a single opener with an argument marker", () => {
  assert.equal(hasToolCallMarkup("<tool_call>read<param_key>path</param_key>"), true);
});

test("detects provider XML leaked into tool arguments", () => {
  assert.equal(
    hasToolCallMarkup('{"mode":"files\\"> src/tui*.ts </rfl:parameter><|end|><|start|>assistant"}'),
    true,
  );
  assert.equal(hasToolCallMarkup('{"mode":"<|channel|>analysis"}'), true);
});

test("does not flag prose that mentions the tag once", () => {
  assert.equal(hasToolCallMarkup("The provider emitted a `<tool_call>` tag."), false);
  assert.equal(hasToolCallMarkup("Result: the parser does not accept tool-call markup."), false);
  assert.equal(hasToolCallMarkup(""), false);
});
