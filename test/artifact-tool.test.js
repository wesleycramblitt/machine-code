/**
 * The artifact tool is the Planner's inventory surface. Provisioning is
 * deliberately refused until the human-approval path lands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { artifactTool } from "../dist/tools/artifact.js";
import { RunRecorder } from "../dist/state/runs.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mc-artifact-"));
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
  mkdirSync(join(layout.repoDir, "tools"), { recursive: true });
  mkdirSync(join(layout.repoDir, "scripts"), { recursive: true });
  mkdirSync(layout.home, { recursive: true });
  writeFileSync(
    join(layout.repoDir, "tools", "bench.toml"),
    'name = "bench"\ndescription = "Benchmark the parser"\ncommand = "scripts/bench.sh"\ntags = ["perf"]\n',
    "utf8",
  );
  writeFileSync(join(layout.repoDir, "scripts", "check.sh"), "#!/bin/sh\n# Check one module\necho ok\n", "utf8");
  const recorder = new RunRecorder(layout, {
    agent: "planner",
    mode: "",
    request: "plan",
    repoRoot: root,
  });
  return { root, layout, recorder };
}

test("artifact list and show expose repo tools and scripts", async () => {
  const { root, layout, recorder } = setup();
  try {
    const ctx = { layout, capabilities: ["artifact:provision"], recorder };
    const list = await artifactTool(ctx).execute("c1", { action: "list" });
    assert.equal(list.isError, undefined);
    assert.match(list.content[0].text, /bench/);
    assert.match(list.content[0].text, /check/);

    const show = await artifactTool(ctx).execute("c1", { action: "show", name: "bench" });
    assert.equal(show.isError, undefined);
    assert.match(show.content[0].text, /Benchmark the parser/);
    assert.match(show.content[0].text, /scripts\/bench\.sh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact provisioning writes tool manifests but not scripts", async () => {
  const { root, layout, recorder } = setup();
  try {
    const ctx = { layout, capabilities: ["artifact:provision"], recorder };
    const create = await artifactTool(ctx).execute("c1", {
      action: "create",
      name: "new-tool",
      description: "A new tool",
      command: "scripts/new-tool.sh",
      tags: ["test"],
    });
    assert.equal(create.isError, undefined);
    const manifest = readFileSync(join(layout.repoDir, "tools", "new-tool.toml"), "utf8");
    assert.match(manifest, /A new tool/);
    assert.match(manifest, /scripts\/new-tool\.sh/);

    const update = await artifactTool(ctx).execute("c1", {
      action: "update",
      name: "new-tool",
      description: "Updated tool",
    });
    assert.equal(update.isError, undefined);
    assert.match(readFileSync(join(layout.repoDir, "tools", "new-tool.toml"), "utf8"), /Updated tool/);

    const script = await artifactTool(ctx).execute("c1", { action: "create", name: "run", kind: "script" });
    assert.equal(script.isError, true);
    assert.match(script.content[0].text, /human approval/);

    const missing = await artifactTool(ctx).execute("c1", { action: "show", name: "missing" });
    assert.equal(missing.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
