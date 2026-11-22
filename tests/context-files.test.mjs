/**
 * File bodies in the assembled context.
 *
 * The first prompt must carry the numbered text of the files the run edits.
 * Outlines alone force one inspect per file before work starts, and every
 * prompt in between re-sends the whole context — the dominant cost in long
 * engineer runs. Bodies render with the same `N: ` line numbers inspect
 * returns, so anchors lift straight out of context.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleContext } from "../dist/context/assemble.js";
import { layout } from "../dist/paths.js";

function machineStub() {
  return {
    context: {
      maxChars: 64_000,
      budget: { total: 0.95, overhead: 0.03, symbols: 0.35, map: 0.05, state: 0.15, evidence: 0.1, wholeFile: 0.05 },
    },
    map: { enabled: false, semantic: false, suggestLimit: 10 },
  };
}

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "mc-context-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

describe("assembled context file bodies", () => {
  it("renders an included file body with inspect line numbers", async () => {
    const root = repo({
      "src/a.ts": "export function foo() {\n  return 1;\n}\n",
      ".machine_code/issues/features/todo/x.md": "# X\n\nDo the thing.\n",
    });
    try {
      const l = layout(root);
      const out = await assembleContext({
        layout: l,
        machine: machineStub(),
        include: { files: ["src/a.ts"], issues: [".machine_code/issues/features/todo/x.md"] },
        budgetChars: 64_000,
      });
      const text = out.text ?? "";
      assert.match(text, /<context-block kind="file" source="src\/a\.ts"/);
      assert.match(text, /1: export function foo\(\) \{/);
      assert.match(text, /2:   return 1;/);
      assert.equal((text.match(/kind="file"/g) ?? []).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still records the file as a source when the body renders", async () => {
    const root = repo({ "src/a.ts": "const a = 1;\n" });
    try {
      const out = await assembleContext({
        layout: layout(root),
        machine: machineStub(),
        include: { files: ["src/a.ts"] },
        budgetChars: 64_000,
      });
      const file = out.sources.find((source) => source.kind === "file" && source.ref === "src/a.ts");
      assert.ok(file, "expected a file source");
      assert.ok((file.bytes ?? 0) > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
