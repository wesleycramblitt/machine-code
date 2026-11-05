/**
 * The skill tool is the on-demand path for SKILL.md bodies. Descriptions are
 * always in context; bodies load only when the agent calls show. Excluded
 * skills are invisible here, mirroring assembly and the composer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { skillTool } from "../dist/tools/skill.js";
import { RunRecorder } from "../dist/state/runs.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mc-skill-"));
  const layout = {
    home: join(root, "home"),
    machineConfig: "",
    curation: "",
    catalogueFile: "",
    repoRoot: root,
    repoDir: join(root, ".machine_code"),
    localDir: join(root, ".machine_code", "local"),
    policyFile: "",
    runsDir: join(root, ".machine_code", "local", "runs"),
  };
  mkdirSync(join(layout.repoDir, "skills", "clean-code"), { recursive: true });
  writeFileSync(
    join(layout.repoDir, "skills", "clean-code", "SKILL.md"),
    "---\nname: clean-code\ndescription: write clean code\n---\n# Clean\nAlways clean up.\n",
    "utf8",
  );
  const recorder = new RunRecorder(layout, {
    agent: "build",
    mode: "",
    request: "build",
    repoRoot: root,
  });
  return { root, layout, recorder };
}

test("skill list and show expose installed skill bodies", async () => {
  const { root, layout, recorder } = setup();
  try {
    const ctx = { layout, recorder, excluded: new Set() };
    const list = await skillTool(ctx).execute("c1", { action: "list" });
    assert.equal(list.isError, undefined);
    assert.match(list.content[0].text, /clean-code/);

    const show = await skillTool(ctx).execute("c1", { action: "show", name: "clean-code" });
    assert.equal(show.isError, undefined);
    assert.match(show.content[0].text, /Always clean up/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill show refuses excluded and unknown skills", async () => {
  const { root, layout, recorder } = setup();
  try {
    const ctx = { layout, recorder, excluded: new Set(["clean-code"]) };
    const list = await skillTool(ctx).execute("c1", { action: "list" });
    assert.equal(list.isError, undefined);
    assert.doesNotMatch(list.content[0].text, /clean-code/);

    const refused = await skillTool(ctx).execute("c1", { action: "show", name: "clean-code" });
    assert.equal(refused.isError, true);

    const missing = await skillTool({ layout, recorder, excluded: new Set() }).execute("c1", {
      action: "show",
      name: "nope",
    });
    assert.equal(missing.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
