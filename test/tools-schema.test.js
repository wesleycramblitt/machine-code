import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSchemaChars, toolSchemaCharsByName } from "../dist/tools/schema.js";

test("tool schema accounting counts every sent tool definition", () => {
  assert.equal(toolSchemaChars([]), 0);
  const one = toolSchemaChars(["read"]);
  const two = toolSchemaChars(["read", "search"]);
  assert.ok(one > 0);
  assert.ok(two > one);

  const map = toolSchemaCharsByName(["read", "issue"]);
  assert.ok(map.get("read") > 0);
  assert.ok(map.get("issue") > map.get("read"));
});
