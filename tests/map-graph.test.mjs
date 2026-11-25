/**
 * Import-graph queries on `core:map`.
 *
 * A refactor question ("who imports this?", "what breaks if I move it?") must
 * be a lookup against the cached map, not a model turn plus evidence. `refs`
 * answers textual references; `imports`/`dependents` walk resolved import edges.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMapCommand } from "../dist/commands/map.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mc-mapgraph-"));
  const files = {
    "src/a.ts": 'export const A = "a";\n',
    "src/b.ts": 'import { A } from "./a.js";\nexport const B = A + "b";\n',
    "src/c.ts": 'import { B } from "./b.js";\nexport const C = B + "c";\n',
    "src/d.ts": 'import { C } from "./c.js";\nexport const D = C;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

describe("core:map graph queries", () => {
  it("lists direct dependents and one transitive hop", async () => {
    const root = fixture();
    try {
      const out = await runMapCommand({ action: "dependents", path: "src/a.ts" }, root);
      assert.equal(out.isError, false);
      assert.match(out.text, /dependents of src\/a\.ts \(direct 1\)/);
      assert.match(out.text, /src\/b\.ts/);
      assert.match(out.text, /transitive/);
      assert.match(out.text, /src\/c\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists forward imports", async () => {
    const root = fixture();
    try {
      const out = await runMapCommand({ action: "imports", path: "src/c.ts" }, root);
      assert.equal(out.isError, false);
      assert.match(out.text, /imports of src\/c\.ts \(1\)/);
      assert.match(out.text, /src\/b\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds textual references to a symbol", async () => {
    const root = fixture();
    try {
      const out = await runMapCommand({ action: "refs", query: "A" }, root);
      assert.equal(out.isError, false);
      assert.match(out.text, /refs to A/);
      assert.match(out.text, /src\/a\.ts:1/);
      assert.match(out.text, /src\/b\.ts:1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("errors clearly on an unknown path and a missing query", async () => {
    const root = fixture();
    try {
      const missing = await runMapCommand({ action: "dependents", path: "src/nope.ts" }, root);
      assert.equal(missing.isError, true);
      assert.match(missing.text, /not in the map/);
      const noQuery = await runMapCommand({ action: "refs" }, root);
      assert.equal(noQuery.isError, true);
      assert.match(noQuery.text, /requires query/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
