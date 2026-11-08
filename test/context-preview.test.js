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
    const preview = previewContext(fakeLayout(root), "", {});
    const skill = preview.sources.find((source) => source.kind === "skill");
    assert.ok(skill, "skill descriptions are part of the assembled context");
    assert.equal(skill.ref, "1 skills");
    assert.equal(skill.note, "reference");
    assert.ok(skill.chars > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview surfaces an attached packet contract", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-packet-"));
  try {
    mkdirSync(join(root, "issues", "packets"), { recursive: true });
    const body = `---\nstatus = "todo"\n---\n# demo\n\n## Deliverable\n\nDo the thing.\n`;
    writeFileSync(join(root, "issues", "packets", "demo.md"), body, "utf8");
    const preview = previewContext(fakeLayout(root), "", { packet: "demo" });
    const packet = preview.sources.find((source) => source.kind === "packet");
    assert.ok(packet, "packet contract is part of the assembled context");
    assert.equal(packet.ref, "demo");
    assert.ok(packet.chars > 0);
    const missing = previewContext(fakeLayout(root), "", { packet: "nope" });
    assert.ok(missing.warnings.some((w) => /packet nope is missing/.test(w)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview reports the real issue size instead of a fixed 2 KiB cap", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-preview-issue-"));
  try {
    mkdirSync(join(root, "issues", "features", "todo"), { recursive: true });
    const body = `# Issue\n\n${"line\n".repeat(1000)}END\n`;
    writeFileSync(join(root, "issues", "features", "todo", "big.md"), body, "utf8");
    const preview = previewContext(fakeLayout(root), "", { agent: "engineer", issues: ["issues/features/todo/big.md"] });
    const issue = preview.sources.find((source) => source.kind === "issue" && source.origin === "explicit");
    assert.ok(issue);
    assert.equal(issue.chars, Buffer.byteLength(body, "utf8"));
    assert.ok(issue.chars > 2048);
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
