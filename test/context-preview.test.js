import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("preview groups issue context files by hierarchy depth", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-files-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "task.ts"), "export const task = 1;\n", "utf8");
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = 1;\n", "utf8");
    const ref = (n) => ({ provider: "github", repo: "o/r", number: n });
    const issue = (n, kind, parent, files) => ({
      ref: ref(n),
      title: `${kind} ${n}`,
      body: `<!-- mc:context {"files":${JSON.stringify(files)}} -->\n`,
      state: "open",
      kind,
      labels: [],
      children: [],
      blockedBy: [],
      blocking: [],
      acceptance: [],
      ...(parent ? { parent: parent.ref } : {}),
    });
    const epic = issue(1, "epic", undefined, []);
    const feature = issue(2, "feature", epic, ["src/feature.ts"]);
    const task = issue(3, "task", feature, ["src/task.ts"]);
    const preview = previewContext(fakeLayout(root), [task, feature, epic], task.ref);
    assert.deepEqual(
      preview.sources
        .filter((source) => source.kind === "file")
        .map((source) => [source.ref, source.depth, source.origin]),
      [
        ["src/task.ts", 0, "explicit"],
        ["src/feature.ts", 1, "inherited"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview reports the real plan size instead of a fixed 2 KiB cap", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-plan-"));
  try {
    mkdirSync(join(root, "plans"), { recursive: true });
    const body = `# Plan\n\n${"line\n".repeat(1000)}END\n`;
    writeFileSync(join(root, "plans", "next.md"), body, "utf8");
    const preview = previewContext(fakeLayout(root), [], undefined, "", {});
    const plan = preview.sources.find((source) => source.kind === "plan");
    assert.ok(plan);
    assert.equal(plan.chars, Buffer.byteLength(body, "utf8"));
    assert.ok(plan.chars > 2048);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository knowledge index links deeper notes", () => {
  const text = readFileSync(new URL("../knowledge/index.md", import.meta.url), "utf8");
  assert.match(text, /knowledge\/architecture\.md/);
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
