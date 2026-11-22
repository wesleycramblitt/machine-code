/**
 * Ingest-root scoping tests.
 *
 * The reference agent stages PDFs/downloads under machine ingest roots
 * (default `<home>/ingest/`). Path resolution must never escape those roots,
 * and a missing machine config falls back to the default instead of throwing.
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIngestPath, ingestRoots } from "../dist/commands/reference.js";

function fakeLayout(home) {
  return { home };
}

describe("ingestRoots", () => {
  it("defaults to <home>/ingest without a machine config", () => {
    const home = mkdtempSync(join(tmpdir(), "mc-ingest-"));
    try {
      assert.deepEqual(ingestRoots(fakeLayout(home)), [join(home, "ingest")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveIngestPath", () => {
  it("resolves staged files under the default root", () => {
    const home = mkdtempSync(join(tmpdir(), "mc-ingest-"));
    try {
      mkdirSync(join(home, "ingest"), { recursive: true });
      writeFileSync(join(home, "ingest", "paper.pdf"), "%PDF-stub", "utf8");
      const out = resolveIngestPath(fakeLayout(home), "paper.pdf");
      assert.equal(out.ok, true);
      assert.equal(out.abs, join(home, "ingest", "paper.pdf"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects escapes and absolute outsiders", () => {
    const home = mkdtempSync(join(tmpdir(), "mc-ingest-"));
    try {
      for (const evil of ["../outside.pdf", "../../etc/passwd", "/tmp/evil.pdf", ""]) {
        const out = resolveIngestPath(fakeLayout(home), evil);
        assert.equal(out.ok, false, evil);
        assert.match(out.error, /escapes|empty/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
