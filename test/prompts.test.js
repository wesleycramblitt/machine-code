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
import { resolveAgent } from "../dist/agents/config.js";
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
  assert.ok(base.length <= 1_950, `base is ${base.length} chars`);
  for (const [role, delta] of Object.entries(deltas)) {
    const limit = role === "planner" ? 950 : 400;
    assert.ok(delta.length <= limit, `${role} delta is ${delta.length} chars`);
    assert.match(delta, /Stop/, `${role} has a stop condition`);
  }
  const total = base.length + Object.values(deltas).reduce((sum, delta) => sum + delta.length, 0);
  assert.ok(total <= 4_200, `base + deltas is ${total} chars`);
});

test("rendered prompts name the resolved tools and config", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-prompt-tools-"));
  const previous = process.env.MACHINE_CODE_HOME;
  process.env.MACHINE_CODE_HOME = home;
  try {
    const l = layout(root);
    for (const role of AGENT_NAMES) {
      const resolved = resolveAgent(l, role);
      assert.match(resolved.prompt, /Config: preset /, `${role} prompt lacks the config line`);
      assert.ok(
        resolved.prompt.includes(`Tools: ${resolved.def.tools.join(", ")}.`),
        `${role} prompt does not match its filtered tools`,
      );
      assert.doesNotMatch(resolved.prompt, /Tools: \./, `${role} prompt has an empty tool list`);
    }

    const planner = resolveAgent(l, "planner");
    assert.deepEqual(planner.def.tools, ["context", "read", "search", "ask", "issue", "issue_graph", "artifact", "skill"]);
    assert.ok(!planner.def.tools.includes("command"), "planner must not hold command");
    assert.ok(!planner.def.tools.includes("pr"), "planner must not hold pr");
    assert.match(planner.prompt, /Inspect tree/);
    assert.match(planner.prompt, /Reuse an Epic\/Feature; else create the chain/);
    assert.match(planner.prompt, /Tasks per feature/);
    assert.match(planner.prompt, /Ignore reserved anchors/);
    assert.match(planner.prompt, /do not write files/);
    assert.match(planner.prompt, /Read the named plan/);
    assert.match(planner.prompt, /context_files/);
    assert.match(planner.prompt, /## Context/);
    assert.match(planner.prompt, /repair legacy context/);
    assert.match(planner.prompt, /<=3 acceptance criteria/);
    assert.match(planner.prompt, /Split oversized Tasks/);
    assert.match(planner.prompt, /Create named issues/);
    assert.match(planner.prompt, /Verify plan ready/);
    assert.match(planner.prompt, /issue access create/);

    const build = resolveAgent(l, "build");
    assert.match(build.prompt, /Task packet/);
    assert.match(build.prompt, /if empty, stop/);
    assert.match(build.prompt, /3-line change plan/);
    assert.match(build.prompt, /Next must be an edit or needs_planning/);
    assert.match(build.prompt, /map\/sections/);

    const sudo = resolveAgent(l, "sudo");
    assert.match(sudo.prompt, /use its Deliverable and Acceptance/);

    const general = resolveAgent(l, "general");
    assert.deepEqual(general.def.tools, ["context", "read", "search", "ask", "skill"]);
    assert.ok(!general.def.tools.includes("command"), "general must not hold command");
    assert.match(general.prompt, /core:map with command/);

    for (const role of ["build", "review"]) {
      const resolved = resolveAgent(l, role);
      assert.match(resolved.prompt, /ask off/, `${role} must say ask is off`);
      assert.match(resolved.prompt, /stop and report/, `${role} must report blockers instead of asking`);
    }
  } finally {
    if (previous === undefined) delete process.env.MACHINE_CODE_HOME;
    else process.env.MACHINE_CODE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("every rendered prompt is concise and has the required rules", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-prompt-home-"));
  const previous = process.env.MACHINE_CODE_HOME;
  process.env.MACHINE_CODE_HOME = home;
  try {
    for (const role of AGENT_NAMES) {
      const def = agentDef(layout(root), role);
      assert.ok(def.prompt.length <= 2_900, `${role} prompt is ${def.prompt.length} chars`);
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
