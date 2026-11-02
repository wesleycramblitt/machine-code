/**
 * Prompt lint: one shared base, short role deltas, no stale rules, and a
 * consistent efficient shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AGENT_NAMES, agentDef } from "../dist/agents.js";
import { layout } from "../dist/paths.js";

const root = process.cwd();
const base = readFileSync(join(root, "data/prompts/base.md"), "utf8").trim();
const deltas = Object.fromEntries(
  AGENT_NAMES.map((role) => {
    const text = readFileSync(join(root, "data/agents", `${role}.toml`), "utf8");
    const prompt = /prompt = '''(.*?)'''/s.exec(text)?.[1]?.trim() ?? "";
    return [role, prompt];
  }),
);

test("base and role deltas stay small", () => {
  assert.ok(base.length <= 1_500, `base is ${base.length} chars`);
  for (const [role, delta] of Object.entries(deltas)) {
    assert.ok(delta.length <= 300, `${role} delta is ${delta.length} chars`);
    assert.match(delta, /Stop/, `${role} has a stop condition`);
  }
  const total = base.length + Object.values(deltas).reduce((sum, delta) => sum + delta.length, 0);
  assert.ok(total <= 2_400, `base + deltas is ${total} chars`);
});

test("every rendered prompt is concise and has the required rules", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-prompt-home-"));
  const previous = process.env.MACHINE_CODE_HOME;
  process.env.MACHINE_CODE_HOME = home;
  try {
    for (const role of AGENT_NAMES) {
      const def = agentDef(layout(root), role);
      assert.ok(def.prompt.length <= 1_800, `${role} prompt is ${def.prompt.length} chars`);
      for (const required of ["run-state", "core:map", "context note", "ASD-STE100", "Result:", "Evidence:"]) {
        assert.ok(def.prompt.includes(required), `${role} prompt lacks ${required}`);
      }
      assert.doesNotMatch(def.prompt, /six tools/i);
      assert.doesNotMatch(def.prompt, /max(?:imum)?\s+\d+\s+(?:turns|calls)/i);
      assert.doesNotMatch(def.prompt, /1-2 tool calls/i);
    }
  } finally {
    if (previous === undefined) delete process.env.MACHINE_CODE_HOME;
    else process.env.MACHINE_CODE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
