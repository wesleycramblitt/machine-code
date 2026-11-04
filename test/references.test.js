/**
 * Central reference store: indexed lookup, exact anchor reads, writes, and
 * index regeneration against the OpenCode-compatible bundle layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findReferences,
  readReference,
  referenceStore,
  reindexReferences,
  writeReference,
} from "../dist/references/store.js";
import { referenceCommands } from "../dist/commands/reference.js";

function tempLayout() {
  const root = mkdtempSync(join(tmpdir(), "mc-refs-"));
  return {
    root,
    layout: {
      home: join(root, "home"),
      machineConfig: "",
      curation: "",
      catalogueFile: "",
      repoRoot: join(root, "repo"),
      repoDir: join(root, "repo", ".machine_code"),
      localDir: join(root, "repo", ".machine_code", "local"),
      policyFile: "",
      runsDir: join(root, "repo", ".machine_code", "local", "runs"),
    },
  };
}

function writeBundle(layout) {
  const dir = join(referenceStore(layout), "demo", "1");
  mkdirSync(join(dir, "content"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.yaml"),
    'id: demo/1\nproduct: Demo\nversion: "1"\nstatus: current\nretrieved: "2026-01-01"\n',
    "utf8",
  );
  writeFileSync(join(dir, "index.md"), "# Demo 1\n\nTopic map.\n", "utf8");
  writeFileSync(
    join(dir, "content", "alpha.md"),
    "---\nproduct: Demo\nversion: \"1\"\ntopics: [alpha]\nsymbols: [foo]\ntokens: 20\n---\n\n## Alpha {#alpha}\n\nAlpha body.\n\n## Beta {#beta}\n\nBeta body.\n",
    "utf8",
  );
}

test("reference store writes, indexes, finds, and reads exact anchors", (t) => {
  const { root, layout } = tempLayout();
  try {
    const written = writeReference(
      layout,
      "demo/1/content/alpha.md",
      "---\nproduct: Demo\nversion: \"1\"\ntopics: [alpha]\nsymbols: [foo]\ntokens: 20\n---\n\n## Alpha {#alpha}\n\nAlpha body.\n\n## Beta {#beta}\n\nBeta body.\n",
    );
    assert.equal(written.ok, true);
    writeBundle(layout);

    const py = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" });
    if (py.status !== 0) {
      t.skip("PyYAML is not installed");
      return;
    }
    const indexed = reindexReferences(layout);
    assert.doesNotMatch(indexed, /failed/i);
    assert.ok(existsSync(join(referenceStore(layout), "index.md")));
    assert.ok(existsSync(join(referenceStore(layout), "topics.yaml")));
    assert.ok(existsSync(join(referenceStore(layout), "demo", "1", "api-index.md")));

    const found = findReferences(layout, "alpha");
    assert.match(found, /demo\/1\/content\/alpha\.md#alpha/);
    const bySymbol = findReferences(layout, "foo");
    assert.match(bySymbol, /demo\/1\/api-index\.md/);

    const read = readReference(layout, "demo/1/content/alpha.md#alpha");
    assert.equal(read.ok, true);
    assert.match(read.text, /Alpha body/);
    assert.doesNotMatch(read.text, /Beta body/);

    const raw = readReference(layout, "demo/1/raw/source.html");
    assert.equal(raw.ok, false);
    assert.match(raw.error, /raw/);

    const commands = referenceCommands(layout);
    for (const name of ["reference:find", "reference:read", "reference:write", "reference:reindex"]) {
      assert.ok(commands.has(name), `${name} is registered`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
