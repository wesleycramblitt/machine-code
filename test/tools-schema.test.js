import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSchemaChars, toolSchemaCharsByName } from "../dist/tools/schema.js";
import { coreTools } from "../dist/tools/index.js";
import { CORE_COMMANDS } from "../dist/commands/registry.js";

test("tool schema accounting counts every sent tool definition", () => {
  assert.equal(toolSchemaChars([]), 0);
  const one = toolSchemaChars(["read"]);
  const two = toolSchemaChars(["read", "map"]);
  assert.ok(one > 0);
  assert.ok(two > one);

  const map = toolSchemaCharsByName(["read", "command", "map"]);
  assert.ok(map.get("read") > 0);
  assert.ok(map.get("command") > 0);
  assert.ok(map.get("map") > 0);
  assert.equal(map.size, 3);
});

test("core tools prefer strict JSON-schema constrained sampling", () => {
  const tools = coreTools(
    { root: process.cwd(), commands: CORE_COMMANDS },
    ["read", "write", "edit", "map", "context", "ask"],
  );
  for (const tool of tools) {
    assert.deepEqual(
      tool.constrainedSampling,
      { type: "json_schema", strict: "prefer" },
      `${tool.name} must request strict schema sampling`,
    );
  }
  const context = tools.find((tool) => tool.name === "context");
  assert.deepEqual(context.parameters.properties.kind.enum, ["finding", "decision", "open", "next"]);
  const mapTool = tools.find((tool) => tool.name === "map");
  assert.ok(mapTool.parameters.properties.action, "map takes an action");
  assert.ok(mapTool.parameters.properties.pattern, "map takes a query");
  assert.ok(mapTool.parameters.properties.path, "map takes a scope");
});
