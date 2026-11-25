/**
 * State memory: the model owns pruning.
 *
 * The state block is bounded by the model's share, but nothing is rewritten or
 * summarised. Over budget it shows ids so one `forget` call can prune, names
 * what it withheld, and never drops the plan or open questions.
 *
 * No network or provider calls. Run with: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStateStore } from "../dist/context/state.js";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "mc-state-"));
  const runDir = join(dir, "run");
  const s = new RunStateStore({ runDir, runId: "r1", repoRoot: dir });
  return { dir, runDir, s };
}

describe("state block budget", () => {
  it("caps a single note and says how to split it", () => {
    const { dir, s } = store();
    try {
      s.note("finding", "x".repeat(3000));
      const block = s.renderBlock(100_000);
      assert.match(block, /truncated at 2000; split into several notes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders plain when it fits, and with ids only when over budget", () => {
    const { dir, s } = store();
    try {
      s.note("finding", "cart.ts:22 renders subtotal, no tax line");
      const fitting = s.renderBlock(100_000);
      assert.doesNotMatch(fitting, /\[f_/);
      const tight = s.renderBlock(120);
      assert.match(tight, /withheld for the state budget/);
      assert.match(tight, /\[f_/);
      assert.match(tight, /action:"forget", ids:\[/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds notes but never the plan or open questions", () => {
    const { dir, s } = store();
    try {
      s.setPlan([
        { text: "move TownMarket to core", done: false },
        { text: "update callers", done: false },
      ]);
      s.note("open", "does the UI read the ledger directly?");
      for (let i = 0; i < 20; i++) s.note("finding", `finding ${i} about a module with a long explanation`);
      const block = s.renderBlock(400);
      assert.match(block, /Plan \(0\/2 steps\)/);
      assert.match(block, /move TownMarket to core/);
      assert.match(block, /Open:/);
      assert.match(block, /withheld for the state budget/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forget removes a note by id", () => {
    const { dir, s } = store();
    try {
      s.note("finding", "one conclusion");
      const id = s.getState().facts[0].id;
      assert.equal(s.forget(id), true);
      assert.equal(s.getState().facts.filter((fact) => fact.status === "active").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
