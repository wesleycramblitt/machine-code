/**
 * Reference read/search tests. The 20261118-131813-3mvo run showed an agent
 * failing ~20 consecutive reference:read calls: api-index citations are
 * bundle-relative (content/...) while read requires store-relative paths,
 * and there was no content search, paging, outline, or directory listing.
 *
 * Uses a temp fixture store, never ~/.machine_code. Run with: npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  findReferences,
  matchReferenceSuffix,
  readReference,
  resolveReferenceBundle,
  searchReferenceFiles,
} from "../dist/references/store.js";
import { runCommand } from "../dist/commands/registry.js";
import { referenceCommands } from "../dist/commands/reference.js";

const rgAvailable = (() => {
  try {
    return spawnSync("rg", ["--version"], { timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
})();

let dir = "";
let layout = null;

function write(rel, text) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-references-"));
  layout = { home: join(dir, "home"), repoRoot: join(dir, "proj") };
  const store = join(layout.home, "references");
  write(
    "home/references/acme-widgets/2.0/manifest.yaml",
    "product: acme-widgets\nversion: '2.0'\nstatus: current\n",
  );
  write(
    "home/references/acme-widgets/2.0/index.md",
    "# Acme widgets\n\n| Topics | `content/guide.md` |\n",
  );
  write(
    "home/references/acme-widgets/2.0/api-index.md",
    "# API index\n\n| symbol | location | status |\n|---|---|---|\n| Widget | `content/guide.md#widget` | current |\n",
  );
  write(
    "home/references/acme-widgets/2.0/content/guide.md",
    "# Guide\n\n## Widget {#widget}\n\nA widget has a sprocket.\n\n## Sprocket {#sprocket}\n\nRound and round.\n".repeat(4),
  );
  write(
    "home/references/acme-widgets/2.0/content/notes.md",
    "# Notes\n\nNothing about widgets here.\n",
  );
  write("home/references/acme-widgets/2.0/src/widget.java", "class Widget {\n  Sprocket sprocket;\n}\n");
  write("home/references/acme-widgets/2.0/src/other.txt", "just a data file\n");
  write("home/references/acme-widgets/2.0/raw/archive.md", "archival, never read\n");
  write("home/references/acme-widgets/2.0/.git/config", "[core]\n");
  write("home/references/other-lib/1.0/index.md", "# Other\n");
  write("home/references/other-lib/1.0/content/guide.md", "# Guide\n\n## Widget {#widget}\n\nAnother widget.\n");
  write("home/references/multi/1.0/index.md", "# Multi 1\n");
  write("home/references/multi/2.0/index.md", "# Multi 2\n");
  assert.ok(existsSync(store));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("resolveReferenceBundle", () => {
  it("resolves product/version and bare product (single version)", () => {
    const store = join(layout.home, "references");
    assert.deepEqual(resolveReferenceBundle(store, "acme-widgets/2.0").rel, "acme-widgets/2.0");
    assert.deepEqual(resolveReferenceBundle(store, "acme-widgets").rel, "acme-widgets/2.0");
  });
  it("rejects unknown products and versions", () => {
    const store = join(layout.home, "references");
    assert.ok("error" in resolveReferenceBundle(store, "nope"));
    assert.ok("error" in resolveReferenceBundle(store, "acme-widgets/9.9"));
  });
  it("names versions when a bare product is ambiguous", () => {
    const store = join(layout.home, "references");
    const r = resolveReferenceBundle(store, "multi");
    assert.ok("error" in r);
    assert.match(r.error, /multi\/1\.0.*multi\/2\.0|multi\/2\.0.*multi\/1\.0/);
  });
});

describe("bundle-relative citations", () => {
  it("auto-resolves a unique content/… suffix", () => {
    const r = readReference(layout, "content/notes.md");
    assert.ok(r.ok, r.error);
    assert.match(r.text, /Nothing about widgets/);
  });
  it("reports ambiguity instead of guessing", () => {
    const r = readReference(layout, "content/guide.md");
    assert.ok(!r.ok);
    assert.match(r.error, /Did you mean/);
  });
  it("refuses raw/ and .git/", () => {
    assert.match(readReference(layout, "acme-widgets/2.0/raw/archive.md").error, /archival/);
    assert.match(readReference(layout, "acme-widgets/2.0/.git/config").error, /\.git/);
  });
});

describe("readReference paging and outline", () => {
  const path = "acme-widgets/2.0/content/guide.md";
  it("pages by lines", () => {
    const r = readReference(layout, path, 12 * 1024, layout.repoRoot, { offset: 3, lines: 2 });
    assert.ok(r.ok);
    assert.match(r.text, /<lines 3-4 of \d+>/);
  });
  it("outlines headings with anchors", () => {
    const r = readReference(layout, path, 12 * 1024, layout.repoRoot, { outline: true });
    assert.ok(r.ok);
    assert.match(r.text, /Widget -> #widget/);
  });
  it("lists directories, skipping .git and raw", () => {
    const r = readReference(layout, "acme-widgets/2.0/src");
    assert.ok(r.ok, r.error);
    assert.match(r.text, /widget\.java/);
    const top = readReference(layout, "acme-widgets/2.0/content");
    assert.ok(top.ok, top.error);
    assert.match(top.text, /guide\.md/);
    assert.doesNotMatch(top.text, /\.git/);
    assert.doesNotMatch(top.text, /(^|\n)raw\//);
  });
});

describe("tiered find", () => {
  it("scopes the index tier to one bundle", () => {
    const scoped = findReferences(layout, "guide", 20, layout.repoRoot, { bundle: "acme-widgets" });
    assert.match(scoped, /acme-widgets/);
    assert.doesNotMatch(scoped, /other-lib/);
  });
  it("requires bundle: for content/code tiers", () => {
    assert.match(
      findReferences(layout, "sprocket", 20, layout.repoRoot, { content: true }),
      /needs bundle:/,
    );
  });
  it("content tier searches bodies, code tier searches the repo", { skip: !rgAvailable }, () => {
    const content = findReferences(layout, "sprocket", 20, layout.repoRoot, {
      bundle: "acme-widgets",
      content: true,
      index: false,
    });
    assert.match(content, /acme-widgets\/2\.0\/content\/guide\.md:\d+:/);
    const code = findReferences(layout, "Sprocket", 20, layout.repoRoot, {
      bundle: "acme-widgets/2.0",
      code: true,
      index: false,
    });
    assert.match(code, /acme-widgets\/2\.0\/src\/widget\.java:\d+:/);
    assert.doesNotMatch(code, /api-index/);
    assert.doesNotMatch(code, /raw\//);
    assert.doesNotMatch(code, /\.git\//);
  });
  it("regex tier works", { skip: !rgAvailable }, () => {
    const out = searchReferenceFiles(join(layout.home, "references"), "Spr[aeiou]cket", {
      bundle: "acme-widgets",
      code: true,
      regex: true,
    });
    assert.match(out, /widget\.java/);
  });
});

describe("reference param redirects", () => {
  const ctx = () => ({ root: join(dir, "proj"), commands: referenceCommands(layout) });
  it("read with find params redirects to find", async () => {
    const r = await runCommand("reference:read", { bundle: "acme-widgets", content: true }, ctx());
    assert.ok(r.isError);
    assert.match(r.text, /belong[s]? on reference:find/);
    assert.match(r.text, /as path=/);
  });
  it("find with read params redirects to read", async () => {
    const r = await runCommand("reference:find", { query: "widget", offset: 3 }, ctx());
    assert.ok(r.isError);
    assert.match(r.text, /belong[s]? on reference:read/);
  });
  it("unrelated unknown params get no redirect", async () => {
    const r = await runCommand("reference:find", { query: "widget", depth: 2 }, ctx());
    assert.ok(r.isError);
    assert.doesNotMatch(r.text, /belong on/);
  });
  it("tier shorthand maps to content/code tiers", async () => {
    const ctx = () => ({ root: join(dir, "proj"), commands: referenceCommands(layout) });
    const content = await runCommand("reference:find", { query: "sprocket", bundle: "acme-widgets", tier: "content" }, ctx());
    assert.ok(!content.isError);
    assert.match(content.text, /content\/guide\.md:\d+:/);
    const bad = await runCommand("reference:find", { query: "sprocket", bundle: "acme-widgets", tier: "deep" }, ctx());
    assert.ok(bad.isError);
    assert.match(bad.text, /unknown tier/);
  });
});
