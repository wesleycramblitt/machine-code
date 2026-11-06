import { test } from "node:test";
import assert from "node:assert/strict";
import { skillListItems, toolListItems, tokensForChars } from "../dist/tui/tools.js";

test("tool subtab lists core tools, issue access, and custom tools", () => {
  const items = toolListItems(
    ["read", "search", "issue", "artifact"],
    "create",
    [{ name: "bench", description: "Run benchmarks" }, { name: "lint", description: "Lint the tree" }],
    new Map([["bench", 512]]),
  );
  assert.deepEqual(items.map((item) => item.key), [
    "core-tool:read",
    "core-tool:search",
    "core-tool:issue",
    "core-tool:artifact",
    "tool:bench",
    "tool:lint",
  ]);
  assert.equal(items.find((item) => item.key === "core-tool:issue").text, "issue · GitHub issues · issues:create");
  assert.match(items.find((item) => item.key === "core-tool:search").text, /map, outline, search/);
  assert.match(items.find((item) => item.key === "tool:bench").text, /Run benchmarks/);
  const core = items.filter((item) => item.key.startsWith("core-tool:"));
  const custom = items.filter((item) => item.key.startsWith("tool:"));
  assert.ok(core.every((item) => item.exists && item.fixed && item.chars > 0));
  assert.ok(custom.every((item) => item.exists && !item.fixed));
  assert.equal(custom[0].chars, 512);
  assert.equal(custom[0].available, false);
  assert.equal(custom[1].chars, 0);
  assert.equal(custom[1].available, true);
  assert.match(custom[1].text, /available/);
});

test("skill list splits the aggregate description block into one row per skill", () => {
  const items = skillListItems(
    [
      { name: "reference", description: "research and curation" },
      { name: "requirements", description: "clarify ambiguous work" },
      { name: "systematic-debugging", description: "find the cause first" },
    ],
    300,
  );
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.key), [
    "skill:reference",
    "skill:requirements",
    "skill:systematic-debugging",
  ]);
  assert.equal(items.reduce((sum, item) => sum + item.chars, 0), 300);
  assert.ok(items.every((item) => item.chars > 0));
});

test("context item token estimates use the same chars/4 conversion", () => {
  assert.equal(tokensForChars(0), 0);
  assert.equal(tokensForChars(251), 63);
  assert.equal(tokensForChars(1000), 250);
  assert.equal(tokensForChars(1276), 319);
});

test("skill mode cycling never reorders rows: key list stays stable", () => {
  const items = skillListItems(
    [
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
      { name: "gamma", description: "third" },
    ],
    600,
  );
  const keys = items.map((item) => item.key);
  assert.deepEqual(keys, ["skill:alpha", "skill:beta", "skill:gamma"]);
});
