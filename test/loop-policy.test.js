import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasTerminalLine,
  isQuestionRequest,
  readBucket,
} from "../dist/loop.js";

test("terminal lines are recognized where the role contract puts them", () => {
  assert.equal(hasTerminalLine("Result: done"), true);
  assert.equal(hasTerminalLine("blah\nOutcome: blocked"), true);
  assert.equal(hasTerminalLine("Let me check one more thing."), false);
});

test("a bug report is a change request, not a question", () => {
  assert.equal(isQuestionRequest("the cursor doesn't work when hovering providers"), false);
  assert.equal(isQuestionRequest("after collapsing rows you can't scroll to the last model"), false);
  assert.equal(isQuestionRequest("fix the login bug"), false);
  assert.equal(isQuestionRequest("what does this function do?"), true);
  assert.equal(isQuestionRequest("how is the cache key computed?"), true);
});

test("the read-repeat bucket ignores limit changes at the same start line", () => {
  assert.equal(readBucket({ path: "src/tui.ts", offset: 3500 }), "src/tui.ts@35");
  assert.equal(readBucket({ path: "src/tui.ts", offset: 3500, limit: 200 }), "src/tui.ts@35");
  assert.notEqual(readBucket({ path: "src/tui.ts", offset: 3500 }), readBucket({ path: "src/tui.ts", offset: 3600 }));
});
