/**
 * reference:verify contract tests.
 *
 * A reference run must log at least one store write, every touched bundle
 * must carry a manifest, content files need front-matter plus a stable
 * anchor, and the index must be drift-free. Validation is pure
 * (store root + rels) so it runs without a repo, network, or provider.
 * Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateReferenceFiles, bundleOf } from "../dist/commands/reference-verify.js";

function makeStore() {
  const store = mkdtempSync(join(tmpdir(), "mc-refstore-"));
  const bundle = join(store, "glsl", "4.60.8");
  mkdirSync(join(bundle, "content"), { recursive: true });
  writeFileSync(join(bundle, "manifest.yaml"), "product: glsl\nversion: 4.60.8\n", "utf8");
  writeFileSync(
    join(bundle, "index.md"),
    "# GLSL\n\n- [Common](content/common.md#common)\n",
    "utf8",
  );
  writeFileSync(
    join(bundle, "content", "common.md"),
    '---\ntopics: [common]\nsymbols: []\ntokens: 100\n---\n\n# Common {#common}\n\nBody.\n',
    "utf8",
  );
  return store;
}

describe("bundleOf", () => {
  it("resolves versioned and flat bundle keys", () => {
    assert.equal(bundleOf("glsl/4.60.8/content/a.md"), "glsl/4.60.8");
    assert.equal(bundleOf("mc-26-3-ui-ux/index.md"), "mc-26-3-ui-ux");
    assert.equal(bundleOf(""), null);
    assert.equal(bundleOf("../escape.md"), null);
  });
});

describe("validateReferenceFiles", () => {
  it("passes a well-formed bundle write", () => {
    const store = makeStore();
    try {
      const out = validateReferenceFiles(store, [
        "glsl/4.60.8/manifest.yaml",
        "glsl/4.60.8/content/common.md",
      ]);
      assert.equal(out.ok, true);
      assert.deepEqual(out.errors, []);
      assert.deepEqual(out.bundles, ["glsl/4.60.8"]);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("fails content without front-matter or anchors", () => {
    const store = makeStore();
    try {
      writeFileSync(join(store, "glsl", "4.60.8", "content", "bare.md"), "# Bare\n\nNo matter.\n", "utf8");
      const out = validateReferenceFiles(store, ["glsl/4.60.8/content/bare.md"]);
      assert.equal(out.ok, false);
      assert.ok(out.errors.some((e) => e.includes("front-matter")));
      assert.ok(out.errors.some((e) => e.includes("anchor")));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("fails bundles without a manifest and missing files", () => {
    const store = makeStore();
    try {
      mkdirSync(join(store, "orphan", "1", "content"), { recursive: true });
      writeFileSync(
        join(store, "orphan", "1", "content", "a.md"),
        '---\ntopics: []\nsymbols: []\ntokens: 1\n---\n\n# A {#a}\n',
        "utf8",
      );
      const out = validateReferenceFiles(store, ["orphan/1/content/a.md", "ghost/2/content/x.md"]);
      assert.equal(out.ok, false);
      assert.ok(out.errors.some((e) => e.includes("manifest.yaml")));
      assert.ok(out.errors.some((e) => e.includes("not found")));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("rejects escapes outside the store", () => {
    const store = makeStore();
    try {
      const out = validateReferenceFiles(store, ["../outside.md"]);
      assert.equal(out.ok, false);
      assert.ok(out.errors.some((e) => e.includes("escapes")));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});
