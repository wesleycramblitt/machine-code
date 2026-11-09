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
    const limit = role === "research" || role === "engineer" ? 600 : 400;
    assert.ok(delta.length <= limit, `${role} delta is ${delta.length} chars`);
    assert.match(delta, /Stop/, `${role} has a stop condition`);
  }
  const total = base.length + Object.values(deltas).reduce((sum, delta) => sum + delta.length, 0);
  assert.ok(total <= 4_200, `base + deltas is ${total} chars`);
});

test("rendered prompts name the resolved tools and config", () => {  const home = mkdtempSync(join(tmpdir(), "mc-prompt-tools-"));
  const previous = process.env.MACHINE_CODE_HOME;
  process.env.MACHINE_CODE_HOME = home;
  try {
    const l = layout(root);
    for (const role of AGENT_NAMES) {
      const resolved = resolveAgent(l, role);
      assert.match(resolved.prompt, /Config: worktree (on|off) · verification \S+ · approval (human|agent)\./, `${role} prompt lacks the config line`);
      assert.doesNotMatch(resolved.prompt, /preset /, `${role} prompt must not mention presets`);
      assert.ok(
        resolved.prompt.includes(`Tools: ${resolved.def.tools.join(", ")}.`),
        `${role} prompt does not match its filtered tools`,
      );
      assert.doesNotMatch(resolved.prompt, /Tools: \./, `${role} prompt has an empty tool list`);
    }

    const research = resolveAgent(l, "research");
    assert.deepEqual(research.def.tools, ["context", "read", "map", "glob", "grep", "ask", "skill", "write"]);
    assert.ok(!research.def.tools.includes("command"), "research must not hold command");
    assert.match(research.prompt, /Turn one idea into detailed features or bugs/);
    assert.match(research.prompt, /issues\/ideas\//);
    assert.match(research.prompt, /issues\/ideas\/\.researched\//);
    assert.match(research.prompt, /YAML front-matter/);
    assert.match(research.prompt, /Curate references only when they carry the work/);

    const engineer = resolveAgent(l, "engineer");
    assert.match(engineer.prompt, /Deliver one issue in one run/);
    assert.match(engineer.prompt, /Scout:/);
    assert.match(engineer.prompt, /`glob`/);
    assert.match(engineer.prompt, /`grep`/);
    assert.match(engineer.prompt, /Outcome: completed/);
    assert.match(engineer.prompt, /reusable `scripts\/` helper/);

    const review = resolveAgent(l, "review");
    assert.match(review.prompt, /same worktree and branch the engineer used/);
    assert.match(review.prompt, /Verdict: approved/);

    for (const role of ["engineer", "review"]) {
      const resolved = resolveAgent(l, role);
      assert.match(resolved.prompt, /ask is available/, `${role} must describe ask availability`);
      assert.match(resolved.prompt, /wrong change is likely/, `${role} must scope asking to risky changes`);
    }
    const autonomous = resolveAgent(l, "engineer", { runOverrides: { ambiguity: "autonomous" } });
    assert.match(autonomous.prompt, /Do not ask/, "autonomous prompt must forbid asking");
    assert.match(autonomous.prompt, /stop and report/, "autonomous prompt must report blockers instead of asking");
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
