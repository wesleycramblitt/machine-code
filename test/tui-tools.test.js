import { test } from "node:test";
import assert from "node:assert/strict";
import { toolListItems, tokensForChars } from "../dist/tui/tools.js";

test("tool subtab lists core tools, issue access, and custom tools", () => {
  const items = toolListItems(
    ["read", "search", "issue", "artifact"],
    "create",
    [{ name: "bench", description: "Run benchmarks" }],
  );
  assert.deepEqual(items.map((item) => item.key), [
    "core-tool:read",
    "core-tool:search",
    "core-tool:issue",
    "core-tool:artifact",
    "custom-tool:bench",
  ]);
  assert.equal(items.find((item) => item.key === "core-tool:issue").text, "issue · GitHub issues · issues:create");
  assert.match(items.find((item) => item.key === "core-tool:search").text, /map, outline, search/);
  assert.match(items.find((item) => item.key === "custom-tool:bench").text, /Run benchmarks/);
  assert.ok(items.every((item) => item.chars === 0 && item.exists));
});

test("context item token estimates use the same chars/4 conversion", () => {
  assert.equal(tokensForChars(0), 0);
  assert.equal(tokensForChars(251), 63);
  assert.equal(tokensForChars(1000), 250);
  assert.equal(tokensForChars(1276), 319);
});
