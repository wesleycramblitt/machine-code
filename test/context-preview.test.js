import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverKnowledgeFiles, previewContext } from "../dist/context/preview.js";

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

test("preview includes always-visible skill descriptions", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-skills-"));
  try {
    mkdirSync(join(root, ".machine_code", "skills", "reference"), { recursive: true });
    writeFileSync(
      join(root, ".machine_code", "skills", "reference", "SKILL.md"),
      "---\nname: reference\ndescription: research and curation\n---\n# Reference\n",
      "utf8",
    );
    const preview = previewContext(fakeLayout(root), [], undefined, "", {});
    const skill = preview.sources.find((source) => source.kind === "skill");
    assert.ok(skill, "skill descriptions are part of the assembled context");
    assert.equal(skill.ref, "1 skills");
    assert.equal(skill.note, "reference");
    assert.ok(skill.chars > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge discovery finds markdown files without listing the world", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-knowledge-"));
  try {
    mkdirSync(join(root, "knowledge", "nested"), { recursive: true });
    writeFileSync(join(root, "knowledge", "index.md"), "# Index\n", "utf8");
    writeFileSync(join(root, "knowledge", "nested", "note.md"), "# Note\n", "utf8");
    writeFileSync(join(root, "knowledge", "image.png"), "not markdown", "utf8");
    assert.deepEqual(discoverKnowledgeFiles(fakeLayout(root)), ["knowledge/index.md", "knowledge/nested/note.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
