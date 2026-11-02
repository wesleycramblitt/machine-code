import { test } from "node:test";
import assert from "node:assert/strict";
import { toolListItems } from "../dist/tui/tools.js";

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
