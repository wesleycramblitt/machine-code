import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assembleContext } from "../dist/context/assemble.js";

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

function machine() {
  return {
    priceCaps: {},
    vetoes: [],
    notify: {},
    git: {},
    agents: {},
    issues: { provider: "github", policy: "optional", cacheTtlSeconds: 30 },
    context: { maxChars: 24_000, planFile: undefined, knowledgeIndex: undefined },
  };
}

test("composer includes knowledge files that no issue references", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-context-include-"));
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "knowledge", "extra.md"), "# Extra\nIncluded by the composer.", "utf8");
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      include: { knowledge: ["knowledge/extra.md", "knowledge/missing.md"] },
    });
    assert.match(bundle.text, /Included by the composer/);
    const source = bundle.sources.find((item) => item.kind === "knowledge" && item.ref === "knowledge/extra.md");
    assert.ok(source);
    assert.equal(source.origin, "explicit");
    assert.ok(bundle.sources.some((item) => item.warning?.includes("included knowledge")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("individual skill exclusions remove one description", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-context-skill-exclude-"));
  try {
    for (const [name, description] of [
      ["reference", "research and curation"],
      ["requirements", "clarify ambiguous work"],
    ]) {
      mkdirSync(join(root, ".machine_code", "skills", name), { recursive: true });
      writeFileSync(
        join(root, ".machine_code", "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
        "utf8",
      );
    }
    const bundle = await assembleContext({
      layout: fakeLayout(root),
      machine: machine(),
      exclude: { items: ["skill:reference"] },
    });
    assert.doesNotMatch(bundle.text, /reference: research and curation/);
    assert.match(bundle.text, /requirements: clarify ambiguous work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
