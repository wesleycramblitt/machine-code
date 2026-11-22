/**
 * Acceptance gates must prove the work they gate.
 *
 * A feature/bug carrying the curation gate would "pass" without code existing
 * (observed: the architect filing `acceptance: issue-curation:verify` on
 * features). The plan layer refuses it on create and update; the curation
 * gate re-checks issues created by other paths.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeIssue, updateIssueContents, gateErrors } from "../dist/plan/issues.js";
import { layout } from "../dist/paths.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "mc-gate-accept-"));
  return { root, l: layout(root) };
}

describe("gateErrors", () => {
  it("rejects curation gates on features and bugs", () => {
    for (const kind of ["features", "bugs"]) {
      const errors = gateErrors(kind, ["issue-curation:verify"]);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /proves a curation run/);
      assert.equal(gateErrors(kind, ["reference:verify"]).length, 1);
    }
  });

  it("allows build gates and leaves ideas/references alone", () => {
    assert.deepEqual(gateErrors("features", ["script:build", "script:test"]), []);
    assert.deepEqual(gateErrors("ideas", ["issue-curation:verify"]), []);
    assert.deepEqual(gateErrors("references", ["reference:verify"]), []);
  });
});

describe("writeIssue", () => {
  it("refuses a feature whose acceptance is the curation gate", () => {
    const { root, l } = repo();
    try {
      assert.throws(
        () =>
          writeIssue(l, {
            kind: "features",
            slug: "bad-gate",
            prompt: "x".repeat(240),
            files: ["src/a.ts"],
            acceptance: ["issue-curation:verify"],
          }),
        /proves a curation run, not a build/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still writes a normal feature", () => {
    const { root, l } = repo();
    try {
      const issue = writeIssue(l, {
        kind: "features",
        slug: "good-gate",
        prompt: "x".repeat(240),
        files: ["src/a.ts"],
        acceptance: ["script:build"],
      });
      assert.deepEqual(issue.acceptance, ["script:build"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("updateIssueContents", () => {
  it("refuses to move a curation gate onto an existing feature", () => {
    const { root, l } = repo();
    try {
      writeIssue(l, { kind: "features", slug: "existing", prompt: "x".repeat(240), files: ["src/a.ts"], acceptance: ["script:build"] });
      assert.throws(
        () => updateIssueContents(l, "existing", { prompt: "y".repeat(240), acceptance: ["issue-curation:verify"] }),
        /proves a curation run, not a build/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
