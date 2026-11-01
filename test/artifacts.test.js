/**
 * Reusable repo/machine artifacts: manifest discovery, script discovery,
 * resolution by name/path, and precedence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listArtifacts, resolveArtifact, artifactSummary, artifactExists } from "../dist/artifacts/registry.js";

function fakeLayout(root) {
  return {
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
}

test("repo manifests and plain scripts are discovered and resolvable", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-artifacts-"));
  try {
    const layout = fakeLayout(root);
    mkdirSync(join(layout.repoDir, "tools"), { recursive: true });
    mkdirSync(join(layout.repoDir, "scripts"), { recursive: true });
    writeFileSync(
      join(layout.repoDir, "tools", "bench.toml"),
      'name = "bench"\ndescription = "fast performance smoke"\ncommand = "scripts/bench.sh --quick"\ntags = ["perf"]\nreadonly = true\n',
      "utf8",
    );
    writeFileSync(join(layout.repoDir, "scripts", "release-check.sh"), "#!/usr/bin/env bash\n# verify the release manifest\n", "utf8");
    const all = listArtifacts(layout);
    assert.deepEqual(all.map((artifact) => artifact.name).sort(), ["bench", "release-check"]);
    const bench = resolveArtifact(layout, "bench");
    assert.equal(bench.description, "fast performance smoke");
    assert.equal(bench.kind, "tool");
    assert.equal(bench.origin, "repo");
    assert.equal(resolveArtifact(layout, "scripts/bench.sh")?.name, "bench");
    const script = resolveArtifact(layout, "release-check");
    assert.equal(script.kind, "script");
    assert.match(artifactSummary(script), /verify the release manifest/);
    assert.equal(artifactExists(layout, script), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo artifacts win over machine artifacts with the same name", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-artifacts-prec-"));
  try {
    const layout = fakeLayout(root);
    mkdirSync(join(layout.home, "tools"), { recursive: true });
    mkdirSync(join(layout.repoDir, "tools"), { recursive: true });
    writeFileSync(join(layout.home, "tools", "check.toml"), 'name = "check"\ndescription = "machine"\n', "utf8");
    writeFileSync(join(layout.repoDir, "tools", "check.toml"), 'name = "check"\ndescription = "repo"\n', "utf8");
    assert.equal(resolveArtifact(layout, "check").description, "repo");
    assert.equal(resolveArtifact(layout, "check").origin, "repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
